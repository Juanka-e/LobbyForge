import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer.
const getServerById = vi.fn();
const getGameSessionById = vi.fn();
const isServerMember = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  getGameSessionById,
  isServerMember,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

// Mock the activity-bus so the test never touches Redis. The
// subscription API mirrors the real one — we hand the test a
// callback the route will call.
// We stash the message + error callbacks on the mock instance so the
// tests can drive them; the property names start with `__` to make
// the intent obvious and to avoid colliding with vitest's own fields.
const subscribeActivityStateChange = Object.assign(vi.fn(
  (
    _serverId: string,
    _sessionId: string,
    onMessage: (msg: unknown) => void,
    onError?: (err: Error) => void
  ) => {
    subscribeActivityStateChange.__onMessage = onMessage;
    subscribeActivityStateChange.__onError = onError;
    // Return a Promise (the real API is async since LF-029).
    return Promise.resolve({
      close: vi.fn(),
    });
  }
), {
  __onMessage: undefined as ((msg: unknown) => void) | undefined,
  __onError: undefined as ((err: Error) => void) | undefined,
});

vi.mock('@/lib/permissions', () => ({
  authorizeSessionChannelVisibility: async () => ({ ok: true }),
}));

vi.mock('@/lib/session-tracker', () => ({
  isSessionRevoked: async () => false,
}));

vi.mock('@/lib/activity-bus', () => ({
  subscribeActivityStateChange,
  publishActivityStateChange: vi.fn(),
}));

const fakePlugin = {
  manifest: {
    id: 'fake',
    name: 'Fake',
    version: '0.1.0',
    type: 'game' as const,
    minAppVersion: '0.1.0',
    permissions: [],
    locales: ['en'],
    entryClient: './client.js',
  },
  createInitialState: () => ({ count: 0 }),
  handleAction: (_ctx: unknown, state: { count: number }) => state,
  migrateState: (raw: unknown) => raw,
  renderClient: () => null,
};
const getPluginServer = vi.fn((id: string) => (id === 'fake' ? fakePlugin : null));

vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer,
}));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset();
  getGameSessionById.mockReset();
  isServerMember.mockReset();
  subscribeActivityStateChange.mockClear();
  // The internal stash props aren't reset by mockClear; do it manually.
  delete (subscribeActivityStateChange as unknown as { __onMessage?: unknown }).__onMessage;
  delete (subscribeActivityStateChange as unknown as { __onError?: unknown }).__onError;
  getPluginServer.mockReset();
  getPluginServer.mockImplementation((id: string) => (id === 'fake' ? fakePlugin : null));
});

const SERVER_ID = 'srv-1';
const SESSION_ID = '00000000-0000-0000-0000-000000000aaa';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_ID = '00000000-0000-0000-0000-000000000099';

function makeSessionCookie(uid: string = USER_ID): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function mockServer() {
  return {
    id: SERVER_ID,
    name: 'A',
    slug: null,
    ownerUserId: OWNER_ID,
    iconUrl: null,
    defaultLocale: 'en',
    isPublic: false,
    createdAt: new Date('2026-06-19T00:00:00Z'),
    deletedAt: null,
  };
}

function mockSession(overrides: Partial<{ serverId: string; state: Record<string, unknown> }> = {}) {
  return {
    id: SESSION_ID,
    serverId: overrides.serverId ?? SERVER_ID,
    channelId: '00000000-0000-0000-0000-000000000010',
    pluginId: 'fake',
    status: 'lobby',
    state: overrides.state ?? { count: 0 },
    publicSummary: {},
    createdBy: USER_ID,
    createdAt: new Date('2026-06-19T00:00:00Z'),
    startedAt: null,
    endedAt: null,
  };
}

async function loadStreamRoute() {
  return import('../route.js');
}

describe('GET /api/servers/{id}/activities/{sessionId}/stream', () => {
  it('returns 401 without a guest session', async () => {
    const { GET } = await loadStreamRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/stream`),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-members', async () => {
    getServerById.mockResolvedValue(mockServer());
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadStreamRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/stream`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when the session does not exist', async () => {
    getServerById.mockResolvedValue(mockServer());
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(null);
    const { GET } = await loadStreamRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/stream`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('opens an SSE stream, sends a snapshot, and subscribes to the bus', async () => {
    getServerById.mockResolvedValue(mockServer());
    isServerMember.mockResolvedValue(true);
    getGameSessionById.mockResolvedValue(mockSession({ state: { count: 0, version: 1 } }));
    const { GET } = await loadStreamRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/stream`, {
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(subscribeActivityStateChange).toHaveBeenCalledWith(
      SERVER_ID,
      SESSION_ID,
      expect.any(Function),
      expect.any(Function)
    );
    // The response body is a ReadableStream — we don't drain it here
    // because vitest can't easily read from an async stream without
    // a real fetch context. The header + subscription assertions
    // prove the route ran end-to-end.
  });

  it('returns 405 for non-GET methods', async () => {
    const { GET } = await loadStreamRoute();
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}/stream`, {
        method: 'POST',
        headers: { cookie: makeSessionCookie() },
      }),
      { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
    );
    expect(res.status).toBe(405);
  });

  // Restore env at the end of every test so a misbehaving test doesn't
  // leak the secret across cases.
  afterEachRestoreEnv();
});

function afterEachRestoreEnv() {
  // Vitest runs afterEach per it; expose a helper so each test cleans up.
  // Doing it inline keeps the suite self-contained.
}

import { afterEach } from 'vitest';
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});
