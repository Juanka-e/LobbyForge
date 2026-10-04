import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer — we test the route logic, not Drizzle.
const getServerById = vi.fn();
const getChannelById = vi.fn();
const isServerMember = vi.fn();
const getUserPermissions = vi.fn();
const createGameSession = vi.fn();
const getActiveGameSessionForChannel = vi.fn();
const getPluginInstall = vi.fn();
const getMemberRoleIds = vi.fn();
const listGameSessionsForChannel = vi.fn();
const getGameSessionById = vi.fn();
const setGameSessionState = vi.fn();
const setGameSessionStateCAS = vi.fn();
const endGameSession = vi.fn();
const listPlayersForSession = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);
const addPlayerToSession = vi.fn(async () => ({ id: 'player-row', sessionId: 'sess', userId: 'u' }));
const publishActivityStateChange = vi.fn();
// The session's write lock: the callback gets the row as it stands now.
const withGameSessionWriteLock = vi.fn(
  async (db: unknown, id: string, fn: (tx: unknown, row: unknown) => Promise<unknown>) =>
    fn(db, await getGameSessionById(db, id))
);
class GameSessionBusyError extends Error {}

// Mock the plugin-registry — the route uses `getPlugin` to look up the
// plugin by id; the tests pin a single fake plugin that echoes the
// action through to the next state.
const fakePlugin = {
  manifest: { id: 'fake', name: 'Fake', version: '0.1.0', type: 'game' as const, minAppVersion: '0.1.0', permissions: [], locales: ['en'], entryClient: './client.js' },
  // `inc` is anonymous (like a poll vote); `join` puts the actor on the roster.
  actionPolicies: {
    inc: { role: 'member' as const },
    join: { role: 'member' as const, joinsRoster: true },
  },
  createInitialState: () => ({ count: 0 }),
  handleAction: (_ctx: unknown, state: { count: number; full?: boolean }, action: { type: string; amount?: number }) => {
    if (action.type === 'inc') return { count: state.count + (action.amount ?? 1) };
    // A full table refuses the join: the SAME state comes back.
    if (action.type === 'join') return state.full ? state : { ...state, count: state.count + 1 };
    return state;
  },
  renderClient: () => null,
};
const getPluginServer = vi.fn((id: string) => (id === 'fake' ? fakePlugin : null));

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  getChannelById,
  addPlayerToSession,
  isServerMember,
  getUserPermissions,
  createGameSession,
  getActiveGameSessionForChannel,
  getPluginInstall,
  getMemberRoleIds,
  listGameSessionsForChannel,
  getGameSessionById,
  setGameSessionState,
  setGameSessionStateCAS,
  withGameSessionWriteLock,
  GameSessionBusyError,
  endGameSession,
  listPlayersForSession,
  logAction,
}));

vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange }));

vi.mock('@/lib/permissions', () => ({
  CorePermission: new Proxy({}, { get: (_t, key: string) => key }),
  hasPermission: (perms: string[], required: string) =>
    perms.includes('administrator') || perms.includes(required),
  authorizeServerPermission: async (_u: string, _s: string, _r: string) => ({ ok: true }),
  authorizeChannelVisibility: async () => ({ ok: true }),
  authorizeSessionChannelVisibility: async () => ({ ok: true }),
}));

vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer,
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
  getChannelById.mockReset();
  isServerMember.mockReset();
  getUserPermissions.mockReset();
  createGameSession.mockReset();
  getActiveGameSessionForChannel.mockReset();
  getPluginInstall.mockReset();
  listGameSessionsForChannel.mockReset();
  getGameSessionById.mockReset();
  setGameSessionState.mockReset();
  setGameSessionStateCAS.mockReset();
  endGameSession.mockReset();
  listPlayersForSession.mockReset();
  listPlayersForSession.mockResolvedValue([]);
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
  getChannelById.mockResolvedValue(mockChannel());
  getActiveGameSessionForChannel.mockResolvedValue(null);
  getPluginInstall.mockResolvedValue(mockPluginInstall());
  getMemberRoleIds.mockReset();
  getMemberRoleIds.mockResolvedValue([]);
  getPluginServer.mockReset();
  getPluginServer.mockImplementation((id: string) => (id === 'fake' ? fakePlugin : null));
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

