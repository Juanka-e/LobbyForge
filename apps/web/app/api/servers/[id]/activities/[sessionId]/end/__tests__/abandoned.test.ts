import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Ending an activity whose host left the voice room (a game that requires
 * voice): any voice participant may end an abandoned session; a
 * participant hosting has just moved to may end it as host; everyone else
 * gets not_host (with where the host stands) — never a channel locked by
 * a host who walked away.
 */

const dbFns = {
  endGameSession: vi.fn(),
  getGameSessionById: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  logAction: vi.fn(),
};
vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange: vi.fn() }));
vi.mock('@/lib/permissions', () => ({ authorizeSessionChannelVisibility: async () => ({ ok: true }) }));

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
const pollLike = { manifest: { ...voicePlugin.manifest, id: 'poll-like', catalog: { requiresVoiceRoom: false } } };
vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer: (id: string) => (id === 'voice-game' ? voicePlugin : id === 'poll-like' ? pollLike : null),
}));

const SECRET = 'x'.repeat(32);
const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

let row: Record<string, unknown>;

function view(overrides: Record<string, unknown> = {}) {
  return {
    hostUserId: HOST,
    inVoice: false,
    awaySince: NOW - 200_000,
    transferAt: NOW - 140_000,
    abandonAt: NOW - 20_000,
    abandoned: true,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  row = { id: 'sess-1', serverId: 'srv-1', channelId: 'ch-voice', pluginId: 'voice-game', createdBy: HOST, status: 'lobby' };
  dbFns.getServerById.mockResolvedValue({ id: 'srv-1', ownerUserId: 'owner-x' });
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getUserPermissions.mockResolvedValue(['send_messages']);
  dbFns.getGameSessionById.mockImplementation(async () => row);
  dbFns.endGameSession.mockResolvedValue({ id: 'sess-1', status: 'ended', endedAt: new Date(NOW), publicSummary: {} });
  dbFns.logAction.mockResolvedValue(undefined);
  getVoiceRoomSnapshot.mockReset().mockResolvedValue({
    available: true,
    room: 's_room',
    participants: [{ userId: PLAYER, joinedAtMs: 1 }],
  });
  resolveActivityHost.mockReset().mockResolvedValue({ view: view(), transferred: null });
});

async function end(uid: string): Promise<Response> {
  const { POST } = await import('../route.js');
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return handler(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1/end', {
      method: 'POST',
      headers: { cookie: `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}` },
    }),
    { params: Promise.resolve({ id: 'srv-1', sessionId: 'sess-1' }) }
  );
}

describe('ending an abandoned session', () => {
  it('any voice participant may end it once the host is gone long enough — audited as abandoned', async () => {
    const res = await end(PLAYER);
    expect(res.status).toBe(200);
    expect(dbFns.endGameSession).toHaveBeenCalledWith(expect.anything(), 'sess-1');
    expect(resolveActivityHost).toHaveBeenCalledWith(expect.objectContaining({ skipTransferWhenAbandoned: true, ownerUserId: 'owner-x' }));
    expect(dbFns.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'activity.end',
        actorUserId: PLAYER,
        metadata: { pluginId: 'voice-game', wasHost: false, reason: 'abandoned' },
      })
    );
  });

  it('someone outside the voice room cannot (voice_required) — nothing ends', async () => {
    const res = await end(OTHER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'voice_required', abandoned: true });
    expect(dbFns.endGameSession).not.toHaveBeenCalled();
  });

  it('within the grace, a participant hosting just moved to ends it as host', async () => {
    resolveActivityHost.mockResolvedValue({
      view: view({ hostUserId: PLAYER, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false }),
      transferred: { fromUserId: HOST, toUserId: PLAYER },
    });
    const res = await end(PLAYER);
    expect(res.status).toBe(200);
    expect(dbFns.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: { pluginId: 'voice-game', wasHost: true } })
    );
  });

  it('a participant who is not (yet) allowed gets not_host with where the host stands — nothing ends', async () => {
    resolveActivityHost.mockResolvedValue({
      view: view({ awaySince: NOW - 30_000, transferAt: NOW + 30_000, abandonAt: NOW + 150_000, abandoned: false }),
      transferred: null,
    });
    const res = await end(PLAYER);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; host: Record<string, unknown> };
    expect(body.code).toBe('not_host');
    expect(body.host).toEqual({
      userId: HOST,
      inVoice: false,
      awaySince: new Date(NOW - 30_000).toISOString(),
      transferAt: new Date(NOW + 30_000).toISOString(),
      abandonAt: new Date(NOW + 150_000).toISOString(),
      abandoned: false,
    });
    expect(dbFns.endGameSession).not.toHaveBeenCalled();
  });

  it('a plugin that does not require voice keeps the old rule: host or Start Activities', async () => {
    row.pluginId = 'poll-like';
    const res = await end(PLAYER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_host' });
    expect(getVoiceRoomSnapshot).not.toHaveBeenCalled();
  });

  it('when the voice room cannot be read, only the host or a moderator may end it', async () => {
    resolveActivityHost.mockResolvedValue(null);
    const res = await end(PLAYER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_host' });
  });

  it('the host and moderators never wait', async () => {
    expect((await end(HOST)).status).toBe(200);
    dbFns.getUserPermissions.mockResolvedValue(['start_activity']);
    expect((await end(OTHER)).status).toBe(200);
    expect(resolveActivityHost).not.toHaveBeenCalled();
  });
});
