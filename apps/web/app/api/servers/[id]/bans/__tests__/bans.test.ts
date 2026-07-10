import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer — we test the route logic, not Drizzle.
const getServerById = vi.fn();
const isServerMember = vi.fn();
const getUserPermissions = vi.fn();
const banUser = vi.fn();
const unbanUser = vi.fn();
const isCurrentlyBanned = vi.fn();
const listBansForServer = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  getUserPermissions,
  banUser,
  unbanUser,
  isCurrentlyBanned,
  listBansForServer,
  logAction,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset();
  isServerMember.mockReset();
  getUserPermissions.mockReset();
  banUser.mockReset();
  unbanUser.mockReset();
  isCurrentlyBanned.mockReset();
  listBansForServer.mockReset();
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeSessionCookie(uid: string = '00000000-0000-0000-0000-000000000001'): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function loadRoute() {
  return import('../route.js');
}

const SERVER_ID = 'srv-1';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_ID = '00000000-0000-0000-0000-000000000099';
const TARGET_ID = '00000000-0000-0000-0000-000000000002';

function mockServer(ownerUserId: string = USER_ID) {
  return {
    id: SERVER_ID,
    name: 'A',
    slug: null,
    ownerUserId,
    iconUrl: null,
    defaultLocale: 'en',
    isPublic: false,
    createdAt: new Date('2026-06-11T00:00:00Z'),
    deletedAt: null,
  };
}

describe('GET /api/servers/{id}/bans', () => {
  it('returns 401 when there is no guest session', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/bans`), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns the ban list to a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    listBansForServer.mockResolvedValue([
      {
        id: 'ban-1',
        serverId: SERVER_ID,
        userId: TARGET_ID,
        bannedBy: USER_ID,
        reason: 'spam',
        expiresAt: null,
        createdAt: new Date('2026-06-11T00:00:00Z'),
        displayName: 'Bad Actor',
      },
    ]);
    const { GET } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bans: { id: string; displayName: string }[] };
    expect(json.bans[0]?.displayName).toBe('Bad Actor');
  });
});

describe('POST /api/servers/{id}/bans', () => {
  it('rejects banning the server owner with 400', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['ban_members']);
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId: USER_ID }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller lacks BAN_MEMBERS', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['kick_members']);
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns 400 when the body is malformed', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['ban_members']);
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId: 'not-a-uuid' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the caller tries to ban themselves', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    banUser.mockResolvedValue({ ok: false, error: 'cannot_ban_self' });
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId: USER_ID }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the user is already banned', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    banUser.mockResolvedValue({ ok: false, error: 'already_banned' });
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId: TARGET_ID }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(409);
  });

  it('creates a ban and returns 201', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    banUser.mockResolvedValue({
      ok: true,
      ban: {
        id: 'ban-new',
        serverId: SERVER_ID,
        userId: TARGET_ID,
        bannedBy: USER_ID,
        reason: 'spam',
        expiresAt: null,
        createdAt: new Date('2026-06-11T00:00:00Z'),
      },
    });
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId: TARGET_ID, reason: 'spam' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ban: { id: string; reason: string } };
    expect(json.ban.id).toBe('ban-new');
    expect(json.ban.reason).toBe('spam');
    expect(banUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: SERVER_ID, userId: TARGET_ID, reason: 'spam' })
    );
  });
});

describe('DELETE /api/servers/{id}/bans?userId=…', () => {
  it('returns 400 when userId is missing', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    const { DELETE } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller lacks BAN_MEMBERS', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['kick_members']);
    const { DELETE } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans?userId=${TARGET_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns 200 with removed:false when the user is not banned', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    isCurrentlyBanned.mockResolvedValue(false);
    const { DELETE } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans?userId=${TARGET_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; removed: boolean };
    expect(json.removed).toBe(false);
    expect(unbanUser).not.toHaveBeenCalled();
  });

  it('unbans the user when the row exists', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    isCurrentlyBanned.mockResolvedValue(true);
    unbanUser.mockResolvedValue({
      id: 'ban-1',
      serverId: SERVER_ID,
      userId: TARGET_ID,
      bannedBy: USER_ID,
      reason: null,
      expiresAt: null,
      createdAt: new Date('2026-06-11T00:00:00Z'),
    });
    const { DELETE } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans?userId=${TARGET_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; removed: boolean };
    expect(json.removed).toBe(true);
    expect(unbanUser).toHaveBeenCalledWith(expect.anything(), SERVER_ID, TARGET_ID);
  });
});
