import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const listPublicRegistryInstances = vi.fn();
const upsertRegistryInstance = vi.fn();
const heartbeatRegistryInstance = vi.fn();
const getRegistryInstanceByInstanceId = vi.fn();

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@lobbyforge/db', () => {
  // The route does `instanceof RegistryInstanceOwnedError` — the mock must
  // expose the SAME class the test rejects with.
  class RegistryInstanceOwnedError extends Error {}
  return {
    listPublicRegistryInstances,
    upsertRegistryInstance,
    heartbeatRegistryInstance,
    getRegistryInstanceByInstanceId,
    RegistryInstanceOwnedError,
  };
});
vi.mock('@lobbyforge/registry', () => ({
  normalizeRegistryInstanceUrl: (url: string) => {
    // Real-ish validation: must start with https:// and be a bare origin.
    if (!url.startsWith('https://')) throw new Error('must use HTTPS');
    return url.replace(/\/$/, '');
  },
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  withMachineApiSecurity: (handler: unknown) => handler,
}));

// LF-SEC-007: heartbeat replay guard — in-memory Redis mock.
const redisSet = vi.fn().mockResolvedValue('OK');
vi.mock('@/lib/redis', () => ({ redis: { set: redisSet } }));

const UID = '00000000-0000-0000-0000-000000000099';

beforeEach(() => {
  vi.resetModules();
  requireMaterializedSession.mockReset();
  listPublicRegistryInstances.mockReset();
  upsertRegistryInstance.mockReset();
  heartbeatRegistryInstance.mockReset();
  getRegistryInstanceByInstanceId.mockReset();
  redisSet.mockReset().mockResolvedValue('OK');
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
});

describe('GET /api/directory', () => {
  it('returns listed instances sorted by online users', async () => {
    listPublicRegistryInstances.mockResolvedValue([
      {
        instanceId: 'inst-1', name: 'Gaming Hub', domain: 'https://gaming.example.dev',
        description: 'For gamers', region: 'Europe', languages: ['en'], tags: ['gaming'],
        features: [], isVerified: true, isListed: true, isBlocked: false, nsfw: false,
        onlineUsers: 42, publicRoomsCount: 5, version: '0.2.0', doctorScore: 88,
        lastHeartbeatAt: new Date(), id: 'x', createdAt: new Date(), publicKey: 'pk',
      },
    ]);
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/directory'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { instances: Array<{ name: string }> };
    expect(json.instances).toHaveLength(1);
    expect(json.instances[0].name).toBe('Gaming Hub');
  });

  it('passes region and limit query params', async () => {
    listPublicRegistryInstances.mockResolvedValue([]);
    const { GET } = await import('../route.js');
    await GET(new Request('https://example.test/api/directory?region=Asia&limit=10'), {});
    expect(listPublicRegistryInstances).toHaveBeenCalledWith(
      { __mockDb: true },
      { limit: 10, region: 'Asia' }
    );
  });
});

