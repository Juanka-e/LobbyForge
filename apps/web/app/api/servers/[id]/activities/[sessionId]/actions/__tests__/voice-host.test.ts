import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * The actions route, for games played over voice (and the codes on every
 * refusal):
 *  - a player/member action needs the actor in the activity's voice room
 *    (403 voice_required); spectators read freely; `allowOutsideVoice`
 *    actions and host actions are not voice-checked; LiveKit down → open;
 *  - a host who left the room hands over lazily: the new host's host
 *    action goes through, the old host's is refused (not_host);
 *  - `restartActions`: a finished game accepts its "play again" and
 *    nothing else (session_ended) — Hushle's "Start new game" included;
 *  - the per-user, per-session rate limit (rate_limited).
 */

const dbFns = {
  getServerById: vi.fn(),
  getGameSessionById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  listPlayersForSession: vi.fn(),
  logAction: vi.fn(),
  setGameSessionStateCAS: vi.fn(),
  withGameSessionWriteLock: vi.fn(),
  addPlayerToSession: vi.fn(),
};
class GameSessionBusyError extends Error {}
vi.mock('@lobbyforge/db', () => ({ ...dbFns, GameSessionBusyError }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));

const rateLimit = vi.fn();
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return {
    withApiSecurity: (handler: unknown) => handler,
    applySecurityHeaders: (r: unknown) => r,
    distributedRateLimit: (...args: unknown[]) => rateLimit(...args),
    rateLimitResponse: actual.rateLimitResponse,
  };
});
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange: vi.fn() }));
vi.mock('@/lib/permissions', () => ({ authorizeSessionChannelVisibility: async () => ({ ok: true }) }));
vi.mock('@/lib/prepare-plugin-action', () => ({
  preparePluginAction: vi.fn(async (_db: unknown, input: { action: Record<string, unknown> }) => ({ ok: true as const, action: input.action })),
}));
vi.mock('@/lib/action-idempotency', () => ({
  claimActionId: vi.fn(),
  releaseActionId: vi.fn(),
  DuplicateActionError: class DuplicateActionError extends Error {},
  isValidActionId: () => true,
}));

const getVoiceRoomSnapshot = vi.fn();
vi.mock('@/lib/activity-voice', async () => {
  const actual = await vi.importActual<typeof import('@/lib/activity-voice')>('@/lib/activity-voice');
  return { ...actual, getVoiceRoomSnapshot: (...args: unknown[]) => getVoiceRoomSnapshot(...args) };
});
const resolveActivityHost = vi.fn();
vi.mock('@/lib/activity-host', () => ({ resolveActivityHost: (...args: unknown[]) => resolveActivityHost(...args) }));

const { hushlePlugin } = await import('@lobbyforge/hushle');
const { registerGamePlugin } = await import('@lobbyforge/plugin-sdk');

const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OUTSIDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'x'.repeat(32);

const voiceGame = {
  manifest: {
    id: 'voice-game',
    name: 'Voice Game',
    version: '1.0.0',
    type: 'game' as const,
    minAppVersion: '0.1.0',
    permissions: [],
    locales: ['en'],
    entryClient: '',
    catalog: { requiresVoiceRoom: true },
  },
  actionPolicies: {
    move: { role: 'member' as const, actorFields: ['playerId'] },
    leave: { role: 'member' as const, actorFields: ['playerId'], allowOutsideVoice: true },
    deal: { role: 'host' as const },
    'play-again': { role: 'host' as const },
    peek: { role: 'player' as const },
  },
  restartActions: ['play-again'],
  createInitialState: () => ({ phase: 'lobby' }),
  handleAction: (_ctx: unknown, state: Record<string, unknown>, action: Record<string, unknown>) => ({
    ...state,
    last: action.type,
    ...(action.type === 'play-again' ? { phase: 'lobby' } : {}),
  }),
  renderClient: () => null,
};
const plainGame = { ...voiceGame, manifest: { ...voiceGame.manifest, id: 'plain-game', catalog: { requiresVoiceRoom: false } } };
const hushle = registerGamePlugin(hushlePlugin);
const plugins: Record<string, unknown> = { 'voice-game': voiceGame, 'plain-game': plainGame, hushle };
vi.mock('@/lib/plugin-server-registry', () => ({ getPluginServer: (id: string) => plugins[id] ?? null }));