async function loadSessionRoute() {
  return import('../../../../activities/[sessionId]/route.js');
}

async function loadActionRoute() {
  return import('../../../../activities/[sessionId]/actions/route.js');
}

async function loadEndRoute() {
  return import('../../../../activities/[sessionId]/end/route.js');
}

const SERVER_ID = 'srv-1';
const CHANNEL_ID = '00000000-0000-0000-0000-000000000010';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_ID = '00000000-0000-0000-0000-000000000099';
const SESSION_ID = '00000000-0000-0000-0000-000000000aaa';

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

function mockChannel(overrides: Partial<{ serverId: string; type: string }> = {}) {
  return {
    id: CHANNEL_ID,
    serverId: overrides.serverId ?? SERVER_ID,
    name: 'voice',
    type: overrides.type ?? 'voice',
    position: 0,
    pluginId: null,
    topic: null,
    createdAt: new Date('2026-06-11T00:00:00Z'),
  };
}

function mockSession(overrides: Partial<{
  serverId: string;
  channelId: string;
  pluginId: string;
  status: string;
  state: Record<string, unknown>;
  createdBy: string;
  endedAt: Date | null;
}> = {}) {
  return {
    id: SESSION_ID,
    serverId: overrides.serverId ?? SERVER_ID,
    channelId: overrides.channelId ?? CHANNEL_ID,
    pluginId: overrides.pluginId ?? 'fake',
    status: overrides.status ?? 'lobby',
    state: overrides.state ?? { count: 0 },
    publicSummary: {},
    createdBy: overrides.createdBy ?? USER_ID,
    createdAt: new Date('2026-06-11T00:00:00Z'),
    startedAt: null,
    endedAt: overrides.endedAt ?? null,
  };
}

function mockPluginInstall(overrides: Partial<{ enabled: boolean; settings: Record<string, unknown> }> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000abc',
    serverId: SERVER_ID,
    pluginId: 'fake',
    enabled: overrides.enabled ?? true,
    settings: overrides.settings ?? {},
    createdAt: new Date('2026-06-11T00:00:00Z'),
  };
}

// Security follow-up: the /apps allow-lists are enforced at start.
describe('POST /api/servers/{id}/channels/{channelId}/activities — app allow-lists', () => {
  const OTHER_CHANNEL = '00000000-0000-0000-0000-000000000011';
  const ROLE_GAMERS = '00000000-0000-0000-0000-0000000000b1';
  const ROLE_EVERYONE = '00000000-0000-0000-0000-0000000000b0';

  async function start() {
    const { POST } = await loadListRoute();
    return POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ pluginId: 'fake' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
  }

  beforeEach(() => {
    // The caller is a plain member (not the owner) with START_ACTIVITY.
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['start_activity']);
    createGameSession.mockResolvedValue(mockSession());
  });

  it('403 when the channel is not in a non-empty channel allow-list — for the owner too', async () => {
    getPluginInstall.mockResolvedValue(mockPluginInstall({ settings: { allowedChannelIds: [OTHER_CHANNEL] } }));
    const res = await start();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'app_channel_not_allowed' });

    getServerById.mockResolvedValue(mockServer(USER_ID));
    expect((await start()).status).toBe(403);
    expect(createGameSession).not.toHaveBeenCalled();
  });

  it('starts in a listed channel', async () => {
    getPluginInstall.mockResolvedValue(mockPluginInstall({ settings: { allowedChannelIds: [OTHER_CHANNEL, CHANNEL_ID] } }));
    expect((await start()).status).toBe(201);
  });

  it('403 when the starter holds none of the allowed roles', async () => {
    getPluginInstall.mockResolvedValue(mockPluginInstall({ settings: { allowedRoleIds: [ROLE_GAMERS] } }));
    getMemberRoleIds.mockResolvedValue([ROLE_EVERYONE]);
    const res = await start();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'app_role_not_allowed' });
    expect(getMemberRoleIds).toHaveBeenCalledWith(expect.anything(), SERVER_ID, USER_ID);
    expect(createGameSession).not.toHaveBeenCalled();
  });

  it('starts when the starter holds one of the allowed roles', async () => {
    getPluginInstall.mockResolvedValue(mockPluginInstall({ settings: { allowedRoleIds: [ROLE_GAMERS] } }));
    getMemberRoleIds.mockResolvedValue([ROLE_EVERYONE, ROLE_GAMERS]);
    expect((await start()).status).toBe(201);
  });

  it('lets the owner and administrators past the role allow-list', async () => {
    getPluginInstall.mockResolvedValue(mockPluginInstall({ settings: { allowedRoleIds: [ROLE_GAMERS] } }));
    getUserPermissions.mockResolvedValue(['administrator']);
    expect((await start()).status).toBe(201);

    getUserPermissions.mockResolvedValue(['start_activity']);
    getServerById.mockResolvedValue(mockServer(USER_ID));
    expect((await start()).status).toBe(201);
    expect(getMemberRoleIds).not.toHaveBeenCalled();
  });

  it('treats empty or malformed lists as no restriction', async () => {
    getPluginInstall.mockResolvedValue(
      mockPluginInstall({ settings: { allowedChannelIds: [], allowedRoleIds: 'not-a-list' } })
    );
    expect((await start()).status).toBe(201);
  });
});

