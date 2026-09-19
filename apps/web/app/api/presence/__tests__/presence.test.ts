import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';
import { NextResponse } from 'next/server';

const requireMaterializedSession = vi.fn();
const requireServerMember = vi.fn();
const requireChannelInServer = vi.fn();
const setUserPresence = vi.fn();
const incrServerBandwidth = vi.fn();
const getUserPresenceInServer = vi.fn();
const publishPresenceChange = vi.fn();
const getServerById = vi.fn();
const isServerMember = vi.fn();
const getUserSettings = vi.fn();
const getBlockedUserIds = vi.fn();
const getUserPermissions = vi.fn();
const listVisibleChannelsForMember = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  requireMaterializedSession,
  requireServerMember,
  requireChannelInServer,
  requireVisibleChannelInServer: requireChannelInServer,
}));
vi.mock('@/lib/redis', () => ({
  setUserPresence,
  incrServerBandwidth,
  getUserPresenceInServer,
}));
vi.mock('@/lib/presence-bus', () => ({ publishPresenceChange }));
// beta-review: the REAL privacy projector runs here — the route's
// contract is what a viewer actually receives.
vi.mock('@lobbyforge/db', () => ({
  DEFAULT_USER_PRIVACY_SETTINGS: {
    profileVisibility: 'server_members',
    onlineStatusVisibility: 'server_members',
    activityVisibility: 'server_members',
    showCurrentGame: true,
    showMusicStatus: true,
    showWatchPartyStatus: true,
    showServerNameInActivity: false,
  },
  getServerById,
  isServerMember,
  getUserSettings,
  getBlockedUserIds,
  getUserPermissions,
  listVisibleChannelsForMember,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

async function loadRoute() {
  return import('../route.js');
}

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };
const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000002';
const UID = '00000000-0000-0000-0000-000000000099';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  requireMaterializedSession.mockReset();
  requireServerMember.mockReset();
  requireChannelInServer.mockReset();
  setUserPresence.mockReset();
  incrServerBandwidth.mockReset();
  getUserPresenceInServer.mockReset();
  publishPresenceChange.mockReset();
  getServerById.mockReset();
  isServerMember.mockReset();
  getUserSettings.mockReset();
  getBlockedUserIds.mockReset();
  getUserPermissions.mockReset().mockResolvedValue([]);
  listVisibleChannelsForMember.mockReset().mockResolvedValue([]);
  // Defaults for POST.
  requireMaterializedSession.mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_1', name: 'Owner', exp: 123 },
  });
  requireServerMember.mockResolvedValue({ ok: true });
  requireChannelInServer.mockResolvedValue({ ok: true });
  setUserPresence.mockResolvedValue(undefined);
  incrServerBandwidth.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeCookie(uid: string = UID): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