let row: Record<string, unknown>;

function snapshot(ids: string[]) {
  return { available: true, room: 's_room', participants: ids.map((userId, i) => ({ userId, joinedAtMs: i })) };
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60_000 });
  getVoiceRoomSnapshot.mockReset().mockResolvedValue(snapshot([HOST, PLAYER]));
  resolveActivityHost.mockReset().mockImplementation(async (input: { row: { createdBy: string } }) => ({
    view: { hostUserId: input.row.createdBy, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
    transferred: null,
  }));
  row = {
    id: 'sess-1',
    serverId: 'srv-1',
    channelId: 'ch-voice',
    pluginId: 'voice-game',
    createdBy: HOST,
    status: 'lobby',
    state: { phase: 'playing' },
    revision: 1,
  };
  dbFns.getServerById.mockResolvedValue({ ownerUserId: 'owner-x' });
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getUserPermissions.mockResolvedValue([]);
  dbFns.getGameSessionById.mockImplementation(async () => row);
  dbFns.listPlayersForSession.mockResolvedValue([{ userId: HOST }, { userId: PLAYER }]);
  dbFns.withGameSessionWriteLock.mockImplementation(async (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => unknown) =>
    fn({ __tx: true }, row)
  );
  dbFns.setGameSessionStateCAS.mockImplementation(async (_db: unknown, _id: string, rev: number, state: unknown) => ({
    ok: true,
    row: { id: 'sess-1', state, status: 'lobby', revision: rev + 1 },
  }));
  dbFns.logAction.mockResolvedValue(undefined);
});

async function post(body: Record<string, unknown>, uid: string): Promise<Response> {
  const { POST } = await import('../route.js');
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return handler(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'srv-1', sessionId: 'sess-1' }) }
  );
}

describe('voice_required', () => {
  it('refuses a member action from someone who is not in the voice room — nothing runs', async () => {
    getVoiceRoomSnapshot.mockResolvedValue(snapshot([HOST]));
    const res = await post({ type: 'move' }, PLAYER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'voice_required', error: expect.any(String) });
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
    expect(getVoiceRoomSnapshot).toHaveBeenCalledWith('srv-1', 'ch-voice');
  });

  it('lets the same member act from inside the room', async () => {
    const res = await post({ type: 'move' }, PLAYER);
    expect(res.status).toBe(200);
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
  });

  it('a `player` action from someone off the roster is not_player (checked before voice)', async () => {
    const res = await post({ type: 'peek' }, OUTSIDER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_player' });
  });

  it('an allowOutsideVoice action (leaving) works from outside the room', async () => {
    getVoiceRoomSnapshot.mockResolvedValue(snapshot([HOST]));
    expect((await post({ type: 'leave' }, PLAYER)).status).toBe(200);
  });

  it('host actions are never voice-checked', async () => {
    getVoiceRoomSnapshot.mockResolvedValue(snapshot([]));
    expect((await post({ type: 'deal' }, HOST)).status).toBe(200);
  });

  it('fails open when LiveKit cannot be asked', async () => {
    getVoiceRoomSnapshot.mockResolvedValue({ available: false, room: 's_room' });
    expect((await post({ type: 'move' }, OUTSIDER)).status).toBe(200);
  });

  it('a plugin that does not require voice never asks LiveKit', async () => {
    row.pluginId = 'plain-game';
    expect((await post({ type: 'move' }, OUTSIDER)).status).toBe(200);
    expect(getVoiceRoomSnapshot).not.toHaveBeenCalled();
    expect(resolveActivityHost).not.toHaveBeenCalled();
  });
});

