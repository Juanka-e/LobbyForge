import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * GET /api/servers/{id}/members/{userId}/profile (docs/PROFILES.md):
 *  - access: viewer and subject must both be current members, else 404;
 *  - privacy: the lobby's projection (`projectMemberProfile`) — a hidden
 *    profile keeps names, roles and the Guest tag only;
 *  - blocks either way: the same small payload, no presence;
 *  - presence through the presence projection (hidden / stale → offline);
 *  - `viewerCan` follows the moderation gate: permission, hierarchy,
 *    owner protection, timed-out actors, and the role route's grant rules.
 */

const dbFns = {
  DEFAULT_USER_PRIVACY_SETTINGS: {
    profileVisibility: 'server_members',
    onlineStatusVisibility: 'server_members',
    activityVisibility: 'server_members',
    showCurrentGame: true,
    showMusicStatus: true,
    showWatchPartyStatus: true,
    showServerNameInActivity: false,
  },
  getActiveMemberTimeout: vi.fn(),
  getHighestRolePosition: vi.fn(),
  getMemberProfileRecord: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  getUserSettings: vi.fn(),
  isServerMember: vi.fn(),
  isUserBlocked: vi.fn(),
  listMutualServers: vi.fn(),
  listRolesForServer: vi.fn(),
  // Imported by lib/api-auth; never reached here.
  getChannelById: vi.fn(),
};

vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
vi.mock('@/lib/permissions', () => ({ authorizeChannelVisibility: vi.fn() }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
const getUserPresenceInServerForUser = vi.fn();
vi.mock('@/lib/redis', () => ({ getUserPresenceInServerForUser }));
/** Channels the viewer may see; null = every channel (owner / Manage Channels). */
const resolveVisibleChannelIds = vi.fn();
vi.mock('@/lib/presence-view', () => ({ resolveVisibleChannelIds }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '00000000-0000-4000-8000-0000000000a0';
const MOD = '00000000-0000-4000-8000-0000000000a1';
const VIEWER = '00000000-0000-4000-8000-0000000000a2';
const MEMBER = '00000000-0000-4000-8000-0000000000a3';
const STRANGER = '00000000-0000-4000-8000-0000000000a4';

const EVERYONE = { id: 'r-everyone', name: '@everyone', color: null, icon: null, position: 0, permissions: ['send_messages', 'connect_voice'] };
const VETERAN = { id: 'r-veteran', name: 'Veteran', color: '#22aa66', icon: 'star', position: 5, permissions: [] };
const LOW_ADMIN = { id: 'r-low-admin', name: 'Sneaky', color: null, icon: null, position: 2, permissions: ['administrator'] };
const HELPER = { id: 'r-helper', name: 'Helper', color: '#3366ff', icon: null, position: 3, permissions: ['kick_members'] };
const MODS = { id: 'r-mods', name: 'Mods', color: '#ff8800', icon: 'shield', position: 10, permissions: ['kick_members', 'ban_members', 'moderate_members', 'manage_roles', 'mute_members'] };
const ADMINS = { id: 'r-admins', name: 'Admins', color: '#ff0000', icon: null, position: 20, permissions: ['administrator'] };
const SERVER_ROLES = [EVERYONE, LOW_ADMIN, HELPER, VETERAN, MODS, ADMINS];

const POSITIONS: Record<string, number> = { [OWNER]: Number.POSITIVE_INFINITY, [MOD]: 10, [VIEWER]: 0, [MEMBER]: 5 };
const PERMISSIONS: Record<string, string[]> = {
  [OWNER]: ['administrator'],
  [MOD]: MODS.permissions,
  [VIEWER]: ['send_messages'],
  [MEMBER]: ['send_messages'],
};

function record(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    globalDisplayName: 'Ayşe Global',
    nickname: 'Ace',
    avatarRef: '0123456789ab',
    bannerRef: 'abcdefabcdef',
    profileVisibility: 'server_members',
    isGuest: false,
    statusText: 'secret-status-text',
    bio: 'secret-bio-text',
    accountCreatedAt: new Date('2025-01-02T03:04:05Z'),
    joinedAt: new Date('2026-02-03T04:05:06Z'),
    timedOutUntil: null,
    voiceMuted: false,
    roles: [VETERAN, EVERYONE],
    ...overrides,
  };
}

let records: Record<string, ReturnType<typeof record> | null>;

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) if (typeof fn === 'function') fn.mockReset();
  getUserPresenceInServerForUser.mockReset();
  resolveVisibleChannelIds.mockReset().mockResolvedValue(null);
  records = {
    [OWNER]: record(OWNER, { roles: [EVERYONE], nickname: null, globalDisplayName: 'Olivia' }),
    [MOD]: record(MOD, { roles: [MODS, EVERYONE] }),
    [VIEWER]: record(VIEWER, { roles: [EVERYONE] }),
    [MEMBER]: record(MEMBER),
  };
  dbFns.getServerById.mockResolvedValue({ id: SERVER, ownerUserId: OWNER });
  dbFns.isServerMember.mockImplementation(async (_db: unknown, userId: string) => userId !== STRANGER);
  dbFns.getMemberProfileRecord.mockImplementation(async (_db: unknown, _s: string, userId: string) => records[userId] ?? null);
  dbFns.isUserBlocked.mockResolvedValue(false);
  dbFns.getUserSettings.mockResolvedValue(null);
  dbFns.getUserPermissions.mockImplementation(async (_db: unknown, userId: string) => PERMISSIONS[userId] ?? []);
  dbFns.getActiveMemberTimeout.mockResolvedValue(null);
  dbFns.getHighestRolePosition.mockImplementation(async (_db: unknown, _s: string, userId: string) => POSITIONS[userId] ?? -1);
  dbFns.listMutualServers.mockResolvedValue({
    servers: [
      { id: SERVER, name: 'Here', iconUrl: null },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Elsewhere', iconUrl: 'https://cdn.example/e.png' },
    ],
    total: 2,
  });
  dbFns.listRolesForServer.mockResolvedValue(SERVER_ROLES);
  getUserPresenceInServerForUser.mockResolvedValue({ userId: MEMBER, status: 'idle', channelId: 'ch-1', lastSeen: Date.now() });
  dbFns.getChannelById.mockImplementation(async (_db: unknown, id: string) =>
    id === 'ch-voice' ? { id, serverId: SERVER, type: 'voice' } : id === 'ch-1' ? { id, serverId: SERVER, type: 'text' } : null
  );
});