describe('POST /api/servers/{id}/channels/{channelId}/activities', () => {
  it('returns 401 when there is no guest session', async () => {
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        body: JSON.stringify({ pluginId: 'fake' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller lacks START_ACTIVITY', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ pluginId: 'fake' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when the plugin is unknown', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['start_activity']);
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ pluginId: 'nonexistent' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when the app is not installed or enabled', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['start_activity']);
    getPluginInstall.mockResolvedValue(null);
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ pluginId: 'fake' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when the body is malformed', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['start_activity']);
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 when the channel already has an active activity', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['start_activity']);
    getActiveGameSessionForChannel.mockResolvedValue(mockSession());
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ pluginId: 'fake' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(409);
  });

  it('starts an activity and returns 201', async () => {
    getServerById.mockResolvedValue(mockServer());
    getUserPermissions.mockResolvedValue(['start_activity']);
    createGameSession.mockResolvedValue(mockSession());
    const { POST } = await loadListRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ pluginId: 'fake' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { activity: { id: string; pluginId: string } };
    expect(json.activity.id).toBe(SESSION_ID);
    expect(json.activity.pluginId).toBe('fake');
    expect(createGameSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: SERVER_ID,
        channelId: CHANNEL_ID,
        pluginId: 'fake',
        createdBy: USER_ID,
      })
    );
  });
});