describe('host hand-over (lazy, on the next action)', () => {
  it('the participant who just became host may run a host action', async () => {
    resolveActivityHost.mockResolvedValue({
      view: { hostUserId: PLAYER, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
      transferred: { fromUserId: HOST, toUserId: PLAYER },
    });
    const res = await post({ type: 'deal' }, PLAYER);
    expect(res.status).toBe(200);
    expect(resolveActivityHost).toHaveBeenCalledWith(expect.objectContaining({ row, ownerUserId: 'owner-x' }));
  });

  it('…and the old host no longer may (not_host)', async () => {
    resolveActivityHost.mockResolvedValue({
      view: { hostUserId: PLAYER, inVoice: true, awaySince: null, transferAt: null, abandonAt: null, abandoned: false },
      transferred: { fromUserId: HOST, toUserId: PLAYER },
    });
    const res = await post({ type: 'deal' }, HOST);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_host' });
  });

  it('a moderator with Start Activities still may', async () => {
    dbFns.getUserPermissions.mockResolvedValue(['start_activity']);
    getVoiceRoomSnapshot.mockResolvedValue(snapshot([HOST]));
    expect((await post({ type: 'deal' }, OUTSIDER)).status).toBe(200);
  });
});

describe('restartActions — "play again" on a finished game', () => {
  it('a finished game accepts its restart action', async () => {
    row.state = { phase: 'ended' };
    const res = await post({ type: 'play-again' }, HOST);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { activity: { state: { phase: string } } }).activity.state.phase).toBe('lobby');
  });

  it('…and refuses everything else as session_ended', async () => {
    row.state = { phase: 'ended' };
    const res = await post({ type: 'deal' }, HOST);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'session_ended', error: 'Game has ended.' });
  });

  it('Hushle: "Start new game" (start-game) goes through from the ended phase', async () => {
    row.pluginId = 'hushle';
    row.state = { ...hushlePlugin.createInitialState({} as never), phase: 'ended' };
    const res = await post({ type: 'start-game', packId: 'hushle-en-basic', createdBy: HOST }, HOST);
    expect(res.status).toBe(200);
    const { activity } = (await res.json()) as { activity: { state: { phase: string } } };
    expect(activity.state.phase).toBe('team_setup');
  });

  it('Hushle: other actions on a finished game are session_ended; lobby refusals are wrong_phase', async () => {
    row.pluginId = 'hushle';
    row.state = { ...hushlePlugin.createInitialState({} as never), phase: 'ended' };
    const ended = await post({ type: 'end-turn' }, HOST);
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({ code: 'session_ended' });
    row.state = { ...hushlePlugin.createInitialState({} as never), phase: 'lobby' };
    const early = await post({ type: 'end-turn' }, HOST);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'wrong_phase' });
  });

  it('an ended session ROW is session_ended whatever the action', async () => {
    row.status = 'ended';
    const res = await post({ type: 'play-again' }, HOST);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'session_ended' });
  });
});

describe('rate limit — per user and session, not per address', () => {
  it('keys the limit on the caller and the session, and answers 429 rate_limited', async () => {
    rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 30_000 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await post({ type: 'move' }, PLAYER);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited' });
    expect(rateLimit).toHaveBeenCalledWith(`activity-action:user:${PLAYER}:sess-1`, { windowMs: 60_000, maxRequests: 90 });
    expect(dbFns.getGameSessionById).not.toHaveBeenCalled();
  });

  it('two people behind one address each get their own bucket', async () => {
    await post({ type: 'move' }, PLAYER);
    await post({ type: 'move' }, HOST);
    const keys = rateLimit.mock.calls.map((call) => call[0]);
    expect(new Set(keys).size).toBe(2);
  });
});
