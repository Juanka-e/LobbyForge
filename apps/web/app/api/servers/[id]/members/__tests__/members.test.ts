import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer — we test the route logic, not Drizzle.
const getServerById = vi.fn();
const isServerMember = vi.fn();
const listMembersForServer = vi.fn();
const removeMember = vi.fn();
const setMemberRoles = vi.fn();
const getRoleById = vi.fn();
const getUserPermissions = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  listMembersForServer,
  removeMember,
  setMemberRoles,
  getRoleById,
  getUserPermissions,
  logAction,
  EVERYONE_ROLE_NAME: '@everyone',
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
  listMembersForServer.mockReset();
  removeMember.mockReset();
  setMemberRoles.mockReset();
  getRoleById.mockReset();
  getUserPermissions.mockReset();
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

async function loadListRoute() {
  return import('../route.js');
}

async function loadItemRoute() {
  return import('../[userId]/route.js');
}

async function loadRoleRoute() {
  return import('../[userId]/role/route.js');
}

const SERVER_ID = 'srv-1';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_ID = '00000000-0000-0000-0000-000000000099';
const TARGET_ID = '00000000-0000-0000-0000-000000000002';
const ROLE_ID = '00000000-0000-0000-0000-0000000000aa';

function mockServer(ownerUserId: string = USER_ID) {
  return {
    id: SERVER_ID,
    name: 'A',
    slug: null,
    ownerUserId,
    iconUrl: null,
    defaultLocale: 'en',
    isPublic: false,
    createdAt: new Date('2026-06-10T00:00:00Z'),
    deletedAt: null,
  };
}

describe('GET /api/servers/{id}/members', () => {
  it('returns 401 when there is no guest session', async () => {
    const { GET } = await loadListRoute();
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/members`), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/members`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('decorates the owner with isOwner=true and administrator permission', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    listMembersForServer.mockResolvedValue([
      {
        userId: OWNER_ID,
        serverId: SERVER_ID,
        roleId: 'role-everyone',
        roleIds: ['role-everyone'],
        nickname: null,
        joinedAt: new Date('2026-06-10T00:00:00Z'),
        permissions: [],
      },
      {
        userId: TARGET_ID,
        serverId: SERVER_ID,
        roleId: 'role-mod',
        roleIds: ['role-mod'],
        nickname: 'T',
        joinedAt: new Date('2026-06-10T00:00:00Z'),
        permissions: ['kick_members'],
      },
    ]);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/members`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      members: { userId: string; isOwner: boolean; permissions: string[] }[];
    };
    const owner = json.members.find((m) => m.userId === OWNER_ID);
    const other = json.members.find((m) => m.userId === TARGET_ID);
    expect(owner?.isOwner).toBe(true);
    expect(owner?.permissions).toContain('administrator');
    expect(other?.isOwner).toBe(false);
  });
});

describe('DELETE /api/servers/{id}/members/{userId}', () => {
  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(false);
    const { DELETE } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}`,
      {
        method: 'DELETE',
        headers: { cookie: makeSessionCookie() },
      }
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects kicking the server owner with 400', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    const { DELETE } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${OWNER_ID}`,
      {
        method: 'DELETE',
        headers: { cookie: makeSessionCookie() },
      }
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: OWNER_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller lacks KICK_MEMBERS', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { DELETE } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}`,
      {
        method: 'DELETE',
        headers: { cookie: makeSessionCookie() },
      }
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('allows self-leave without KICK_MEMBERS', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    removeMember.mockResolvedValue(undefined);
    const { DELETE } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${USER_ID}`,
      {
        method: 'DELETE',
        headers: { cookie: makeSessionCookie() },
      }
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: USER_ID }),
    });
    expect(res.status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith(expect.anything(), SERVER_ID, USER_ID);
    // Important: the perms lookup should not even be called for self-leave.
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('kicks a non-owner member when the caller has KICK_MEMBERS', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['kick_members']);
    removeMember.mockResolvedValue(undefined);
    const { DELETE } = await loadItemRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}`,
      {
        method: 'DELETE',
        headers: { cookie: makeSessionCookie() },
      }
    );
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith(expect.anything(), SERVER_ID, TARGET_ID);
  });
});

describe('PUT /api/servers/{id}/members/{userId}/role', () => {
  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(false);
    const { PUT } = await loadRoleRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}/role`,
      {
        method: 'PUT',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ roleIds: [ROLE_ID] }),
      }
    );
    const res = await PUT(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks MANAGE_ROLES', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['kick_members']);
    const { PUT } = await loadRoleRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}/role`,
      {
        method: 'PUT',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ roleIds: [ROLE_ID] }),
      }
    );
    const res = await PUT(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when the role belongs to a different server', async () => {
    getServerById.mockResolvedValue(mockServer());
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['administrator']);
    getRoleById.mockResolvedValue({
      id: '00000000-0000-0000-0000-0000000000bb',
      serverId: 'srv-OTHER',
      name: 'Mod',
      color: null,
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    const { PUT } = await loadRoleRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}/role`,
      {
        method: 'PUT',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ roleIds: [ROLE_ID] }),
      }
    );
    const res = await PUT(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('assigns roles when the caller is the owner', async () => {
    getServerById.mockResolvedValue(mockServer());
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['administrator']);
    getRoleById.mockResolvedValue({
      id: ROLE_ID,
      serverId: SERVER_ID,
      name: 'Mod',
      color: null,
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    setMemberRoles.mockResolvedValue({
      serverId: SERVER_ID,
      userId: TARGET_ID,
      roleId: ROLE_ID,
      nickname: null,
    });
    const { PUT } = await loadRoleRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}/role`,
      {
        method: 'PUT',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ roleIds: [ROLE_ID] }),
      }
    );
    const res = await PUT(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      membership: { userId: string; roleId: string; roleIds: string[] };
    };
    expect(json.membership.userId).toBe(TARGET_ID);
    expect(json.membership.roleId).toBe(ROLE_ID);
    expect(json.membership.roleIds).toEqual([ROLE_ID]);
  });

  it('clears the roles when roleIds is empty', async () => {
    getServerById.mockResolvedValue(mockServer());
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['administrator']);
    setMemberRoles.mockResolvedValue({
      serverId: SERVER_ID,
      userId: TARGET_ID,
      roleId: null,
      nickname: null,
    });
    const { PUT } = await loadRoleRoute();
    const req = new Request(
      `https://example.test/api/servers/${SERVER_ID}/members/${TARGET_ID}/role`,
      {
        method: 'PUT',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ roleIds: [] }),
      }
    );
    const res = await PUT(req, {
      params: Promise.resolve({ id: SERVER_ID, userId: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    // When roleIds is empty the route should NOT call getRoleById at all.
    expect(getRoleById).not.toHaveBeenCalled();
    expect(setMemberRoles).toHaveBeenCalledWith(expect.anything(), SERVER_ID, TARGET_ID, []);
  });
});
