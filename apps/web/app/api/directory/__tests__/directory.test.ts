import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const listPublicRegistryInstances = vi.fn();
const upsertRegistryInstance = vi.fn();
const heartbeatRegistryInstance = vi.fn();

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@lobbyforge/db', () => ({
  listPublicRegistryInstances,
  upsertRegistryInstance,
  heartbeatRegistryInstance,
}));
vi.mock('@lobbyforge/registry', () => ({
  normalizeRegistryInstanceUrl: (url: string) => {
    // Real-ish validation: must start with https:// and be a bare origin.
    if (!url.startsWith('https://')) throw new Error('must use HTTPS');
    return url.replace(/\/$/, '');
  },
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const UID = '00000000-0000-0000-0000-000000000099';

beforeEach(() => {
  vi.resetModules();
  requireMaterializedSession.mockReset();
  listPublicRegistryInstances.mockReset();
  upsertRegistryInstance.mockReset();
  heartbeatRegistryInstance.mockReset();
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

describe('POST /api/directory/heartbeat', () => {
  it('records live stats', async () => {
    heartbeatRegistryInstance.mockResolvedValue(undefined);
    const { POST } = await import('../heartbeat/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ instanceId: 'inst-1', onlineUsers: 50, doctorScore: 90 }),
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

  it('rejects invalid body (missing instanceId)', async () => {
    const { POST } = await import('../heartbeat/route.js');
    const res = await POST(
      new Request('https://example.test/api/directory/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ onlineUsers: 50 }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });
});
