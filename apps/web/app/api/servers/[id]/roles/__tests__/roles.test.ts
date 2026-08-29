import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer — we test the route logic, not Drizzle.
const getServerById = vi.fn();
const isServerMember = vi.fn();
const listRolesForServer = vi.fn();
const createRole = vi.fn();
const getRoleById = vi.fn();
const updateRole = vi.fn();
const deleteRole = vi.fn();
const getUserPermissions = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);

const { getHighestRolePosition } = vi.hoisted(() => ({
  getHighestRolePosition: vi.fn().mockResolvedValue(Number.POSITIVE_INFINITY),
}));

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  getHighestRolePosition,
  isServerMember,
  listRolesForServer,
  createRole,
  getRoleById,
  updateRole,
  deleteRole,
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
  listRolesForServer.mockReset();
  createRole.mockReset();
  getRoleById.mockReset();
  updateRole.mockReset();
  deleteRole.mockReset();
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
  return import('../[roleId]/route.js');
}

const SERVER_ID = 'srv-1';
const ROLE_ID = 'role-1';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_ID = '00000000-0000-0000-0000-000000000099';

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

describe('GET /api/servers/{id}/roles', () => {
  it('returns 401 when there is no guest session', async () => {
    const { GET } = await loadListRoute();
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/roles`), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns an empty list when there are no roles', async () => {
    getServerById.mockResolvedValue(mockServer());
    listRolesForServer.mockResolvedValue([]);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { roles: unknown[] };
    expect(json.roles).toEqual([]);
  });

  it('returns the role list to a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    listRolesForServer.mockResolvedValue([
      {
        id: 'role-everyone',
        serverId: SERVER_ID,
        name: '@everyone',
        color: null,
        position: 0,
        permissions: ['view_channels', 'send_messages'],
        createdAt: new Date('2026-06-10T00:00:00Z'),
      },
      {
        id: 'role-mod',
        serverId: SERVER_ID,
        name: 'Moderator',
        color: '#3498db',
        position: 10,
        permissions: ['kick_members', 'manage_messages'],
        createdAt: new Date('2026-06-10T00:00:00Z'),
      },
    ]);
    const { GET } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      headers: { cookie: makeSessionCookie() },
    });
    const res = await GET(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { roles: { id: string; name: string }[] };
    expect(json.roles).toHaveLength(2);
    expect(json.roles[1]?.name).toBe('Moderator');
  });
});

describe('POST /api/servers/{id}/roles', () => {
  it('rejects role icons outside the fixed allowlist', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['administrator']);
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Unsafe', icon: '<svg onload=alert(1)>', permissions: [] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
    expect(createRole).not.toHaveBeenCalled();
  });

  it('accepts a single-emoji role icon (Discord-style)', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['manage_roles']);
    getHighestRolePosition.mockResolvedValue(Number.POSITIVE_INFINITY);
    createRole.mockResolvedValue({
      id: 'role-emoji',
      serverId: SERVER_ID,
      name: 'Gamers',
      color: null,
      icon: '🎮',
      displaySeparately: false,
      position: 0,
      permissions: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Gamers', icon: '🎮', permissions: [] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(201);
    expect(createRole).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ icon: '🎮' }));
  });

  it('rejects a name-less body with 400', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['administrator']);
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ permissions: [] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
  });

  it('rejects unknown permission strings with 400', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['administrator']);
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Mod', permissions: ['nuke_server'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; unknown: string[] };
    expect(json.error).toMatch(/Unknown/);
    expect(json.unknown).toContain('nuke_server');
  });

  it('returns 403 when the caller lacks MANAGE_ROLES', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Mod', permissions: ['kick_members'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(403);
  });

  it('creates a role when the caller is the owner', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['administrator']);
    createRole.mockResolvedValue({
      id: 'role-new',
      serverId: SERVER_ID,
      name: 'Mod',
      color: '#3498db',
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    const { POST } = await loadListRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Mod', color: '#3498db', permissions: ['kick_members'] }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: SERVER_ID }) });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { role: { id: string; name: string } };
    expect(json.role.id).toBe('role-new');
    expect(createRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: SERVER_ID, name: 'Mod' })
    );
  });
});

describe('PATCH /api/servers/{id}/roles/{roleId}', () => {
  it('returns 403 when a non-owner member lacks MANAGE_ROLES', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getRoleById.mockResolvedValue({
      id: ROLE_ID,
      serverId: SERVER_ID,
      name: 'Mod',
      color: null,
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { PATCH } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles/${ROLE_ID}`, {
      method: 'PATCH',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Senior Mod' }),
    });
    const res = await PATCH(req, {
      params: Promise.resolve({ id: SERVER_ID, roleId: ROLE_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects renaming the @everyone role with 400', async () => {
    getServerById.mockResolvedValue(mockServer());
    getRoleById.mockResolvedValue({
      id: 'role-everyone',
      serverId: SERVER_ID,
      name: '@everyone',
      color: null,
      position: 0,
      permissions: ['view_channels'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['administrator']);
    const { PATCH } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles/role-everyone`, {
      method: 'PATCH',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Members' }),
    });
    const res = await PATCH(req, {
      params: Promise.resolve({ id: SERVER_ID, roleId: 'role-everyone' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/@everyone/);
  });

  it('renames a role when the caller is the owner', async () => {
    getServerById.mockResolvedValue(mockServer());
    getRoleById.mockResolvedValue({
      id: ROLE_ID,
      serverId: SERVER_ID,
      name: 'Mod',
      color: null,
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['administrator']);
    updateRole.mockResolvedValue({
      id: ROLE_ID,
      serverId: SERVER_ID,
      name: 'Senior Mod',
      color: null,
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    const { PATCH } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles/${ROLE_ID}`, {
      method: 'PATCH',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify({ name: 'Senior Mod' }),
    });
    const res = await PATCH(req, {
      params: Promise.resolve({ id: SERVER_ID, roleId: ROLE_ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { role: { name: string } };
    expect(json.role.name).toBe('Senior Mod');
  });
});

describe('DELETE /api/servers/{id}/roles/{roleId}', () => {
  it('returns 404 when the role does not exist', async () => {
    getServerById.mockResolvedValue(mockServer());
    getRoleById.mockResolvedValue(null);
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles/${ROLE_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, roleId: ROLE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects deleting the @everyone role with 400', async () => {
    getServerById.mockResolvedValue(mockServer());
    getRoleById.mockResolvedValue({
      id: 'role-everyone',
      serverId: SERVER_ID,
      name: '@everyone',
      color: null,
      position: 0,
      permissions: ['view_channels'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['administrator']);
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles/role-everyone`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, roleId: 'role-everyone' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 when a non-owner member lacks MANAGE_ROLES', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getRoleById.mockResolvedValue({
      id: ROLE_ID,
      serverId: SERVER_ID,
      name: 'Mod',
      color: null,
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles/${ROLE_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, roleId: ROLE_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('deletes a role when the caller is the owner', async () => {
    getServerById.mockResolvedValue(mockServer());
    getRoleById.mockResolvedValue({
      id: ROLE_ID,
      serverId: SERVER_ID,
      name: 'Mod',
      color: null,
      position: 0,
      permissions: ['kick_members'],
      createdAt: new Date('2026-06-10T00:00:00Z'),
    });
    getUserPermissions.mockResolvedValue(['administrator']);
    deleteRole.mockResolvedValue(undefined);
    const { DELETE } = await loadItemRoute();
    const req = new Request(`https://example.test/api/servers/${SERVER_ID}/roles/${ROLE_ID}`, {
      method: 'DELETE',
      headers: { cookie: makeSessionCookie() },
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ id: SERVER_ID, roleId: ROLE_ID }),
    });
    expect(res.status).toBe(200);
    expect(deleteRole).toHaveBeenCalledWith(expect.anything(), ROLE_ID);
  });
});
