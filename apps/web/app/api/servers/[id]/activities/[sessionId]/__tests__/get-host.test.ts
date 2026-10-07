import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * GET activity — a state read is one of the moments a host who left the
 * voice room hands over (lazily). The response then names the NEW host in
 * `createdBy`, carries `host` (where the host stands: in voice, away since,
 * when hosting moves, when the room may end it) and the state as it is
 * after the plugin's own `onHostChange`. Spectators read freely: no voice
 * check on a read. A plugin that does not require voice gets no `host`.
 */

const dbFns = {
  getGameSessionById: vi.fn(),
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  listPlayersForSession: vi.fn(),
};
vi.mock('drizzle-orm', () => ({ asc: () => (x: unknown) => x, inArray: () => (x: unknown) => x }));
vi.mock('@lobbyforge/db', () => ({ ...dbFns, users: { id: 'users.id', displayName: 'users.displayName' } }));
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    __mockDb: true,
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) }),
  }),
}));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
vi.mock('@/lib/permissions', () => ({ authorizeSessionChannelVisibility: async () => ({ ok: true }) }));
vi.mock('@/lib/plugin-projection', () => ({
  projectStateForViewer: async (input: { state: unknown }) => input.state,
}));

const getVoiceRoomSnapshot = vi.fn();
vi.mock('@/lib/activity-voice', async () => {
  const actual = await vi.importActual<typeof import('@/lib/activity-voice')>('@/lib/activity-voice');
  return { ...actual, getVoiceRoomSnapshot: (...args: unknown[]) => getVoiceRoomSnapshot(...args) };
});
const resolveActivityHost = vi.fn();
vi.mock('@/lib/activity-host', async () => {
  const actual = await vi.importActual<typeof import('@/lib/activity-host')>('@/lib/activity-host');
  return { ...actual, resolveActivityHost: (...args: unknown[]) => resolveActivityHost(...args) };
});

const voicePlugin = {
  manifest: { id: 'voice-game', name: 'V', version: '1', type: 'game', minAppVersion: '0', permissions: [], locales: ['en'], entryClient: '', catalog: { requiresVoiceRoom: true } },
};
const plain = { manifest: { ...voicePlugin.manifest, id: 'plain', catalog: {} } };
vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer: (id: string) => (id === 'voice-game' ? voicePlugin : id === 'plain' ? plain : null),
}));

const SECRET = 'x'.repeat(32);
const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SPECTATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

let row: Record<string, unknown>;

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  row = {
    id: 'sess-1',
    serverId: 'srv-1',
    channelId: 'ch-voice',
    pluginId: 'voice-game',
    status: 'lobby',
    state: { party: HOST },
    revision: 1,
    publicSummary: {},
    createdBy: HOST,
    createdAt: new Date(NOW),
    startedAt: null,
  };
  dbFns.getServerById.mockResolvedValue({ id: 'srv-1', ownerUserId: 'owner-x' });
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getGameSessionById.mockImplementation(async () => row);
  dbFns.listPlayersForSession.mockResolvedValue([]);
  getVoiceRoomSnapshot.mockReset().mockResolvedValue({ available: true, room: 's_room', participants: [{ userId: PLAYER, joinedAtMs: 1 }] });
  resolveActivityHost.mockReset();
});

async function get(uid: string): Promise<Response> {
  const { GET } = await import('../route.js');
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'T' };
  return GET(
    new Request('https://e.test/api/servers/srv-1/activities/sess-1', {
      headers: { cookie: `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}` },
    }),
    { params: Promise.resolve({ id: 'srv-1', sessionId: 'sess-1' }) }
  );
}

describe('GET activity — host presence', () => {
  it('within the grace: same host, and `host` says when hosting will move', async () => {
    resolveActivityHost.mockResolvedValue({
      view: { hostUserId: HOST, inVoice: false, awaySince: NOW - 20_000, transferAt: NOW + 40_000, abandonAt: NOW + 160_000, abandoned: false },
      transferred: null,
    });
    const res = await get(SPECTATOR);
    expect(res.status).toBe(200);
    const { activity } = (await res.json()) as { activity: Record<string, unknown> };
    expect(activity.createdBy).toBe(HOST);
    expect(activity.host).toEqual({
      userId: HOST,
      inVoice: false,
      awaySince: new Date(NOW - 20_000).toISOString(),
      transferAt: new Date(NOW + 40_000).toISOString(),
      abandonAt: new Date(NOW + 160_000).toISOString(),
      abandoned: false,
    });
  });

  it('a read past the grace hands over: the new host and the state after onHostChange', async () => {
    resolveActivityHost.mockImplementation(async () => {
      // What the write did: created_by and the plugin's own host moved.
      row = { ...row, createdBy: PLAYER, state: { party: PLAYER }, revision: 2 };
      return {
        view: { hostUserId: PLAYER, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
        transferred: { fromUserId: HOST, toUserId: PLAYER },
      };
    });
    const res = await get(SPECTATOR);
    const { activity } = (await res.json()) as { activity: Record<string, unknown> };
    expect(activity.createdBy).toBe(PLAYER);
    expect(activity.state).toEqual({ party: PLAYER });
    expect(activity.host).toMatchObject({ userId: PLAYER, inVoice: true });
  });

  it('spectators outside the voice room still read the activity', async () => {
    resolveActivityHost.mockResolvedValue({
      view: { hostUserId: HOST, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
      transferred: null,
    });
    expect((await get(SPECTATOR)).status).toBe(200);
  });

  it('a plugin that does not require voice: no LiveKit call, no `host` field', async () => {
    row.pluginId = 'plain';
    const res = await get(SPECTATOR);
    const { activity } = (await res.json()) as { activity: Record<string, unknown> };
    expect(activity.host).toBeUndefined();
    expect(activity.createdBy).toBe(HOST);
    expect(getVoiceRoomSnapshot).not.toHaveBeenCalled();
    expect(resolveActivityHost).not.toHaveBeenCalled();
  });

  it('LiveKit unreadable: the activity reads as before, without `host`', async () => {
    resolveActivityHost.mockResolvedValue(null);
    const res = await get(SPECTATOR);
    const { activity } = (await res.json()) as { activity: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(activity.host).toBeUndefined();
  });
});
