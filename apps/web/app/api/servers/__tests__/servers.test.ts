import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the queries module so we don't need a real Drizzle client.
const listServersForUser = vi.fn();
const createServer = vi.fn();
const getServerById = vi.fn();
const findOrCreateGuestUser = vi.fn();
const isServerMember = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  listServersForUser,
  createServer,
  getServerById,
  findOrCreateGuestUser,
  isServerMember,
}));

const SECRET = 'x'.repeat(32);
const _NOW = 1_700_000_000;

// Mock the security-headers module too so the withApiSecurity wrapper
// is a pass-through (we test the route logic, not the wrapper).
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

// Mock the db module so getDb() returns a sentinel — the actual queries
// are mocked at the @lobbyforge/db layer, so the route just needs *some*
// client to pass through.
vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  process.env.LOBBYFORGE_DEPLOYMENT_MODE = 'official';
  listServersForUser.mockReset();
  createServer.mockReset();
  getServerById.mockReset();
  findOrCreateGuestUser.mockReset();
  isServerMember.mockReset();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

async function loadRoute() {
  // Re-import the route after mocks are set up.
  return import('../route.js');
}

async function loadServerByIdRoute() {
  return import('../[id]/route.js');
}

function makeSessionCookie(uid: string | null = '00000000-0000-0000-0000-000000000001'): string {
  // Build a real signed guest session cookie so readGuestSession accepts it.
  // The route's auth check is the same code path used in production.
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

describe('POST /api/servers', () => {
  it('rejects instance creation on self-host deployments', async () => {
    process.env.LOBBYFORGE_DEPLOYMENT_MODE = 'self_host';
    const { POST } = await loadRoute();
    const req = new Request('https://example.test/api/servers', {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Another Instance' }),
    });
    const res = await POST(req, {});
    expect(res.status).toBe(403);
    expect(createServer).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no guest session', async () => {
    const { POST } = await loadRoute();
    const res = await POST(new Request('https://example.test/api/servers', { method: 'POST' }), {});
    expect(res.status).toBe(401);
  });

  it('returns 503 when the session has no materialized uid', async () => {
    const { POST } = await loadRoute();
    const req = new Request('https://example.test/api/servers', {
      method: 'POST',
      headers: { cookie: makeSessionCookie(null) },
      body: JSON.stringify({ name: 'My Server' }),
    });
    const res = await POST(req, {});
    expect(res.status).toBe(503);
    const json = (await res.json()) as { howToFix: string };
    expect(json.howToFix).toMatch(/auth\/guest/);
  });

  it('rejects an invalid name with 400', async () => {
    const { POST } = await loadRoute();
    const req = new Request('https://example.test/api/servers', {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'a' }), // below 2-char minimum
    });
    const res = await POST(req, {});
    expect(res.status).toBe(400);
  });

  it('creates the server with the caller uid and returns 201', async () => {
    createServer.mockResolvedValue({
      id: 'srv-1',
      name: 'My Server',
      slug: 'my-server',
      ownerUserId: '00000000-0000-0000-0000-000000000001',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    const { POST } = await loadRoute();
    const req = new Request('https://example.test/api/servers', {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'My Server', slug: 'my-server' }),
    });
    const res = await POST(req, {});
    expect(res.status).toBe(201);
    const json = (await res.json()) as { server: { id: string; name: string; ownerUserId: string } };
    expect(json.server.id).toBe('srv-1');
    expect(json.server.name).toBe('My Server');
    expect(createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'My Server', ownerUserId: '00000000-0000-0000-0000-000000000001' })
    );
  });
});

describe('GET /api/servers', () => {
  it('returns the call servers list', async () => {
    listServersForUser.mockResolvedValue([
      {
        id: 'srv-1',
        name: 'A',
        slug: 'a',
        ownerUserId: '00000000-0000-0000-0000-000000000001',
        iconUrl: null,
        defaultLocale: 'en',
        isPublic: false,
        createdAt: new Date('2026-06-09T00:00:00Z'),
        deletedAt: null,
      },
    ]);
    const { GET } = await loadRoute();
    const req = new Request('https://example.test/api/servers', {
      method: 'GET',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { servers: { id: string }[] };
    expect(json.servers).toHaveLength(1);
    expect(json.servers[0]?.id).toBe('srv-1');
  });

  it('returns 401 when the cookie is missing', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/servers', { method: 'GET' }), {});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/servers/[id]', () => {
  it('returns 404 when the server does not exist', async () => {
    getServerById.mockResolvedValue(null);
    const { GET } = await loadServerByIdRoute();
    const req = new Request('https://example.test/api/servers/srv-x', {
      method: 'GET',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: 'srv-x' }) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue({
      id: 'srv-1',
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadServerByIdRoute();
    const req = new Request('https://example.test/api/servers/srv-1', {
      method: 'GET',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: 'srv-1' }) });
    expect(res.status).toBe(403);
  });

  it('returns the server when the caller is a member', async () => {
    getServerById.mockResolvedValue({
      id: 'srv-1',
      name: 'A',
      slug: null,
      ownerUserId: '00000000-0000-0000-0000-000000000099',
      iconUrl: null,
      defaultLocale: 'en',
      isPublic: false,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      deletedAt: null,
    });
    isServerMember.mockResolvedValue(true);
    const { GET } = await loadServerByIdRoute();
    const req = new Request('https://example.test/api/servers/srv-1', {
      method: 'GET',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: 'srv-1' }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { server: { id: string } };
    expect(json.server.id).toBe('srv-1');
  });
});