describe('POST /api/presence', () => {
  it('updates presence and publishes the change when the caller is a member', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/presence', {
        method: 'POST',
        body: JSON.stringify({ serverId: SERVER_ID, channelId: CHANNEL_ID }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(setUserPresence).toHaveBeenCalledWith(UID, SERVER_ID, CHANNEL_ID, 'online', 90, undefined);
    expect(publishPresenceChange).toHaveBeenCalled();
  });

  it('publishes a content-free signal — no status, channel, activity or user id (beta-review S5)', async () => {
    const { POST } = await loadRoute();
    await POST(
      new Request('https://example.test/api/presence', {
        method: 'POST',
        body: JSON.stringify({
          serverId: SERVER_ID,
          channelId: CHANNEL_ID,
          status: 'dnd',
          activity: { kind: 'game', label: 'Secret game', serverName: 'Hidden server' },
        }),
      }),
      {}
    );
    expect(publishPresenceChange).toHaveBeenCalledTimes(1);
    expect(publishPresenceChange).toHaveBeenCalledWith({ serverId: SERVER_ID });
  });

  it('forwards bandwidthDeltaBytes to incrServerBandwidth when present and positive', async () => {
    const { POST } = await loadRoute();
    await POST(
      new Request('https://example.test/api/presence', {
        method: 'POST',
        body: JSON.stringify({ serverId: SERVER_ID, channelId: CHANNEL_ID, bandwidthDeltaBytes: 12345 }),
      }),
      {}
    );
    expect(incrServerBandwidth).toHaveBeenCalledWith(SERVER_ID, 12345, expect.objectContaining({}));
  });

  it('does not call incrServerBandwidth when bandwidthDeltaBytes is absent', async () => {
    const { POST } = await loadRoute();
    await POST(
      new Request('https://example.test/api/presence', {
        method: 'POST',
        body: JSON.stringify({ serverId: SERVER_ID, channelId: CHANNEL_ID }),
      }),
      {}
    );
    expect(incrServerBandwidth).not.toHaveBeenCalled();
  });

  it('returns the denied response when the caller is not a server member', async () => {
    requireServerMember.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/presence', {
        method: 'POST',
        body: JSON.stringify({ serverId: SERVER_ID, channelId: CHANNEL_ID }),
      }),
      {}
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid body', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/presence', {
        method: 'POST',
        body: JSON.stringify({ serverId: 'not-a-uuid' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/presence', () => {
  it('returns 400 when serverId is missing', async () => {
    const { GET } = await loadRoute();
    const res = await GET(
      new Request('https://example.test/api/presence', { headers: { cookie: makeCookie() } }),
      {}
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the server does not exist', async () => {
    getServerById.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(
      new Request(`https://example.test/api/presence?serverId=${SERVER_ID}`, {
        headers: { cookie: makeCookie('00000000-0000-0000-0000-0000000000AA') },
      }),
      {}
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not the owner and not a member', async () => {
    getServerById.mockResolvedValue({ ownerUserId: '00000000-0000-0000-0000-0000000000BB' });
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadRoute();
    const res = await GET(
      new Request(`https://example.test/api/presence?serverId=${SERVER_ID}`, {
        headers: { cookie: makeCookie() },
      }),
      {}
    );
    expect(res.status).toBe(403);
  });

  it('returns the presence list for the server owner', async () => {
    getServerById.mockResolvedValue({ ownerUserId: UID });
    getUserPresenceInServer.mockResolvedValue([{ userId: UID, status: 'online', channelId: CHANNEL_ID, lastSeen: 1 }]);
    getBlockedUserIds.mockResolvedValue(new Set());
    getUserSettings.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(
      new Request(`https://example.test/api/presence?serverId=${SERVER_ID}`, {
        headers: { cookie: makeCookie() },
      }),
      {}
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { presences: unknown[] };
    expect(json.presences).toHaveLength(1);
  });

  it('returns 401 when no cookie is present', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request(`https://example.test/api/presence?serverId=${SERVER_ID}`), {});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/presence — beta-review F8 channel visibility + privacy', () => {
  const PRIVATE_CH = '00000000-0000-0000-0000-0000000000C1';
  const OTHER = '00000000-0000-0000-0000-0000000000D1';
  const OWNER = '00000000-0000-0000-0000-0000000000BB';

  async function getAs(uid: string) {
    const { GET } = await loadRoute();
    const res = await GET(
      new Request(`https://example.test/api/presence?serverId=${SERVER_ID}`, {
        headers: { cookie: makeCookie(uid) },
      }),
      {}
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { presences: Array<Record<string, unknown>> }).presences;
  }

  beforeEach(() => {
    getServerById.mockResolvedValue({ ownerUserId: OWNER });
    isServerMember.mockResolvedValue(true);
    getBlockedUserIds.mockResolvedValue(new Set());
    getUserSettings.mockResolvedValue(null);
    getUserPresenceInServer.mockResolvedValue([
      { userId: OTHER, status: 'online', channelId: PRIVATE_CH, lastSeen: 1 },
      { userId: OWNER, status: 'online', channelId: CHANNEL_ID, lastSeen: 1 },
      { userId: UID, status: 'online', channelId: PRIVATE_CH, lastSeen: 1 },
    ]);
  });

  it('strips channelId for channels the member cannot see (self keeps its own)', async () => {
    listVisibleChannelsForMember.mockResolvedValue([{ id: CHANNEL_ID }]);
    const presences = await getAs(UID);
    const byUser = new Map(presences.map((p) => [p.userId, p]));
    expect(byUser.get(OTHER)?.channelId).toBeNull();
    expect(byUser.get(OWNER)?.channelId).toBe(CHANNEL_ID);
    expect(byUser.get(UID)?.channelId).toBe(PRIVATE_CH);
    expect(listVisibleChannelsForMember).toHaveBeenCalledWith(expect.anything(), SERVER_ID, UID);
  });

  it('MANAGE_CHANNELS sees every channel (no visibility lookup)', async () => {
    getUserPermissions.mockResolvedValue(['manage_channels']);
    const presences = await getAs(UID);
    expect(presences.find((p) => p.userId === OTHER)?.channelId).toBe(PRIVATE_CH);
    expect(listVisibleChannelsForMember).not.toHaveBeenCalled();
  });

  it('the owner sees every channel', async () => {
    const presences = await getAs(OWNER);
    expect(presences.find((p) => p.userId === OTHER)?.channelId).toBe(PRIVATE_CH);
    expect(listVisibleChannelsForMember).not.toHaveBeenCalled();
  });

  it('applies the target user privacy settings (hidden status, no activity)', async () => {
    listVisibleChannelsForMember.mockResolvedValue([{ id: CHANNEL_ID }, { id: PRIVATE_CH }]);
    getUserPresenceInServer.mockResolvedValue([
      {
        userId: OTHER,
        status: 'dnd',
        channelId: CHANNEL_ID,
        lastSeen: 1,
        activity: { kind: 'game', label: 'Quiz', serverName: 'Secret' },
      },
    ]);
    getUserSettings.mockResolvedValue({
      privacy: {
        profileVisibility: 'server_members',
        onlineStatusVisibility: 'nobody',
        activityVisibility: 'nobody',
        showCurrentGame: true,
        showMusicStatus: true,
        showWatchPartyStatus: true,
        showServerNameInActivity: true,
      },
    });
    const [presence] = await getAs(UID);
    expect(presence?.status).toBe('hidden');
    expect(presence?.activity).toBeUndefined();
  });
});
