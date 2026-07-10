import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const getServerById = vi.fn();
const isServerMember = vi.fn();
const listCardPackSummaries = vi.fn();
const ensureBuiltInContentSeeded = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  listCardPackSummaries,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

vi.mock('@/lib/plugin-content-seeder', () => ({
  ensureBuiltInContentSeeded,
}));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

const SERVER_ID = 'srv-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const MEMBER_ID = '00000000-0000-0000-0000-000000000002';
const OUTSIDER_ID = '00000000-0000-0000-0000-000000000003';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset();
  isServerMember.mockReset();
  listCardPackSummaries.mockReset();
  ensureBuiltInContentSeeded.mockReset();
  ensureBuiltInContentSeeded.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeSessionCookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function loadRoute() {
  return import('../route.js');
}

function makeReq(url: string, cookie: string | null) {
  const headers: Record<string, string> = {};
  if (cookie) headers['cookie'] = cookie;
  return new Request(url, { method: 'GET', headers });
}

describe('GET /api/servers/{id}/card-packs', () => {
  it('returns 401 when no session is present', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq(`http://localhost/api/servers/${SERVER_ID}/card-packs`, null), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the server does not exist', async () => {
    getServerById.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/card-packs`, makeSessionCookie(OWNER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for non-members who are not the owner', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/card-packs`, makeSessionCookie(OUTSIDER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('returns the installed card packs for the owner', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    listCardPackSummaries.mockResolvedValue([
      {
        id: 'pack-1',
        pluginId: 'hushle',
        slug: 'hushle-en-basic',
        name: 'Hushle — English (Basic)',
        language: 'en',
        description: '24 everyday English words for the M17 Hushle MVP.',
        isBuiltIn: true,
        cardCount: 24,
        createdAt: new Date('2026-06-18T00:00:00Z'),
        updatedAt: new Date('2026-06-18T00:00:00Z'),
      },
      {
        id: 'pack-2',
        pluginId: 'hushle',
        slug: 'hushle-tr-basic',
        name: 'Hushle — Türkçe (Temel)',
        language: 'tr',
        description: '24 günlük Türkçe kelime — Hushle M17 temel paketi.',
        isBuiltIn: true,
        cardCount: 24,
        createdAt: new Date('2026-06-18T00:00:00Z'),
        updatedAt: new Date('2026-06-18T00:00:00Z'),
      },
    ]);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/card-packs`, makeSessionCookie(OWNER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cardPacks).toHaveLength(2);
    expect(body.cardPacks[0]).toMatchObject({
      slug: 'hushle-en-basic',
      pluginId: 'hushle',
      language: 'en',
      isBuiltIn: true,
      cardCount: 24,
    });
    expect(body.cardPacks[1].slug).toBe('hushle-tr-basic');
  });

  it('returns the installed card packs for a member', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    isServerMember.mockResolvedValue(true);
    listCardPackSummaries.mockResolvedValue([]);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/card-packs`, makeSessionCookie(MEMBER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cardPacks).toEqual([]);
  });

  it('passes the pluginId filter through to the query layer', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    listCardPackSummaries.mockResolvedValue([]);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(
        `http://localhost/api/servers/${SERVER_ID}/card-packs?pluginId=hushle`,
        makeSessionCookie(OWNER_ID)
      ),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    expect(listCardPackSummaries).toHaveBeenCalledWith(expect.anything(), 'hushle');
  });

  it('returns 500 when the query layer throws', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    listCardPackSummaries.mockRejectedValue(new Error('boom'));
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/card-packs`, makeSessionCookie(OWNER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(500);
  });
});
