import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Role-gated channel visibility (0028) — route contract:
 *  - GET /channels filters gated channels for plain members; the owner
 *    and MANAGE_CHANNELS see everything.
 *  - PATCH /channels/[channelId] accepts visibleToRoleIds (server-owned
 *    roles validated; foreign ids 400) and persists via the query layer.
 */

const dbFns = {
  createChannel: vi.fn(),
  getChannelById: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  listChannelsForServer: vi.fn(),
  listVisibleChannelsForMember: vi.fn(),
  listRolesBriefForServer: vi.fn(),
  setChannelRoleOverrides: vi.fn(),
  updateChannel: vi.fn(),
  logAction: vi.fn(),
};

vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

const SECRET = 'x'.repeat(32);
const SERVER_ID = 'srv-1';
const OWNER = '00000000-0000-0000-0000-000000000001';
const MEMBER = '00000000-0000-0000-0000-000000000002';
const CHANNEL_ID = '11111111-2222-3333-4444-555555555555';
const ROLE_ID = '66666666-7777-8888-9999-000000000000';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  dbFns.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER });
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getUserPermissions.mockResolvedValue([]);
  dbFns.logAction.mockResolvedValue(undefined);
  dbFns.listChannelsForServer.mockResolvedValue([
    { id: 'open', serverId: SERVER_ID, name: 'open', type: 'text', position: 0, pluginId: null, topic: null, createdAt: new Date() },
    { id: 'vip-only', serverId: SERVER_ID, name: 'vip', type: 'text', position: 1, pluginId: null, topic: null, createdAt: new Date() },
  ]);
  dbFns.listVisibleChannelsForMember.mockResolvedValue([
    { id: 'open', serverId: SERVER_ID, name: 'open', type: 'text', position: 0, pluginId: null, topic: null, createdAt: new Date() },
  ]);
});

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'T' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

describe('GET /api/servers/{id}/channels — visibility filtering', () => {
  it('plain member gets the FILTERED list (query layer)', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://e.test/api/servers/${SERVER_ID}/channels`, { headers: { cookie: cookie(MEMBER) } }),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    expect(dbFns.listVisibleChannelsForMember).toHaveBeenCalledWith(expect.anything(), SERVER_ID, MEMBER);
    expect(dbFns.listChannelsForServer).not.toHaveBeenCalled();
    const body = (await res.json()) as { channels: Array<{ id: string }> };
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]!.id).toBe('open');
  });

  it('the owner sees EVERYTHING (full list, no filtering)', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://e.test/api/servers/${SERVER_ID}/channels`, { headers: { cookie: cookie(OWNER) } }),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    expect(dbFns.listChannelsForServer).toHaveBeenCalled();
    expect(dbFns.listVisibleChannelsForMember).not.toHaveBeenCalled();
    const body = (await res.json()) as { channels: Array<{ id: string }> };
    expect(body.channels).toHaveLength(2);
  });

  it('MANAGE_CHANNELS members also see everything', async () => {
    dbFns.getUserPermissions.mockResolvedValue(['manage_channels']);
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://e.test/api/servers/${SERVER_ID}/channels`, { headers: { cookie: cookie(MEMBER) } }),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    expect(dbFns.listChannelsForServer).toHaveBeenCalled();
  });
});

describe('PATCH /api/servers/{id}/channels/[channelId] — visibleToRoleIds', () => {
  function channelRow() {
    return { id: CHANNEL_ID, serverId: SERVER_ID, name: 'vip', type: 'text', position: 1, pluginId: null, topic: null, createdAt: new Date() };
  }

  it('persists the override set for a server-owned role', async () => {
    dbFns.getChannelById.mockResolvedValue(channelRow());
    dbFns.getUserPermissions.mockResolvedValue(['manage_channels']);
    dbFns.updateChannel.mockResolvedValue(channelRow());
    dbFns.listRolesBriefForServer.mockResolvedValue([{ id: ROLE_ID, name: 'VIP', position: 5 }]);
    const { PATCH } = await import('../[channelId]/route.js');
    const res = await PATCH(
      new Request(`https://e.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: cookie(OWNER) },
        body: JSON.stringify({ visibleToRoleIds: [ROLE_ID] }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(200);
    expect(dbFns.setChannelRoleOverrides).toHaveBeenCalledWith(expect.anything(), CHANNEL_ID, [ROLE_ID]);
  });

  it('400 when a role belongs to a different server', async () => {
    dbFns.getChannelById.mockResolvedValue(channelRow());
    dbFns.getUserPermissions.mockResolvedValue(['manage_channels']);
    dbFns.updateChannel.mockResolvedValue(channelRow());
    dbFns.listRolesBriefForServer.mockResolvedValue([{ id: ROLE_ID, name: 'VIP', position: 5 }]);
    const { PATCH } = await import('../[channelId]/route.js');
    const res = await PATCH(
      new Request(`https://e.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: cookie(OWNER) },
        body: JSON.stringify({ visibleToRoleIds: ['foreign-role'] }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(400);
    expect(dbFns.setChannelRoleOverrides).not.toHaveBeenCalled();
  });

  it('[] clears the overrides (channel returns to everyone)', async () => {
    dbFns.getChannelById.mockResolvedValue(channelRow());
    dbFns.getUserPermissions.mockResolvedValue(['manage_channels']);
    dbFns.updateChannel.mockResolvedValue(channelRow());
    dbFns.listRolesBriefForServer.mockResolvedValue([]);
    const { PATCH } = await import('../[channelId]/route.js');
    const res = await PATCH(
      new Request(`https://e.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: cookie(OWNER) },
        body: JSON.stringify({ visibleToRoleIds: [] }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(200);
    expect(dbFns.setChannelRoleOverrides).toHaveBeenCalledWith(expect.anything(), CHANNEL_ID, []);
  });
});