describe('POST /api/directory/register', () => {
  const validBody = {
    instanceId: 'inst-2',
    name: 'My Community',
    domain: 'https://my.example.dev',
    publicKey: 'x'.repeat(64),
  };

  it('registers a new instance (starts unlisted)', async () => {
    upsertRegistryInstance.mockResolvedValue({
      instanceId: 'inst-2', name: 'My Community', domain: 'https://my.example.dev',
      isListed: false, isVerified: false, id: 'y',
    });
    const { POST } = await import('../register/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/register', {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      {}
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { isListed: boolean; message: string };
    expect(json.message).toContain('review');
  });

  it('passes the acting user as the ownership claim (SEC-007)', async () => {
    upsertRegistryInstance.mockResolvedValue({
      instanceId: 'inst-2', isListed: false, isVerified: false, id: 'y',
    });
    const { POST } = await import('../register/route.js');
    await POST(
      new Request('https://example.test/api/directory/register', {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      {}
    );
    expect(upsertRegistryInstance).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ actorUserId: UID })
    );
  });

  it('maps an ownership rejection to 403 (SEC-007)', async () => {
    // The route checks `instanceof RegistryInstanceOwnedError` against its
    // own @lobbyforge/db import — reject with that same mocked class.
    const dbMod = await import('@lobbyforge/db');
    const OwnedError = (dbMod as unknown as {
      RegistryInstanceOwnedError: new () => Error;
    }).RegistryInstanceOwnedError;
    upsertRegistryInstance.mockRejectedValue(new OwnedError());
    const { POST } = await import('../register/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/register', {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      {}
    );
    expect(res.status).toBe(403);
  });

  it('rejects a non-HTTPS domain', async () => {
    const { POST } = await import('../register/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/register', {
        method: 'POST',
        body: JSON.stringify({ ...validBody, domain: 'http://insecure.example.dev' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
    expect(upsertRegistryInstance).not.toHaveBeenCalled();
  });

  it('returns 401 when no session', async () => {
    requireMaterializedSession.mockReturnValue({
      ok: false,
      response: NextResponse.json({ error: 'Auth required' }, { status: 401 }),
    });
    const { POST } = await import('../register/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/register', {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      {}
    );
    expect(res.status).toBe(401);
  });
});

// LF-SEC-007: a REAL Ed25519 keypair — the route must verify genuine
// signatures with node:crypto, not a mocked verify.
const nodeCrypto = await import('node:crypto');
const edSign = nodeCrypto.sign;
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
const publicSpkiB64 = publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');

describe('POST /api/directory/heartbeat — LF-SEC-007 signed contract', () => {

  function signedBody(overrides: Record<string, unknown> = {}) {
    const base = {
      instanceId: 'inst-1',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'n'.repeat(24),
      stats: { onlineUsers: 50, doctorScore: 90 },
      ...overrides,
    };
    const canonical = JSON.stringify({
      instanceId: base.instanceId,
      timestamp: base.timestamp,
      nonce: base.nonce,
      stats: base.stats,
    });
    return {
      ...base,
      signature:
        overrides.signature ??
        edSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'),
    };
  }

  beforeEach(() => {
    getRegistryInstanceByInstanceId.mockResolvedValue({
      instanceId: 'inst-1',
      publicKey: publicSpkiB64,
      isBlocked: false,
    });
    heartbeatRegistryInstance.mockResolvedValue(undefined);
  });

  it('records stats for a correctly SIGNED heartbeat', async () => {
    const { POST } = await import('../heartbeat/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify(signedBody()),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(heartbeatRegistryInstance).toHaveBeenCalledWith(
      { __mockDb: true },
      'inst-1',
      { onlineUsers: 50, publicRoomsCount: undefined, version: undefined, doctorScore: 90 }
    );
  });

  it('rejects an INVALID signature (cross-instance spoof)', async () => {
    const { POST } = await import('../heartbeat/route.js');
    const body = signedBody({ signature: Buffer.alloc(64, 7).toString('base64') });
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      {}
    );
    expect(res.status).toBe(401);
    expect(heartbeatRegistryInstance).not.toHaveBeenCalled();
  });

  it('a cookie alone is NOT sufficient anymore (missing fields → 400)', async () => {
    const { POST } = await import('../heartbeat/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ instanceId: 'inst-1', onlineUsers: 50 }),
      }),
      {}
    );
    expect(res.status).toBe(400);
    expect(heartbeatRegistryInstance).not.toHaveBeenCalled();
  });

  it('rejects a STALE timestamp', async () => {
    const { POST } = await import('../heartbeat/route.js');
    const body = signedBody({ timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      {}
    );
    expect(res.status).toBe(401);
  });

  it('rejects a far-FUTURE timestamp', async () => {
    const { POST } = await import('../heartbeat/route.js');
    const body = signedBody({ timestamp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      {}
    );
    expect(res.status).toBe(401);
  });

  it('rejects a REPLAYED nonce', async () => {
    redisSet.mockResolvedValue(null); // NX lost — the nonce already burned
    const { POST } = await import('../heartbeat/route.js');
    const body = signedBody();
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      {}
    );
    expect(res.status).toBe(401);
    expect(heartbeatRegistryInstance).not.toHaveBeenCalled();
  });

  it('rejects an unknown instance (404, no enumeration detail)', async () => {
    getRegistryInstanceByInstanceId.mockResolvedValue(null);
    const { POST } = await import('../heartbeat/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify(signedBody()),
      }),
      {}
    );
    expect(res.status).toBe(404);
  });
});
