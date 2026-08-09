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
const listGameSessionsForChannel = vi.fn();
const getGameSessionById = vi.fn();
const setGameSessionState = vi.fn();
const setGameSessionStateCAS = vi.fn();
const endGameSession = vi.fn();
const listPlayersForSession = vi.fn();
const logAction = vi.fn().mockResolvedValue(undefined);

// Mock the plugin-registry — the route uses `getPlugin` to look up the
// plugin by id; the tests pin a single fake plugin that echoes the
// action through to the next state.
const fakePlugin = {
  manifest: { id: 'fake', name: 'Fake', version: '0.1.0', type: 'game' as const, minAppVersion: '0.1.0', permissions: [], locales: ['en'], entryClient: './client.js' },
  createInitialState: () => ({ count: 0 }),
  handleAction: (_ctx: unknown, state: { count: number }, action: { type: string; amount?: number }) => {
    if (action.type === 'inc') return { count: state.count + (action.amount ?? 1) };
    return state;
  },
  renderClient: () => null,
};
const getPluginServer = vi.fn((id: string) => (id === 'fake' ? fakePlugin : null));

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  getChannelById,
  isServerMember,
  getUserPermissions,
  createGameSession,
  getActiveGameSessionForChannel,
  getPluginInstall,
  listGameSessionsForChannel,
  getGameSessionById,
  setGameSessionState,
  setGameSessionStateCAS,
  endGameSession,
  listPlayersForSession,
  logAction,
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

function mockPluginInstall(overrides: Partial<{ enabled: boolean }> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000abc',
    serverId: SERVER_ID,
    pluginId: 'fake',
    enabled: overrides.enabled ?? true,
    settings: {},
    createdAt: new Date('2026-06-11T00:00:00Z'),
  };
}

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
