import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer — we test the route logic, not Drizzle.
const getServerById = vi.fn();
const isServerMember = vi.fn();
const getUserPermissions = vi.fn();
const getHighestRolePosition = vi.fn();
const banUser = vi.fn();
const unbanUser = vi.fn();
const isCurrentlyBanned = vi.fn();
const listBansForServer = vi.fn();
const userExists = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  getUserPermissions,
  getHighestRolePosition,
  userExists,
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

const callOrder: string[] = [];
const publishAccessInvalidation = vi.fn((..._args: unknown[]) => {
  callOrder.push('invalidate');
});
vi.mock('@/lib/access-invalidation', () => ({
  publishAccessInvalidation: (...args: unknown[]) => publishAccessInvalidation(...args),
}));
const queueMemberVoiceSync = vi.fn((..._args: unknown[]) => {
  callOrder.push('voice');
});
vi.mock('@/lib/voice-moderation', () => ({
  queueMemberVoiceSync: (...args: unknown[]) => queueMemberVoiceSync(...args),
}));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset();
  isServerMember.mockReset();
  getUserPermissions.mockReset();
  // LF-SEC-005 default: the ACTOR (caller) outranks the TARGET.
  getHighestRolePosition
    .mockReset()
    .mockImplementation(async (_db: unknown, _sid: string, userId: string) =>
      userId === TARGET_ID ? 10 : 50
    );
  banUser.mockReset();
  unbanUser.mockReset();
  isCurrentlyBanned.mockReset();
  listBansForServer.mockReset();
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
  publishAccessInvalidation.mockClear();
  queueMemberVoiceSync.mockClear();
  callOrder.length = 0;
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

  it('returns the ban list to a member with BAN_MEMBERS (LF-SEC-011)', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
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

  it('LF-SEC-011: denies the ban list to an ordinary member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['send_messages', 'read_message_history']);
    const { GET } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
    expect(listBansForServer).not.toHaveBeenCalled();
  });

  it('LF-SEC-011: MODERATE_MEMBERS and VIEW_AUDIT_LOG also grant the list', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['view_audit_log']);
    listBansForServer.mockResolvedValue([]);
    const { GET } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
  });

  it('LF-SEC-005: a lower-ranked moderator cannot ban a higher-ranked user', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    getHighestRolePosition.mockImplementation(
      async (_db: unknown, _sid: string, userId: string) =>
        userId === TARGET_ID ? 80 : 50
    );
    const { POST } = await loadRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId: TARGET_ID, reason: 'spam' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
    expect(banUser).not.toHaveBeenCalled();
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

// security-review AUTHZ-002: a member who left could not be banned
// (`POST /bans` → 404 "not a member"), so leaving was a way to dodge a
// moderator. A ban now reaches any existing user; kick/timeout/mute still
// need a membership.
describe('POST /api/servers/{id}/bans — security-review AUTHZ-002 non-member ban', () => {
  function banRow() {
    return {
      ok: true,
      ban: {
        id: 'ban-left',
        serverId: SERVER_ID,
        userId: TARGET_ID,
        bannedBy: USER_ID,
        reason: 'evasion',
        expiresAt: null,
        createdAt: new Date('2026-10-03T00:00:00Z'),
      },
    };
  }

  function post(userId: string) {
    return new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ userId, reason: 'evasion' }),
    });
  }

  beforeEach(() => {
    userExists.mockReset().mockResolvedValue(true);
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    getUserPermissions.mockResolvedValue(['ban_members']);
    // The actor is a member; the target left.
    isServerMember.mockImplementation(async (_db: unknown, userId: string) => userId !== TARGET_ID);
    banUser.mockResolvedValue(banRow());
  });

  it('bans a user who is no longer a member (201), with no rank comparison', async () => {
    // Even a target that WAS ranked above the moderator: they hold no roles now.
    getHighestRolePosition.mockImplementation(async (_db: unknown, _sid: string, userId: string) =>
      userId === TARGET_ID ? 80 : 50
    );
    const { POST } = await loadRoute();
    const res = await POST(post(TARGET_ID), { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(201);
    expect(banUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: SERVER_ID, userId: TARGET_ID, bannedBy: USER_ID })
    );
    expect(getHighestRolePosition).not.toHaveBeenCalledWith(expect.anything(), SERVER_ID, TARGET_ID, expect.anything());
    // security-review FILE-001: an id-only existence check, not a full user row.
    expect(userExists).toHaveBeenCalledWith(expect.anything(), TARGET_ID);
  });

  it('still needs BAN_MEMBERS', async () => {
    getUserPermissions.mockResolvedValue(['kick_members']);
    const { POST } = await loadRoute();
    const res = await POST(post(TARGET_ID), { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
    expect(banUser).not.toHaveBeenCalled();
  });

  it('404 for a user id that does not exist', async () => {
    userExists.mockResolvedValue(false);
    const { POST } = await loadRoute();
    const res = await POST(post(TARGET_ID), { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(404);
    expect(banUser).not.toHaveBeenCalled();
  });

  it('still refuses the owner and the actor themselves', async () => {
    isServerMember.mockResolvedValue(false);
    const { POST } = await loadRoute();
    const owner = await POST(post(OWNER_ID), { params: Promise.resolve({ id: SERVER_ID }) });
    expect(owner.status).toBe(400);
    isServerMember.mockImplementation(async (_db: unknown, userId: string) => userId === USER_ID);
    const self = await POST(post(USER_ID), { params: Promise.resolve({ id: SERVER_ID }) });
    expect(self.status).toBe(400);
    expect(banUser).not.toHaveBeenCalled();
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

// beta-review (S2): a ban must REVOKE access. The membership removal
// itself lives in banUser (same transaction — see the db integration
// test); the route must invalidate live WS/SSE topics AFTER the ban
// commits and push the user out of LiveKit rooms.
describe('POST /api/servers/{id}/bans — beta-review S2 access revocation', () => {
  function banOk() {
    banUser.mockImplementation(async () => {
      callOrder.push('ban');
      return {
        ok: true,
        ban: {
          id: 'ban-new',
          serverId: SERVER_ID,
          userId: TARGET_ID,
          bannedBy: USER_ID,
          reason: null,
          expiresAt: null,
          createdAt: new Date('2026-06-11T00:00:00Z'),
        },
      };
    });
  }

  async function postBan() {
    const { POST } = await loadRoute();
    return POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/bans`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ userId: TARGET_ID }),
      }),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
  }

  it('invalidates live topics AFTER the ban commits and evicts the user from voice', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    banOk();
    const res = await postBan();
    expect(res.status).toBe(201);
    expect(publishAccessInvalidation).toHaveBeenCalledWith({
      kind: 'user-server-access',
      serverId: SERVER_ID,
      userId: TARGET_ID,
      reason: 'ban',
    });
    expect(queueMemberVoiceSync).toHaveBeenCalledWith(SERVER_ID, TARGET_ID);
    expect(callOrder).toEqual(['ban', 'invalidate', 'voice']);
  });

  it('a failed ban neither invalidates nor touches voice', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['ban_members']);
    banUser.mockResolvedValue({ ok: false, error: 'cannot_ban_owner' });
    const res = await postBan();
    expect(res.status).toBe(400);
    expect(publishAccessInvalidation).not.toHaveBeenCalled();
    expect(queueMemberVoiceSync).not.toHaveBeenCalled();
  });
});
