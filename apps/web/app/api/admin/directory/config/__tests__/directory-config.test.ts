import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * security-review HUB-001: the directory config round trip — admin
 * config route → instance_settings → /.well-known/lobbyforge-verification
 * — against the REAL `@lobbyforge/db` query functions. Only the database
 * client is faked: a one-row `instance_settings` store that answers a
 * WHERE on `instance_id` the way Postgres would.
 *
 * Before the fix the queries looked for an `instance_id = 'default'` row
 * that never exists: `.well-known` 404'd on every install and the admin
 * POST answered `{ ok: true }` after writing nothing. Publishing the
 * singleton key (`self-host`, the same everywhere) instead would have let
 * the first hub account to register it own every install's entry.
 */

const DIRECTORY_ID = '5f0c7a52-2d0e-4b8e-9a43-0c6f2f6f1d11';
const DOMAIN = 'https://chat.example.com';

interface Store {
  row: Record<string, unknown> | null;
  /** The row disappears between the read and the write. */
  loseRowBeforeUpdate: boolean;
  writes: number;
}

const store = vi.hoisted<Store>(() => ({ row: null, loseRowBeforeUpdate: false, writes: 0 }));

const dialect = new PgDialect();

/** Does `where` select the stored row? Only `instance_id = $1` is understood. */
function matches(where: SQL): boolean {
  const { sql, params } = dialect.sqlToQuery(where);
  if (sql !== '"instance_settings"."instance_id" = $1') throw new Error(`unexpected WHERE: ${sql}`);
  return store.row !== null && store.row.instance_id === params[0];
}

type Columns = Record<string, { name: string }>;

function project(fields: Columns): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, store.row![column.name]]));
}

const fakeDb = {
  select: (fields: Columns) => ({
    from: () => ({
      where: (where: SQL) => ({
        limit: async () => (matches(where) ? [project(fields)] : []),
      }),
    }),
  }),
  update: (table: Columns) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (where: SQL) => ({
        returning: async (fields: Columns) => {
          if (store.loseRowBeforeUpdate) store.row = null;
          if (!matches(where)) return [];
          store.writes += 1;
          for (const [key, value] of Object.entries(patch)) store.row![table[key]!.name] = value;
          return [project(fields)];
        },
      }),
    }),
  }),
};

vi.mock('@/lib/db', () => ({ getDb: () => fakeDb }));
vi.mock('@/lib/admin-auth', () => ({ requireInstanceAdmin: vi.fn(async () => null) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

const keypair = generateKeyPairSync('ed25519');
const PUBLIC_KEY = keypair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** What `lfctl directory proof` produces. */
function proofFor(instanceId: string, domain = DOMAIN): string {
  const canonical = JSON.stringify({ verify: 1, instanceId, domain, publicKey: PUBLIC_KEY });
  return signEd25519(null, Buffer.from(canonical, 'utf8'), keypair.privateKey).toString('base64');
}

beforeEach(() => {
  // The settings singleton as /setup creates it, with 0039's directory id.
  store.row = {
    instance_id: 'self-host',
    directory_instance_id: DIRECTORY_ID,
    domain: null,
    public_key: null,
    is_public_directory_enabled: false,
    directory_proof: null,
    updated_at: null,
  };
  store.loseRowBeforeUpdate = false;
  store.writes = 0;
});

async function adminGet(): Promise<Response> {
  const { GET } = await import('../route.js');
  return (GET as unknown as (req: Request) => Promise<Response>)(
    new Request('https://instance.test/api/admin/directory/config')
  );
}

async function adminPost(body: unknown): Promise<Response> {
  const { POST } = await import('../route.js');
  return (POST as unknown as (req: Request) => Promise<Response>)(
    new Request('https://instance.test/api/admin/directory/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function wellKnown(): Promise<Response> {
  const { GET } = await import('@/app/.well-known/lobbyforge-verification/route');
  return (GET as unknown as (req: Request) => Promise<Response>)(
    new Request('https://instance.test/.well-known/lobbyforge-verification')
  );
}

describe('directory config — security-review HUB-001', () => {
  it('shows the admin this install\'s directory id, not the shared settings key', async () => {
    const res = await adminGet();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: { instanceId: string; hasProof: boolean } };
    expect(json.config.instanceId).toBe(DIRECTORY_ID);
    expect(json.config.hasProof).toBe(false);
  });

  it('stores a proof for the directory id and .well-known serves it', async () => {
    expect((await wellKnown()).status).toBe(404); // not configured yet

    const res = await adminPost({
      domain: DOMAIN,
      publicKey: PUBLIC_KEY,
      directoryProof: proofFor(DIRECTORY_ID),
      isPublicDirectoryEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, instanceId: DIRECTORY_ID });
    expect(store.writes).toBe(1);
    expect(store.row).toMatchObject({ domain: DOMAIN, public_key: PUBLIC_KEY, is_public_directory_enabled: true });

    const doc = await wellKnown();
    expect(doc.status).toBe(200);
    expect(await doc.json()).toEqual({ instanceId: DIRECTORY_ID, publicKey: PUBLIC_KEY, proof: proofFor(DIRECTORY_ID) });
  });

  it.each(['self-host', 'default', '6a1d2c3b-4e5f-4a6b-9c7d-8e9f0a1b2c3d'])(
    'refuses a proof made for %s and names the right id',
    async (instanceId) => {
      const res = await adminPost({
        domain: DOMAIN,
        publicKey: PUBLIC_KEY,
        directoryProof: proofFor(instanceId),
        isPublicDirectoryEnabled: true,
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; instanceId: string };
      expect(json.instanceId).toBe(DIRECTORY_ID);
      expect(json.error).toContain(`--instance-id ${DIRECTORY_ID}`);
      expect(store.writes).toBe(0);
    }
  );

  it('refuses a domain that is not written as its origin (the hub could never verify it)', async () => {
    const res = await adminPost({
      domain: `${DOMAIN}/`,
      publicKey: PUBLIC_KEY,
      directoryProof: proofFor(DIRECTORY_ID, `${DOMAIN}/`),
      isPublicDirectoryEnabled: true,
    });
    expect(res.status).toBe(400);
    expect(store.writes).toBe(0);
  });

  it('answers an error, not { ok: true }, when there is no settings row', async () => {
    store.row = null;
    const res = await adminPost({
      domain: DOMAIN,
      publicKey: PUBLIC_KEY,
      directoryProof: proofFor(DIRECTORY_ID),
      isPublicDirectoryEnabled: true,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { ok?: boolean }).ok).toBeUndefined();
  });

  it('answers an error when the write itself matches no row', async () => {
    store.loseRowBeforeUpdate = true;
    const res = await adminPost({
      domain: DOMAIN,
      publicKey: PUBLIC_KEY,
      directoryProof: proofFor(DIRECTORY_ID),
      isPublicDirectoryEnabled: true,
    });
    expect(res.status).toBe(409);
    expect(store.writes).toBe(0);
  });
});