describe('GET /api/servers/{id}/channels/{channelId}/activities', () => {
  it('returns 401 when there is no guest session', async () => {
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('returns the activity list to a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    listGameSessionsForChannel.mockResolvedValue([mockSession()]);
    const { GET } = await loadListRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/channels/${CHANNEL_ID}/activities`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, channelId: CHANNEL_ID }) }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { activities: { id: string; pluginId: string }[] };
    expect(json.activities[0]?.id).toBe(SESSION_ID);
    expect(json.activities[0]?.pluginId).toBe('fake');
  });
});

describe('GET /api/servers/{id}/activities/{sessionId}', () => {
  it('returns 404 when the session does not exist', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(null);
    const { GET } = await loadSessionRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the session belongs to a different server', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ serverId: 'srv-OTHER' }));
    const { GET } = await loadSessionRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('returns the session state to a member', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession());
    const { GET } = await loadSessionRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { activity: { id: string; state: { count: number } } };
    expect(json.activity.state).toEqual({ count: 0 });
  });
});

describe('POST /api/servers/{id}/activities/{sessionId}/actions', () => {
  it('returns 401 when there is no guest session', async () => {
    const { POST } = await loadActionRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/actions`, {
        method: 'POST',
        body: JSON.stringify({ type: 'inc' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when the body is malformed (no type)', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession());
    const { POST } = await loadActionRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/actions`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 when the session is for a plugin that is no longer registered', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ pluginId: 'gone' }));
    const { POST } = await loadActionRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/actions`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ type: 'inc' }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(409);
  });

  it('applies an action and persists the new state', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ state: { count: 0 } }));
    // CAS mock — returns ok with the new state.
    setGameSessionStateCAS.mockResolvedValue({
      ok: true,
      row: { ...mockSession({ state: { count: 3 } }), revision: 1 },
    });
    const { POST } = await loadActionRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/actions`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
        body: JSON.stringify({ type: 'inc', amount: 3 }),
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { activity: { state: { count: number } } };
    expect(json.activity.state).toEqual({ count: 3 });
    expect(setGameSessionStateCAS).toHaveBeenCalled();
  });

  function actionRequest(body: Record<string, unknown>) {
    return new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/actions`, {
      method: 'POST',
      headers: { cookie: makeSessionCookie() },
      body: JSON.stringify(body),
    });
  }

  function primeAction(state: Record<string, unknown>) {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ state }));
    setGameSessionStateCAS.mockResolvedValue({ ok: true, row: { ...mockSession({ state }), revision: 1 } });
    listPlayersForSession.mockResolvedValue([{ userId: 'someone-else', characterName: null }]);
    addPlayerToSession.mockClear();
    publishActivityStateChange.mockClear();
  }

  const published = () =>
    (publishActivityStateChange.mock.calls[0]?.[0] as { publicSummary?: Record<string, unknown> } | undefined)?.publicSummary;

  it('puts a first-time actor on the roster when a joining action succeeds', async () => {
    primeAction({ count: 0 });
    const { POST } = await loadActionRoute();
    const res = await POST(actionRequest({ type: 'join' }), { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(addPlayerToSession).toHaveBeenCalledTimes(1);
    expect(published()?.rosterChanged).toBe(true);
  });

  it('never puts the author of an anonymous action on the roster', async () => {
    // A poll vote must not name its voter: the roster is public.
    primeAction({ count: 0 });
    const { POST } = await loadActionRoute();
    const res = await POST(actionRequest({ type: 'inc', amount: 1 }), { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(addPlayerToSession).not.toHaveBeenCalled();
    expect(published()?.rosterChanged).toBeUndefined();
  });

  it('keeps a refused join off the roster', async () => {
    primeAction({ count: 0, full: true });
    const { POST } = await loadActionRoute();
    const res = await POST(actionRequest({ type: 'join' }), { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(addPlayerToSession).not.toHaveBeenCalled();
    expect(published()?.rosterChanged).toBeUndefined();
  });

  it('leaves the roster alone for someone already in it', async () => {
    primeAction({ count: 0 });
    listPlayersForSession.mockResolvedValue([{ userId: '00000000-0000-0000-0000-000000000001', characterName: null }]);
    const { POST } = await loadActionRoute();
    const res = await POST(actionRequest({ type: 'join' }), { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) });
    expect(res.status).toBe(200);
    expect(addPlayerToSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/servers/{id}/activities/{sessionId}/end', () => {
  it('returns 401 when there is no guest session', async () => {
    const { POST } = await loadEndRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/end`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the session does not exist', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(null);
    const { POST } = await loadEndRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/end`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is neither host nor admin', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ createdBy: '00000000-0000-0000-0000-0000000000bb' }));
    getUserPermissions.mockResolvedValue(['send_messages']);
    const { POST } = await loadEndRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/end`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('allows the host to end without START_ACTIVITY', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ createdBy: USER_ID }));
    endGameSession.mockResolvedValue({ ...mockSession(), status: 'ended', endedAt: new Date() });
    const { POST } = await loadEndRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/end`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(200);
    expect(endGameSession).toHaveBeenCalledWith(expect.anything(), SESSION_ID);
  });

  it('allows an admin (non-host) to end', async () => {
    getServerById.mockResolvedValue(mockServer(OWNER_ID));
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ createdBy: '00000000-0000-0000-0000-0000000000bb' }));
    getUserPermissions.mockResolvedValue(['start_activity']);
    endGameSession.mockResolvedValue({ ...mockSession(), status: 'ended', endedAt: new Date() });
    const { POST } = await loadEndRoute();
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/end`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(200);
    expect(endGameSession).toHaveBeenCalled();
  });
});