async function get(viewer: string | null, target: string = MEMBER, serverId: string = SERVER): Promise<Response> {
  const { GET } = await import('../route.js');
  const handler = GET as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const headers: Record<string, string> = {};
  if (viewer) {
    const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: viewer, name: 'T' };
    headers.cookie = `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
  }
  return handler(
    new Request(`http://localhost/api/servers/${serverId}/members/${target}/profile`, { headers }),
    { params: Promise.resolve({ id: serverId, userId: target }) }
  );
}

interface Body {
  profile: Record<string, unknown> & { roles: Array<{ id: string; name: string }> };
  viewerCan: {
    isSelf: boolean;
    message: boolean;
    kick: boolean;
    ban: boolean;
    timeout: boolean;
    serverMute: boolean;
    manageRoles: boolean;
    assignableRoles: Array<{ id: string }>;
    removableRoleIds: string[];
    currentRoleIds: string[];
  };
}

async function body(res: Response): Promise<Body> {
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

describe('access', () => {
  it('401 without a session', async () => {
    expect((await get(null)).status).toBe(401);
  });

  it('the same 404 for a missing server, a non-member viewer, a non-member subject and malformed ids', async () => {
    dbFns.getServerById.mockResolvedValueOnce(null);
    const missing = await get(VIEWER);
    const stranger = await get(STRANGER);
    const notMember = await get(VIEWER, STRANGER);
    const malformed = await get(VIEWER, 'not-a-uuid');
    const responses = [missing, stranger, notMember, malformed];
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    // A stranger never gets as far as reading anyone's profile.
    expect(dbFns.getMemberProfileRecord).toHaveBeenCalledTimes(1);
    expect(dbFns.getMemberProfileRecord).toHaveBeenCalledWith(expect.anything(), SERVER, STRANGER);
  });

  it('the owner may look even without a membership row', async () => {
    dbFns.isServerMember.mockImplementation(async (_db: unknown, userId: string) => userId !== OWNER);
    expect((await get(OWNER)).status).toBe(200);
  });
});

describe('profile fields and privacy', () => {
  it('a visible profile: names, versioned images, about, roles without @everyone, dates and mutual communities', async () => {
    const { profile } = await body(await get(VIEWER));
    expect(profile).toMatchObject({
      userId: MEMBER,
      displayName: 'Ace',
      globalDisplayName: 'Ayşe Global',
      nickname: 'Ace',
      avatarUrl: `/api/users/${MEMBER}/avatar?v=0123456789ab`,
      bannerUrl: `/api/users/${MEMBER}/banner?v=abcdefabcdef`,
      isGuest: false,
      statusText: 'secret-status-text',
      bio: 'secret-bio-text',
      presence: 'idle',
      memberSince: '2026-02-03T04:05:06.000Z',
      accountCreatedAt: '2025-01-02T03:04:05.000Z',
      mutualServerCount: 2,
      blockedByMe: false,
      limited: false,
      isOwner: false,
      timedOutUntil: null,
    });
    expect(profile.roles).toEqual([{ id: VETERAN.id, name: 'Veteran', color: '#22aa66', icon: 'star', position: 5 }]);
    expect(JSON.stringify(profile)).not.toContain('permissions');
    expect(dbFns.listMutualServers).toHaveBeenCalledWith(expect.anything(), VIEWER, MEMBER, { limit: 50 });
  });

  it('no nickname: the display name is the account name', async () => {
    records[MEMBER] = record(MEMBER, { nickname: null });
    const { profile } = await body(await get(VIEWER));
    expect(profile).toMatchObject({ displayName: 'Ayşe Global', nickname: null });
  });

  it('a hidden profile ("nobody") keeps only names, roles and the Guest tag — for the owner too', async () => {
    records[MEMBER] = record(MEMBER, { profileVisibility: 'nobody', isGuest: true });
    for (const viewer of [VIEWER, OWNER]) {
      const res = await get(viewer);
      const { profile } = await body(res.clone());
      expect(profile).toMatchObject({
        displayName: 'Ace',
        globalDisplayName: 'Ayşe Global',
        avatarUrl: null,
        bannerUrl: null,
        statusText: null,
        bio: null,
        memberSince: null,
        accountCreatedAt: null,
        mutualServers: [],
        mutualServerCount: 0,
        isGuest: true,
        limited: true,
      });
      expect(profile.roles.map((r) => r.id)).toEqual([VETERAN.id]);
      // Nothing the lobby's projection hides is anywhere in the answer.
      const raw = await res.text();
      for (const secret of ['secret-bio-text', 'secret-status-text', '0123456789ab', 'abcdefabcdef', '2026-02-03', '2025-01-02']) {
        expect(raw).not.toContain(secret);
      }
    }
    expect(dbFns.listMutualServers).not.toHaveBeenCalled();
  });

  it('"server members" is enough: the viewer shares this server', async () => {
    records[MEMBER] = record(MEMBER, { profileVisibility: 'server_members' });
    expect((await body(await get(VIEWER))).profile.limited).toBe(false);
  });

  it('you always see your own profile, hidden or not, without mutual communities', async () => {
    records[VIEWER] = record(VIEWER, { profileVisibility: 'nobody', roles: [EVERYONE] });
    const { profile, viewerCan } = await body(await get(VIEWER, VIEWER));
    expect(profile).toMatchObject({ bio: 'secret-bio-text', limited: false, mutualServers: [], mutualServerCount: 0 });
    expect(viewerCan).toMatchObject({ isSelf: true, message: false, kick: false, ban: false, timeout: false, serverMute: false, manageRoles: false });
    expect(dbFns.isUserBlocked).not.toHaveBeenCalled();
    expect(dbFns.listMutualServers).not.toHaveBeenCalled();
  });
});

describe('blocks', () => {
  it('the viewer blocked the member: small payload, no presence, no message box', async () => {
    dbFns.isUserBlocked.mockImplementation(async (_db: unknown, blocker: string) => blocker === VIEWER);
    const res = await get(VIEWER);
    const { profile, viewerCan } = await body(res.clone());
    expect(profile).toMatchObject({
      blockedByMe: true,
      limited: true,
      presence: null,
      bio: null,
      statusText: null,
      bannerUrl: null,
      memberSince: null,
      mutualServers: [],
      // The avatar the privacy setting allows stays (projectBlockedUser's rule).
      avatarUrl: `/api/users/${MEMBER}/avatar?v=0123456789ab`,
    });
    expect(viewerCan.message).toBe(false);
    expect(getUserPresenceInServerForUser).not.toHaveBeenCalled();
    expect(dbFns.listMutualServers).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain('secret-bio-text');
  });

  it('the member blocked the viewer: the same small payload, and nothing tells it apart from a hidden profile', async () => {
    dbFns.isUserBlocked.mockImplementation(async (_db: unknown, blocker: string) => blocker === MEMBER);
    const res = await get(VIEWER);
    const { profile, viewerCan } = await body(res.clone());
    expect(profile).toMatchObject({ blockedByMe: false, limited: true, bio: null, statusText: null, memberSince: null });
    // Like the member list (the presence feed drops only users YOU blocked)…
    expect(profile.presence).toBe('idle');
    // …and the message box stays: the DM route refuses, as it always did.
    expect(viewerCan.message).toBe(true);
    const raw = await res.text();
    expect(raw).not.toMatch(/blockedMe|blockedBy"|blockedViewer/);

    // The same member with a hidden profile instead, and no block: the same answer.
    dbFns.isUserBlocked.mockResolvedValue(false);
    records[MEMBER] = record(MEMBER, { profileVisibility: 'nobody' });
    const hidden = await body(await get(VIEWER));
    expect({ ...hidden.profile }).toEqual({ ...profile });
    expect(hidden.viewerCan).toEqual(viewerCan);
  });

  it('a block does not take moderation away: a blocked moderator can still act', async () => {
    dbFns.isUserBlocked.mockImplementation(async (_db: unknown, blocker: string) => blocker === MEMBER);
    const { viewerCan } = await body(await get(MOD));
    expect(viewerCan).toMatchObject({ kick: true, ban: true, timeout: true, message: true });
  });
});

describe('presence', () => {
  it('follows the online-status privacy, the heartbeat age and the invisible status', async () => {
    dbFns.getUserSettings.mockResolvedValueOnce({ privacy: { ...dbFns.DEFAULT_USER_PRIVACY_SETTINGS, onlineStatusVisibility: 'nobody' } });
    expect((await body(await get(VIEWER))).profile.presence).toBe('offline');

    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: MEMBER, status: 'dnd', channelId: 'c', lastSeen: Date.now() - 120_000 });
    expect((await body(await get(VIEWER))).profile.presence).toBe('offline');

    getUserPresenceInServerForUser.mockResolvedValueOnce(null);
    expect((await body(await get(VIEWER))).profile.presence).toBe('offline');

    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: MEMBER, status: 'offline', channelId: 'c', lastSeen: Date.now() });
    expect((await body(await get(VIEWER))).profile.presence).toBe('offline');

    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: MEMBER, status: 'dnd', channelId: 'c', lastSeen: Date.now() });
    expect((await body(await get(VIEWER))).profile.presence).toBe('dnd');
  });

  it('a hidden online status still shows to yourself', async () => {
    dbFns.getUserSettings.mockResolvedValueOnce({ privacy: { ...dbFns.DEFAULT_USER_PRIVACY_SETTINGS, onlineStatusVisibility: 'nobody' } });
    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: VIEWER, status: 'dnd', channelId: 'c', lastSeen: Date.now() });
    expect((await body(await get(VIEWER, VIEWER))).profile.presence).toBe('dnd');
  });

  it('Redis down: offline, not an error', async () => {
    getUserPresenceInServerForUser.mockRejectedValueOnce(new Error('down'));
    expect((await body(await get(VIEWER))).profile.presence).toBe('offline');
  });
});

