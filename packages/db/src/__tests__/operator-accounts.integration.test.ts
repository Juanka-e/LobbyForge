/**
 * Account recovery by the server operator (`lfctl user …`) against real
 * Postgres:
 *   - resetUserPasswordAsOperator sets the hash (also for an account that
 *     had none), drops the live email change/reset challenges but not a
 *     verification, and files an audit entry with no actor user
 *     (`metadata.actor: "operator"`) under the owner's oldest live server,
 *     all in one transaction; unknown, deleted and guest accounts change
 *     nothing;
 *   - listInstanceAdminAccounts names the instance owner first, then the
 *     owners of live servers, and leaves deleted accounts out.
 *
 * Uses its own users and instance id, never the 'self-host' singleton.
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch Postgres.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb } from '../client.js';
import {
  listInstanceAdminAccounts,
  OPERATOR_PASSWORD_RESET_ACTION,
  resetUserPasswordAsOperator,
} from '../queries/operatorAccounts.js';

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)('operator account recovery (integration)', () => {
  const sql = DB_URL ? postgres(DB_URL, { max: 4 }) : (null as unknown as postgres.Sql);
  const db = DB_URL ? createDb(DB_URL) : (null as unknown as ReturnType<typeof createDb>);
  const run = randomUUID().slice(0, 8);
  const instanceId = `operator-test-${run}`;
  const userIds: string[] = [];
  const serverIds: string[] = [];

  async function createUser(opts: { email?: string | null; guest?: boolean; deleted?: boolean; passwordHash?: string | null; name?: string } = {}) {
    const email = opts.email === undefined ? `op-${randomUUID()}@example.test` : opts.email;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (email, display_name, password_hash, is_guest, deleted_at)
      VALUES (${email}, ${opts.name ?? 'Operator Test'}, ${opts.passwordHash === undefined ? 'scrypt$old' : opts.passwordHash},
              ${opts.guest ?? false}, ${opts.deleted ? new Date() : null})
      RETURNING id`;
    userIds.push(row!.id);
    return { id: row!.id, email };
  }

  async function createServer(ownerId: string, name: string, opts: { createdAt?: Date; deleted?: boolean } = {}) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO servers (name, owner_user_id, created_at, deleted_at)
      VALUES (${name}, ${ownerId}, ${opts.createdAt ?? new Date()}, ${opts.deleted ? new Date() : null})
      RETURNING id`;
    serverIds.push(row!.id);
    return row!.id;
  }

  async function addToken(userId: string, purpose: 'verify' | 'change' | 'reset', email: string) {
    await sql`
      INSERT INTO email_tokens (user_id, purpose, target_email, token_hash, code_hash, expires_at, code_expires_at)
      VALUES (${userId}, ${purpose}, ${email}, ${randomBytes(32)}, ${randomBytes(32)},
              now() + interval '1 hour', now() + interval '15 minutes')`;
  }

  afterAll(async () => {
    // Servers first (they reference their owners; their audit rows cascade).
    if (serverIds.length) await sql`DELETE FROM servers WHERE id IN ${sql(serverIds)}`;
    await sql`DELETE FROM audit_logs WHERE target_id IN ${sql(userIds.length ? userIds : ['none'])} AND action = ${OPERATOR_PASSWORD_RESET_ACTION}`;
    await sql`DELETE FROM instance_settings WHERE instance_id = ${instanceId}`;
    if (userIds.length) await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    await sql.end();
  });

  it('sets the password, drops change/reset challenges, keeps verify, and audits under the oldest live server', async () => {
    const owner = await createUser({ name: 'Owner' });
    await sql`INSERT INTO instance_settings (instance_id, instance_name, owner_user_id) VALUES (${instanceId}, 'Operator test', ${owner.id})`;
    await createServer(owner.id, 'Deleted first', { createdAt: new Date('2026-01-01T00:00:00Z'), deleted: true });
    const home = await createServer(owner.id, 'Home', { createdAt: new Date('2026-01-02T00:00:00Z') });
    await createServer(owner.id, 'Later', { createdAt: new Date('2026-01-03T00:00:00Z') });
    for (const purpose of ['verify', 'change', 'reset'] as const) await addToken(owner.id, purpose, owner.email!);

    const result = await resetUserPasswordAsOperator(
      db,
      { email: `  ${owner.email!.toUpperCase()} `, newPasswordHash: 'scrypt$new' },
      instanceId
    );
    expect(result).toEqual({ ok: true, userId: owner.id, email: owner.email, displayName: 'Owner' });

    const [user] = await sql<{ password_hash: string; email_verified_at: Date | null }[]>`
      SELECT password_hash, email_verified_at FROM users WHERE id = ${owner.id}`;
    expect(user!.password_hash).toBe('scrypt$new');
    // The operator proved nothing about the mailbox.
    expect(user!.email_verified_at).toBeNull();

    const live = await sql<{ purpose: string }[]>`
      SELECT purpose FROM email_tokens WHERE user_id = ${owner.id} AND consumed_at IS NULL`;
    expect(live.map((row) => row.purpose)).toEqual(['verify']);

    const audit = await sql<{ server_id: string | null; actor_user_id: string | null; target_type: string; metadata: unknown }[]>`
      SELECT server_id, actor_user_id, target_type, metadata FROM audit_logs
      WHERE action = ${OPERATOR_PASSWORD_RESET_ACTION} AND target_id = ${owner.id}`;
    expect(audit).toEqual([{ server_id: home, actor_user_id: null, target_type: 'user', metadata: { actor: 'operator' } }]);
  });

  it('gives an account without a password (Google sign-in only) one', async () => {
    const google = await createUser({ passwordHash: null });
    const result = await resetUserPasswordAsOperator(db, { email: google.email!, newPasswordHash: 'scrypt$first' }, instanceId);
    expect(result.ok).toBe(true);
    const [user] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${google.id}`;
    expect(user!.password_hash).toBe('scrypt$first');
  });

  it('changes nothing for an unknown, a deleted or a guest account', async () => {
    const deleted = await createUser({ deleted: true });
    const guest = await createUser({ guest: true });
    await addToken(deleted.id, 'reset', deleted.email!);

    expect(await resetUserPasswordAsOperator(db, { email: `nobody-${run}@example.test`, newPasswordHash: 'scrypt$x' }, instanceId))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(await resetUserPasswordAsOperator(db, { email: deleted.email!, newPasswordHash: 'scrypt$x' }, instanceId))
      .toEqual({ ok: false, reason: 'deleted' });
    expect(await resetUserPasswordAsOperator(db, { email: guest.email!, newPasswordHash: 'scrypt$x' }, instanceId))
      .toEqual({ ok: false, reason: 'guest' });

    const hashes = await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE id IN ${sql([deleted.id, guest.id])}`;
    expect(hashes.every((row) => row.password_hash === 'scrypt$old')).toBe(true);
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM email_tokens WHERE user_id = ${deleted.id} AND consumed_at IS NULL`;
    expect(count).toBe(1);
    const [{ audits }] = await sql<{ audits: number }[]>`
      SELECT count(*)::int AS audits FROM audit_logs
      WHERE action = ${OPERATOR_PASSWORD_RESET_ACTION} AND target_id IN ${sql([deleted.id, guest.id])}`;
    expect(audits).toBe(0);
  });

  it('lists the instance owner first, then live server owners, without deleted accounts', async () => {
    const otherInstance = `operator-list-${run}`;
    const owner = await createUser({ name: 'Zed Owner' });
    const serverOwner = await createUser({ name: 'Ann Server' });
    const goneOwner = await createUser({ name: 'Gone', deleted: true });
    const deletedServerOwner = await createUser({ name: 'Only a deleted server' });
    await sql`INSERT INTO instance_settings (instance_id, instance_name, owner_user_id) VALUES (${otherInstance}, 'List test', ${owner.id})`;
    try {
      await createServer(owner.id, `Main ${run}`, { createdAt: new Date('2026-02-01T00:00:00Z') });
      await createServer(serverOwner.id, `Side ${run}`);
      await createServer(goneOwner.id, `Orphan ${run}`);
      await createServer(deletedServerOwner.id, `Removed ${run}`, { deleted: true });

      const accounts = await listInstanceAdminAccounts(db, otherInstance);
      expect(accounts[0]).toEqual({ email: owner.email, displayName: 'Zed Owner', instanceOwner: true, ownedServers: [`Main ${run}`] });
      expect(accounts).toContainEqual({ email: serverOwner.email, displayName: 'Ann Server', instanceOwner: false, ownedServers: [`Side ${run}`] });
      expect(accounts.some((account) => account.email === goneOwner.email)).toBe(false);
      expect(accounts.some((account) => account.email === deletedServerOwner.email)).toBe(false);
      // Never ids or credentials.
      expect(Object.keys(accounts[0]!).sort()).toEqual(['displayName', 'email', 'instanceOwner', 'ownedServers']);
    } finally {
      await sql`DELETE FROM instance_settings WHERE instance_id = ${otherInstance}`;
    }
  });
});
