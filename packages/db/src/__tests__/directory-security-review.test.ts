/**
 * security-review 2026-10 — directory query fixes, run against a
 * capturing pg-proxy client (no Postgres needed; the SQL is what we check).
 *   - HUB-001: the directory config reads/writes the REAL settings
 *     singleton and exposes the per-install directory id; a write that
 *     matches no row throws instead of silently succeeding.
 *   - HUB-002: re-registering with changed display fields resets
 *     isListed/isVerified inside the upsert statement.
 *   - HUB-003: freshness predicate, moderator status, and the admin
 *     listing that includes every row.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import {
  DEFAULT_INSTANCE_ID,
  DirectoryConfigNotInitializedError,
  getDirectoryVerificationConfig,
  setDirectoryVerificationConfig,
} from '../queries/instanceSettings.js';
import {
  HEARTBEAT_STALE_MS,
  isRegistryInstancePubliclyVisible,
  isRegistryInstanceStale,
  listRegistryInstancesForModeration,
  registryInstanceStatus,
  upsertRegistryInstance,
} from '../queries/registryInstances.js';

interface Call {
  sql: string;
  params: unknown[];
  method: string;
}

/**
 * A drizzle client whose every query is recorded; `answer` returns the
 * driver rows (arrays of column values, in select order).
 */
function capturingDb(answer: (call: Call) => unknown[][] = () => []) {
  const calls: Call[] = [];
  const db = drizzle(async (sql, params, method) => {
    const call = { sql, params, method };
    calls.push(call);
    return { rows: answer(call) };
  });
  return { db: db as never, calls };
}

describe('directory verification config — security-review HUB-001', () => {
  it('reads the settings singleton row and returns its directory id', async () => {
    const { db, calls } = capturingDb((call) =>
      call.params.includes(DEFAULT_INSTANCE_ID)
        ? [['5f0c7a52-2d0e-4b8e-9a43-0c6f2f6f1d11', 'https://chat.example.com', 'pk', true, 'proof']]
        : []
    );
    const config = await getDirectoryVerificationConfig(db);
    expect(DEFAULT_INSTANCE_ID).toBe('self-host');
    expect(calls[0]!.sql).toContain('"directory_instance_id"');
    expect(calls[0]!.params).toContain('self-host');
    expect(calls[0]!.params).not.toContain('default');
    expect(config).toEqual({
      directoryInstanceId: '5f0c7a52-2d0e-4b8e-9a43-0c6f2f6f1d11',
      domain: 'https://chat.example.com',
      publicKey: 'pk',
      isPublicDirectoryEnabled: true,
      directoryProof: 'proof',
    });
  });

  it('writes the singleton row and returns the directory id the proof must sign', async () => {
    const { db, calls } = capturingDb(() => [['5f0c7a52-2d0e-4b8e-9a43-0c6f2f6f1d11']]);
    const saved = await setDirectoryVerificationConfig(db, {
      domain: 'https://chat.example.com',
      publicKey: 'pk',
      directoryProof: 'proof',
      isPublicDirectoryEnabled: true,
    });
    expect(saved).toEqual({ directoryInstanceId: '5f0c7a52-2d0e-4b8e-9a43-0c6f2f6f1d11' });
    expect(calls[0]!.sql).toMatch(/^update "instance_settings"/);
    expect(calls[0]!.sql).toContain('returning "directory_instance_id"');
    expect(calls[0]!.params).toContain('self-host');
    expect(calls[0]!.params).not.toContain('default');
  });

  it('throws when no settings row matched (it used to report success)', async () => {
    const { db } = capturingDb(() => []);
    await expect(
      setDirectoryVerificationConfig(db, {
        domain: 'https://chat.example.com',
        publicKey: 'pk',
        directoryProof: 'proof',
        isPublicDirectoryEnabled: true,
      })
    ).rejects.toBeInstanceOf(DirectoryConfigNotInitializedError);
  });
});