describe('in voice', () => {
  it('true in a voice room the viewer can see, false in a text channel', async () => {
    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: MEMBER, status: 'dnd', channelId: 'ch-voice', lastSeen: Date.now() });
    expect((await body(await get(VIEWER))).profile).toMatchObject({ presence: 'dnd', inVoice: true });
    expect((await body(await get(VIEWER))).profile).toMatchObject({ presence: 'idle', inVoice: false });
  });

  it('false in a voice room the viewer cannot see, for a hidden status, Invisible and a block', async () => {
    resolveVisibleChannelIds.mockResolvedValueOnce(new Set(['ch-1']));
    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: MEMBER, status: 'online', channelId: 'ch-voice', lastSeen: Date.now() });
    expect((await body(await get(VIEWER))).profile).toMatchObject({ presence: 'online', inVoice: false });

    dbFns.getUserSettings.mockResolvedValueOnce({ privacy: { ...dbFns.DEFAULT_USER_PRIVACY_SETTINGS, onlineStatusVisibility: 'nobody' } });
    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: MEMBER, status: 'online', channelId: 'ch-voice', lastSeen: Date.now() });
    expect((await body(await get(VIEWER))).profile).toMatchObject({ presence: 'offline', inVoice: false });

    getUserPresenceInServerForUser.mockResolvedValueOnce({ userId: MEMBER, status: 'offline', channelId: 'ch-voice', lastSeen: Date.now() });
    expect((await body(await get(VIEWER))).profile).toMatchObject({ presence: 'offline', inVoice: false });

    dbFns.isUserBlocked.mockImplementation(async (_db: unknown, blocker: string) => blocker === VIEWER);
    getUserPresenceInServerForUser.mockResolvedValue({ userId: MEMBER, status: 'online', channelId: 'ch-voice', lastSeen: Date.now() });
    expect((await body(await get(VIEWER))).profile).toMatchObject({ presence: null, inVoice: false });
  });
});

