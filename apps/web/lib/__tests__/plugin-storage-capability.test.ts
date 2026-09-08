/**
 * 9th-audit finding 4: the storage capability chain. The HOST mints
 * (serverId, pluginId)-bound short-TTL capabilities; the endpoint
 * verifies capability-vs-request-scope. A stolen relayed capability
 * must be worthless for any other keyspace, and expired ones dead.
 */
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFns = {
  getPluginData: vi.fn().mockResolvedValue(null),
  setPluginData: vi.fn().mockResolvedValue(undefined),
  deletePluginData: vi.fn().mockResolvedValue(true),
  listPluginData: vi.fn().mockResolvedValue([]),
  clearPluginData: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withMachineApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

import { mintStorageCapability } from '../plugin-worker-client';

const SECRET = 'k'.repeat(40);
const SERVER = '00000000-0000-0000-0000-0000000000a1';
const PLUGIN = 'market-quiz';

async function post(body: unknown, headers: Record<string, string>): Promise<Response> {
  const { POST } = await import('@/app/api/internal/plugin-storage/route');
  return POST(
    new Request('https://example.test/api/internal/plugin-storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    {}
  );
}

beforeEach(() => {
  process.env.LOBBYFORGE_PLUGIN_STORAGE_TOKEN = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockClear();
});

describe('mintStorageCapability', () => {
  it('differs per scope and expires', () => {
    const a = mintStorageCapability(SERVER, PLUGIN, SECRET);
    const b = mintStorageCapability(SERVER, 'other-plugin', SECRET);
    expect(a).not.toBe(b);
    const past = mintStorageCapability(SERVER, PLUGIN, SECRET, Date.now() - 300_000);
    expect(Number(past.split('.')[0])).toBeLessThan(Math.floor(Date.now() / 1000));
  });
});

describe('POST /api/internal/plugin-storage', () => {
  it('accepts a correctly-scoped capability', async () => {
    const cap = mintStorageCapability(SERVER, PLUGIN, SECRET);
    const res = await post(
      { op: 'get', serverId: SERVER, pluginId: PLUGIN, key: 'k1' },
      { 'x-lf-plugin-capability': cap }
    );
    expect(res.status).toBe(200);
    expect(dbFns.getPluginData).toHaveBeenCalledWith(expect.anything(), SERVER, PLUGIN, 'k1');
  });

  it('9th-audit REGRESSION: a stolen capability CANNOT address another keyspace', async () => {
    // Minted for (SERVER, PLUGIN) — used against a DIFFERENT plugin id.
    const cap = mintStorageCapability(SERVER, PLUGIN, SECRET);
    const res = await post(
      { op: 'get', serverId: SERVER, pluginId: 'victim-plugin', key: 'k1' },
      { 'x-lf-plugin-capability': cap }
    );
    expect(res.status).toBe(401);
    expect(dbFns.getPluginData).not.toHaveBeenCalled();
  });

  it('rejects expired capabilities', async () => {
    const cap = mintStorageCapability(SERVER, PLUGIN, SECRET, Date.now() - 300_000);
    const res = await post(
      { op: 'get', serverId: SERVER, pluginId: PLUGIN, key: 'k1' },
      { 'x-lf-plugin-capability': cap }
    );
    expect(res.status).toBe(401);
  });

  it('rejects missing/garbage capabilities', async () => {
    const noHeader = await post({ op: 'get', serverId: SERVER, pluginId: PLUGIN, key: 'k1' }, {});
    expect(noHeader.status).toBe(401);
    const garbage = await post(
      { op: 'get', serverId: SERVER, pluginId: PLUGIN, key: 'k1' },
      { 'x-lf-plugin-capability': 'not.a-valid-mac' }
    );
    expect(garbage.status).toBe(401);
  });

  it('works WITHOUT any browser Origin header (machine endpoint)', async () => {
    const cap = mintStorageCapability(SERVER, PLUGIN, SECRET);
    const res = await post(
      { op: 'set', serverId: SERVER, pluginId: PLUGIN, key: 'k1', value: 1 },
      { 'x-lf-plugin-capability': cap }
    );
    expect(res.status).toBe(200);
  });
});