describe('upsertRegistryInstance — security-review HUB-002', () => {
  it('sends a changed listing back to review inside the conflict update', async () => {
    const owner = '00000000-0000-0000-0000-000000000001';
    const { db, calls } = capturingDb((call) => {
      if (call.sql.startsWith('select')) return [[owner]];
      // The upsert's RETURNING row (every column, table order).
      return [[
        'row-1', 'inst', 'Renamed', 'https://chat.example.com', null, null, [], [], [], 'pk', owner,
        false, false, false, false, 0, 0, null, null, null, new Date().toISOString(),
      ]];
    });
    const row = await upsertRegistryInstance(db, {
      instanceId: 'inst',
      name: 'Renamed',
      domain: 'https://chat.example.com',
      publicKey: 'pk',
      actorUserId: owner,
    });
    expect(row.isListed).toBe(false);
    const upsert = calls.find((c) => c.sql.startsWith('insert'))!.sql;
    const displayCompare =
      '("registry_instances"."name", "registry_instances"."description", "registry_instances"."region", "registry_instances"."languages", "registry_instances"."tags", "registry_instances"."features") IS DISTINCT FROM (excluded.name, excluded.description, excluded.region, excluded.languages, excluded.tags, excluded.features)';
    expect(upsert).toContain(`"is_listed" = CASE WHEN ${displayCompare} THEN false ELSE "registry_instances"."is_listed" END`);
    expect(upsert).toContain(`"is_verified" = CASE WHEN ${displayCompare} THEN false ELSE "registry_instances"."is_verified" END`);
    // Domain and key stay out of the update (change-domain / rotate-key own them).
    const updateSet = upsert.slice(upsert.indexOf('do update set'));
    expect(updateSet).not.toMatch(/"domain" =|"public_key" =/);
    // Still owner-gated.
    expect(updateSet).toContain('where "registry_instances"."owner_user_id" = excluded.owner_user_id');
  });
});

describe('directory freshness and moderation — security-review HUB-003', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const fresh = new Date(now - 60_000);
  const stale = new Date(now - HEARTBEAT_STALE_MS - 1);

  it('counts a missing, unparseable or old heartbeat as stale', () => {
    expect(isRegistryInstanceStale(null, now)).toBe(true);
    expect(isRegistryInstanceStale(undefined, now)).toBe(true);
    expect(isRegistryInstanceStale('not a date', now)).toBe(true);
    expect(isRegistryInstanceStale(stale, now)).toBe(true);
    expect(isRegistryInstanceStale(fresh, now)).toBe(false);
    expect(isRegistryInstanceStale(fresh.toISOString(), now)).toBe(false);
  });

  it('shows an entry publicly only when listed, not blocked and fresh', () => {
    expect(isRegistryInstancePubliclyVisible({ isListed: true, isBlocked: false, lastHeartbeatAt: fresh }, now)).toBe(true);
    expect(isRegistryInstancePubliclyVisible({ isListed: true, isBlocked: false, lastHeartbeatAt: stale }, now)).toBe(false);
    expect(isRegistryInstancePubliclyVisible({ isListed: true, isBlocked: false, lastHeartbeatAt: null }, now)).toBe(false);
    expect(isRegistryInstancePubliclyVisible({ isListed: false, isBlocked: false, lastHeartbeatAt: fresh }, now)).toBe(false);
    expect(isRegistryInstancePubliclyVisible({ isListed: true, isBlocked: true, lastHeartbeatAt: fresh }, now)).toBe(false);
  });

  it('gives moderators one status per entry, most important first', () => {
    expect(registryInstanceStatus({ isListed: false, isBlocked: true, lastHeartbeatAt: fresh }, now)).toBe('blocked');
    expect(registryInstanceStatus({ isListed: false, isBlocked: false, lastHeartbeatAt: stale }, now)).toBe('pending');
    expect(registryInstanceStatus({ isListed: true, isBlocked: false, lastHeartbeatAt: stale }, now)).toBe('stale');
    expect(registryInstanceStatus({ isListed: true, isBlocked: false, lastHeartbeatAt: fresh }, now)).toBe('listed');
  });

  it('the moderation listing filters nothing out', async () => {
    const { db, calls } = capturingDb(() => []);
    await listRegistryInstancesForModeration(db, { limit: 200 });
    expect(calls[0]!.sql).toMatch(/^select .* from "registry_instances" order by "registry_instances"."created_at" desc limit \$1$/);
    expect(calls[0]!.sql).not.toContain('where');
    expect(calls[0]!.params).toEqual([200]);
  });
});