describe('viewerCan', () => {
  it('a plain member may do nothing to another member but message them', async () => {
    const { viewerCan } = await body(await get(VIEWER));
    expect(viewerCan).toEqual({
      isSelf: false,
      message: true,
      kick: false,
      ban: false,
      timeout: false,
      serverMute: false,
      manageRoles: false,
      assignableRoles: [],
      removableRoleIds: [],
      currentRoleIds: [],
    });
    expect(dbFns.listRolesForServer).not.toHaveBeenCalled();
  });

  it('a moderator above the member: every action, and only roles below them that they could grant', async () => {
    const { viewerCan } = await body(await get(MOD));
    expect(viewerCan).toMatchObject({ kick: true, ban: true, timeout: true, serverMute: true, manageRoles: true });
    // Not @everyone, not held (Veteran), not at/above the moderator (Mods, Admins),
    // not carrying a permission they lack (Sneaky has administrator).
    expect(viewerCan.assignableRoles.map((r) => r.id)).toEqual([HELPER.id]);
    expect(viewerCan.removableRoleIds).toEqual([VETERAN.id]);
    expect(viewerCan.currentRoleIds).toEqual([VETERAN.id, EVERYONE.id]);
  });

  it('equal rank cannot act on equal rank', async () => {
    POSITIONS[MEMBER] = 10;
    try {
      const { viewerCan } = await body(await get(MOD));
      expect(viewerCan).toMatchObject({ kick: false, ban: false, timeout: false, serverMute: false, manageRoles: false, assignableRoles: [] });
    } finally {
      POSITIONS[MEMBER] = 5;
    }
  });

  it('nobody acts on the owner — and the card says who owns the community', async () => {
    const { profile, viewerCan } = await body(await get(MOD, OWNER));
    expect(profile.isOwner).toBe(true);
    expect(viewerCan).toMatchObject({ kick: false, ban: false, timeout: false, serverMute: false, manageRoles: false });
  });

  it('the owner may do everything to a member and hand out any role', async () => {
    const { viewerCan } = await body(await get(OWNER));
    expect(viewerCan).toMatchObject({ kick: true, ban: true, timeout: true, serverMute: true, manageRoles: true });
    expect(viewerCan.assignableRoles.map((r) => r.id)).toEqual([ADMINS.id, MODS.id, HELPER.id, LOW_ADMIN.id]);
    // The owner is never asked for a timeout of their own.
    expect(dbFns.getActiveMemberTimeout).not.toHaveBeenCalled();
  });

  it('a timed-out moderator may do nothing', async () => {
    dbFns.getActiveMemberTimeout.mockImplementation(async (_db: unknown, _s: string, userId: string) =>
      userId === MOD ? new Date(Date.now() + 60_000) : null
    );
    const { viewerCan } = await body(await get(MOD));
    expect(viewerCan).toMatchObject({ kick: false, ban: false, timeout: false, serverMute: false, manageRoles: false, assignableRoles: [], removableRoleIds: [] });
  });

  it('each permission on its own', async () => {
    PERMISSIONS[MOD] = ['kick_members'];
    try {
      const { viewerCan } = await body(await get(MOD));
      expect(viewerCan).toMatchObject({ kick: true, ban: false, timeout: false, serverMute: false, manageRoles: false });
    } finally {
      PERMISSIONS[MOD] = MODS.permissions;
    }
  });

  it('an active timeout is shown only to viewers who may time the member out', async () => {
    const until = new Date(Date.now() + 10 * 60_000);
    records[MEMBER] = record(MEMBER, { timedOutUntil: until });
    expect((await body(await get(VIEWER))).profile.timedOutUntil).toBeNull();
    expect((await body(await get(MOD))).profile.timedOutUntil).toBe(until.toISOString());
    records[MEMBER] = record(MEMBER, { timedOutUntil: new Date(Date.now() - 1000) });
    expect((await body(await get(MOD))).profile.timedOutUntil).toBeNull();
  });
});
