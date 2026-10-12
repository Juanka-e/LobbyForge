/**
 * Host effects on the activity routes (docs/PLUGIN_SDK.md "Effects",
 * lib/activity-effects.ts, lib/activity-timers.ts):
 *
 *  - a reducer's `withEffects` envelope is unwrapped, every effect checked
 *    against the plugin's permissions; one bad or unpermitted effect refuses
 *    the whole action (422 `effect_refused`, nothing written);
 *  - a `role: "system"` action is never accepted from a client (403);
 *  - timers: stored in the same CAS write as the state, at most 8, same id
 *    replaces, clear removes; fired LAZILY under the session lock on GET,
 *    action and end, in due order, each as its system action with
 *    `ctx.now` = the due time; concurrent GETs fire a timer once; the GET
 *    exposes due times only; ending drops what is left;
 *  - storage: a snapshot in ctx.storage, writes after the commit, the
 *    64 KiB limit checked before it;
 *  - chat: posted after the commit.
 *
 * The REAL routes and effect machinery; the database is an in-memory row
 * whose write lock really serializes callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import { withEffects, type GamePluginContext, type PluginEffect, type RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { pollPlugin } from '@lobbyforge/poll';

interface Timer {
  id: string;
  at: number;
  action: Record<string, unknown>;
}

interface Row {
  id: string;
  serverId: string;
  channelId: string;
  pluginId: string;
  status: string;
  state: Record<string, unknown>;
  publicSummary: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  revision: number;
  timers: Timer[];
}

const HOST = 'u-host';
const ALICE = 'u-alice';
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

const store = vi.hoisted(() => ({
  row: null as unknown as Row,
  storage: {} as Record<string, unknown>,
  lockTail: Promise.resolve() as Promise<unknown>,
}));

const dbFns = vi.hoisted(() => ({
  getServerById: vi.fn(async () => ({ id: 'srv-1', ownerUserId: 'u-owner' })),
  getGameSessionById: vi.fn(async () => (store.row.status === 'ended' ? null : structuredClone(store.row))),
  isServerMember: vi.fn(async () => true),
  getUserPermissions: vi.fn(async () => [] as string[]),
  listPlayersForSession: vi.fn(async () => [] as Array<{ userId: string; status: string; score: number }>),
  addPlayerToSession: vi.fn(async () => undefined),
  logAction: vi.fn(async () => undefined),
  setGameSessionStateCAS: vi.fn(
    async (_db: unknown, _id: string, rev: number, state: Record<string, unknown>, _summary?: unknown, extra: { timers?: Timer[] } = {}) => {
      if (rev !== store.row.revision || store.row.status === 'ended') return { ok: false, row: structuredClone(store.row) };
      store.row = {
        ...store.row,
        state: structuredClone(state),
        revision: rev + 1,
        ...(extra.timers !== undefined ? { timers: structuredClone(extra.timers) } : {}),
      };
      return { ok: true, row: structuredClone(store.row) };
    }
  ),
  // A real lock: callers run one at a time, each on the row as it stands then.
  withGameSessionWriteLock: vi.fn(async (_db: unknown, _id: string, fn: (tx: unknown, row: unknown) => Promise<unknown>) => {
    const run = store.lockTail.then(() => fn({ __mockTx: true }, structuredClone(store.row)));
    store.lockTail = run.catch(() => undefined);
    return run;
  }),
  endGameSession: vi.fn(async () => {
    store.row = { ...store.row, status: 'ended', endedAt: new Date(), timers: [] };
    return structuredClone(store.row);
  }),
  listPluginData: vi.fn(async () => Object.entries(store.storage).map(([key, value]) => ({ key, value }))),
  writePluginDataBatch: vi.fn(async (_db: unknown, _s: string, _p: string, writes: Array<{ key: string; value?: unknown; delete?: true }>) => {
    for (const write of writes) {
      if (write.delete) delete store.storage[write.key];
      else store.storage[write.key] = write.value;
    }
  }),
  PluginStorageFullError: class PluginStorageFullError extends Error {},
  GameSessionBusyError: class GameSessionBusyError extends Error {},
  users: { id: 'users.id', displayName: 'users.display_name' },
}));
vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }) }),
}));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 }),
  rateLimitResponse: () => null,
}));
vi.mock('@/lib/permissions', () => ({ authorizeSessionChannelVisibility: async () => ({ ok: true }) }));
const publish = vi.hoisted(() => vi.fn());
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange: publish }));
const postAppMessage = vi.hoisted(() => vi.fn(async () => ({ posted: true, messageId: 'm-1', channelId: 'ch-text' })));
vi.mock('@/lib/activity-app-chat', () => ({ postAppMessage, APP_MESSAGE_CHANNEL_TYPES: new Set(['text', 'announcement']) }));
vi.mock('@/lib/prepare-plugin-action', () => ({
  preparePluginAction: vi.fn(async (_db: unknown, input: { action: Record<string, unknown> }) => ({ ok: true as const, action: input.action })),
}));
vi.mock('@/lib/action-idempotency', () => ({
  claimActionId: vi.fn(),
  releaseActionId: vi.fn(),
  DuplicateActionError: class DuplicateActionError extends Error {},
  isValidActionId: () => false,
}));
vi.mock('@/lib/plugin-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plugin-context')>()),
  buildHttpPluginContext: vi.fn(async (input: { actorUserId: string; serverId: string; pluginId: string }) => {
    const ctx = createTestHarness({ plugin: pollPlugin, players: [HOST, ALICE] }).context;
    Object.defineProperty(ctx, 'actorUserId', { value: input.actorUserId, writable: true });
    Object.defineProperty(ctx, '__lfScope', { value: { serverId: input.serverId, pluginId: input.pluginId } });
    return ctx;
  }),
}));
const registry = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/plugin-server-registry', () => ({ getPluginServer: (id: string) => registry.get(id) ?? null }));

const SECRET = 'x'.repeat(32);

// ── The test plugin ──────────────────────────────────────────────────────

interface GameState {
  armed: number;
  fired: Array<{ label: unknown; now: number | undefined; actor: string }>;
  peeked?: unknown;
}

/** What each `tick` saw, in the order the reducer ran them. */
const tickLog: Array<{ label: unknown; now: number | undefined }> = [];

function makePlugin(permissions: string[]): RegisteredGamePlugin {
  return {
    manifest: {
      id: 'timer-game',
      name: 'Timer Game',
      version: '1.0.0',
      type: 'game',
      minAppVersion: '0.1.0',
      permissions: permissions as never,
      locales: ['en'],
      entryClient: '',
    },
    actionPolicies: {
      arm: { role: 'host' },
      disarm: { role: 'host' },
      tick: { role: 'system' },
      remember: { role: 'host' },
      announce: { role: 'host' },
      mute: { role: 'host' },
      peek: { role: 'host' },
      noop: { role: 'host' },
    },
    createInitialState: () => ({ armed: 0, fired: [] }),
    handleAction: (ctx: GamePluginContext, raw: unknown, action: unknown) => {
      const state = raw as GameState;
      const a = action as Record<string, unknown> & { type: string };
      switch (a.type) {
        case 'arm': {
          const effects: PluginEffect[] = [];
          for (const spec of (a.timers as Array<{ id: string; afterMs: number; label: string; chain?: boolean }>) ?? []) {
            effects.push({ type: 'timer.set', id: spec.id, afterMs: spec.afterMs, action: { type: 'tick', label: spec.label, chain: spec.chain ?? false } });
          }
          return withEffects({ ...state, armed: state.armed + effects.length }, effects);
        }
        case 'disarm':
          return withEffects(state, [{ type: 'timer.clear', id: String(a.id) }]);
        case 'tick': {
          tickLog.push({ label: a.label, now: ctx.now });
          const next = { ...state, fired: [...state.fired, { label: a.label, now: ctx.now, actor: ctx.actorUserId }] };
          // A chained timer sets the next one from its own due time.
          return a.chain
            ? withEffects(next, [{ type: 'timer.set', id: 'chain', afterMs: 1_000, action: { type: 'tick', label: `${String(a.label)}+`, chain: false } }])
            : next;
        }
        case 'remember':
          return withEffects(state, [{ type: 'storage.set', key: String(a.key ?? 'k'), value: a.value }]);
        case 'announce':
          return withEffects(state, [{ type: 'chat.post', text: String(a.text) }]);
        case 'mute':
          return withEffects(state, [{ type: 'voice.mute', userId: ALICE, muted: true } as unknown as PluginEffect]);
        case 'peek':
          return { ...state, peeked: ctx.storage.get('k') ?? null };
        default:
          return state;
      }
    },
    renderClient: () => null,
  };
}

function seed(timers: Timer[] = [], state: Partial<GameState> = {}): void {
  store.row = {
    id: 'sess-1',
    serverId: 'srv-1',
    channelId: 'ch-voice',
    pluginId: 'timer-game',
    status: 'running',
    state: { armed: 0, fired: [], ...state },
    publicSummary: {},
    createdBy: HOST,
    createdAt: new Date(T0),
    startedAt: null,
    endedAt: null,
    revision: 1,
    timers,
  };
}

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: `g_${uid}`.padEnd(34, 'a'), uid, name: uid };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

const params = { params: Promise.resolve({ id: 'srv-1', sessionId: 'sess-1' }) };

async function act(uid: string, body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../actions/route.js');
  return (POST as unknown as (req: Request, ctx: unknown) => Promise<Response>)(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookie(uid) },
      body: JSON.stringify(body),
    }),
    params
  );
}

async function read(uid: string): Promise<Response> {
  const { GET } = await import('../route.js');
  return (GET as unknown as (req: Request, ctx: unknown) => Promise<Response>)(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1', { headers: { cookie: cookie(uid) } }),
    params
  );
}

async function end(uid: string): Promise<Response> {
  const { POST } = await import('../end/route.js');
  return (POST as unknown as (req: Request, ctx: unknown) => Promise<Response>)(
    new Request('http://localhost/api/servers/srv-1/activities/sess-1/end', { method: 'POST', headers: { cookie: cookie(uid) } }),
    params
  );
}

const state = () => store.row.state as unknown as GameState;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  store.storage = {};
  store.lockTail = Promise.resolve();
  tickLog.length = 0;
  for (const fn of [dbFns.setGameSessionStateCAS, dbFns.writePluginDataBatch, dbFns.withGameSessionWriteLock, dbFns.endGameSession, dbFns.listPluginData, publish, postAppMessage]) {
    fn.mockClear();
  }
  registry.clear();
  registry.set('timer-game', makePlugin(['timers', 'storage', 'chat']));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('effects: validated against the plugin’s permissions, all or nothing', () => {
  it('a timer.set commits in the same write as the state; the response and the bus say timers changed', async () => {
    seed();
    const res = await act(HOST, { type: 'arm', timers: [{ id: 'reveal', afterMs: 10_000, label: 'r' }] });
    expect(res.status).toBe(200);
    expect(state().armed).toBe(1);
    expect(store.row.timers).toEqual([{ id: 'reveal', at: T0 + 10_000, action: { type: 'tick', label: 'r', chain: false } }]);
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { activity: { timersDueAt: string[] } };
    expect(body.activity.timersDueAt).toEqual([new Date(T0 + 10_000).toISOString()]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ publicSummary: expect.objectContaining({ timersChanged: true }) }));
  });

  it('an effect the plugin has no permission for refuses the whole action (422 effect_refused, nothing written)', async () => {
    registry.set('timer-game', makePlugin(['storage']));
    seed();
    const res = await act(HOST, { type: 'arm', timers: [{ id: 'reveal', afterMs: 10_000, label: 'r' }] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('effect_refused');
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
    expect(state().armed).toBe(0);
    expect(store.row.timers).toEqual([]);
  });

  it('an unknown effect (voice.mute is not available yet) is refused like an invalid one', async () => {
    registry.set('timer-game', makePlugin(['timers', 'storage', 'chat', 'voice.mute']));
    seed();
    expect((await act(HOST, { type: 'mute' })).status).toBe(422);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
  });

  it('a system action is never accepted from a client — not even from the host (403 system_action)', async () => {
    seed();
    const res = await act(HOST, { type: 'tick', label: 'forged' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('system_action');
    expect(state().fired).toEqual([]);
  });

  it('a ninth pending timer refuses the action; the same id replaces; clear removes', async () => {
    seed();
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, afterMs: 5_000 + i, label: i }));
    expect((await act(HOST, { type: 'arm', timers: eight })).status).toBe(200);
    expect(store.row.timers).toHaveLength(8);
    expect((await act(HOST, { type: 'arm', timers: [{ id: 'ninth', afterMs: 5_000, label: 'x' }] })).status).toBe(422);
    expect(store.row.timers).toHaveLength(8);
    expect((await act(HOST, { type: 'arm', timers: [{ id: 't3', afterMs: 60_000, label: 'again' }] })).status).toBe(200);
    expect(store.row.timers).toHaveLength(8);
    expect(store.row.timers.find((t) => t.id === 't3')).toMatchObject({ at: T0 + 60_000, action: { label: 'again' } });
    expect((await act(HOST, { type: 'disarm', id: 't3' })).status).toBe(200);
    expect(store.row.timers.map((t) => t.id)).not.toContain('t3');
  });

  it('timers outside 1 s – 24 h are refused', async () => {
    seed();
    expect((await act(HOST, { type: 'arm', timers: [{ id: 'fast', afterMs: 500, label: 'x' }] })).status).toBe(422);
    expect((await act(HOST, { type: 'arm', timers: [{ id: 'slow', afterMs: 25 * 3600_000, label: 'x' }] })).status).toBe(422);
  });

  it('"same state and no effects" is still no change: nothing audited, no timers written', async () => {
    seed();
    expect((await act(HOST, { type: 'noop' })).status).toBe(200);
    expect(dbFns.logAction).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'activity.action' }));
    expect(dbFns.setGameSessionStateCAS.mock.calls[0]![5]).toEqual({});
  });
});

describe('timers fire lazily, under the lock, in due order', () => {
  const at = (ms: number) => T0 + ms;

  it('GET fires the due timers earliest first, each with ctx.now = its due time and no actor, and returns due times only', async () => {
    seed([
      { id: 'late', at: at(3_000), action: { type: 'tick', label: 'late' } },
      { id: 'early', at: at(1_000), action: { type: 'tick', label: 'early' } },
      { id: 'future', at: at(60_000), action: { type: 'tick', label: 'secret-future-label' } },
    ]);
    vi.setSystemTime(at(5_000));
    const res = await read(ALICE);
    expect(res.status).toBe(200);
    expect(tickLog).toEqual([
      { label: 'early', now: at(1_000) },
      { label: 'late', now: at(3_000) },
    ]);
    expect(state().fired.map((f) => f.actor)).toEqual(['', '']);
    expect(store.row.timers.map((t) => t.id)).toEqual(['future']);
    const text = await res.text();
    const body = JSON.parse(text) as { activity: { timersDueAt: string[]; now: string; state: GameState } };
    expect(body.activity.timersDueAt).toEqual([new Date(at(60_000)).toISOString()]);
    expect(body.activity.now).toBe(new Date(at(5_000)).toISOString());
    // The viewer gets the state the timers produced, and never a timer's action.
    expect(body.activity.state.fired).toHaveLength(2);
    expect(text).not.toContain('secret-future-label');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ publicSummary: { timersChanged: true } }));
  });

  it('a GET with nothing due takes no lock and writes nothing', async () => {
    seed([{ id: 'future', at: at(60_000), action: { type: 'tick', label: 'f' } }]);
    expect((await read(ALICE)).status).toBe(200);
    expect(dbFns.withGameSessionWriteLock).not.toHaveBeenCalled();
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
  });

  it('two concurrent GETs fire a timer once', async () => {
    seed([{ id: 'once', at: at(1_000), action: { type: 'tick', label: 'once' } }]);
    vi.setSystemTime(at(2_000));
    const [a, b] = await Promise.all([read(ALICE), read(HOST)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(tickLog).toEqual([{ label: 'once', now: at(1_000) }]);
    expect(state().fired).toHaveLength(1);
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
  });

  it('a timer that sets the next one keeps going in the same touch while that one is due too', async () => {
    seed([{ id: 'first', at: at(1_000), action: { type: 'tick', label: 'a', chain: true } }]);
    vi.setSystemTime(at(10_000));
    await read(ALICE);
    expect(tickLog).toEqual([
      { label: 'a', now: at(1_000) },
      { label: 'a+', now: at(2_000) },
    ]);
    expect(store.row.timers).toEqual([]);
  });

  it('an action first fires what fell due before it, then runs on that state — in one write', async () => {
    seed([{ id: 'due', at: at(1_000), action: { type: 'tick', label: 'due' } }]);
    vi.setSystemTime(at(4_000));
    const res = await act(HOST, { type: 'arm', timers: [{ id: 'next', afterMs: 2_000, label: 'n' }] });
    expect(res.status).toBe(200);
    expect(state()).toMatchObject({ armed: 1, fired: [{ label: 'due', now: at(1_000), actor: '' }] });
    expect(store.row.timers).toEqual([{ id: 'next', at: at(6_000), action: { type: 'tick', label: 'n', chain: false } }]);
    expect(dbFns.setGameSessionStateCAS).toHaveBeenCalledTimes(1);
  });

  it('when the action is refused, the timers that fired still commit', async () => {
    registry.set('timer-game', makePlugin(['timers']));
    seed([{ id: 'due', at: at(1_000), action: { type: 'tick', label: 'due' } }]);
    vi.setSystemTime(at(4_000));
    expect((await act(HOST, { type: 'announce', text: 'no chat permission' })).status).toBe(422);
    expect(state().fired).toHaveLength(1);
    expect(store.row.timers).toEqual([]);
    expect(postAppMessage).not.toHaveBeenCalled();
  });

  it('ending fires what was already due, then drops every other pending timer', async () => {
    seed([
      { id: 'due', at: at(1_000), action: { type: 'tick', label: 'due' } },
      { id: 'later', at: at(60_000), action: { type: 'tick', label: 'later' } },
    ]);
    vi.setSystemTime(at(2_000));
    expect((await end(HOST)).status).toBe(200);
    expect(tickLog.map((t) => t.label)).toEqual(['due']);
    expect(dbFns.endGameSession).toHaveBeenCalledTimes(1);
    expect(store.row.timers).toEqual([]);
    expect(store.row.status).toBe('ended');
  });
});

describe('storage and chat: after the commit', () => {
  it('ctx.storage is the snapshot of the plugin’s storage', async () => {
    store.storage = { k: { best: 312 } };
    seed();
    expect((await act(HOST, { type: 'peek' })).status).toBe(200);
    expect(state().peeked).toEqual({ best: 312 });
  });

  it('without the storage permission the snapshot is empty and nothing is read', async () => {
    registry.set('timer-game', makePlugin(['timers']));
    store.storage = { k: 'hidden' };
    seed();
    await act(HOST, { type: 'peek' });
    expect(state().peeked).toBeNull();
    expect(dbFns.listPluginData).not.toHaveBeenCalled();
  });

  it('storage.set is written after the state commit', async () => {
    seed();
    expect((await act(HOST, { type: 'remember', value: { n: 1 } })).status).toBe(200);
    expect(dbFns.writePluginDataBatch).toHaveBeenCalledWith(
      expect.anything(),
      'srv-1',
      'timer-game',
      [{ key: 'k', value: { n: 1 } }],
      expect.objectContaining({ maxBytes: 64 * 1024 })
    );
    const casOrder = dbFns.setGameSessionStateCAS.mock.invocationCallOrder[0]!;
    expect(dbFns.writePluginDataBatch.mock.invocationCallOrder[0]!).toBeGreaterThan(casOrder);
    expect(store.storage).toEqual({ k: { n: 1 } });
  });

  it('a write that would take the storage past 64 KiB refuses the action before anything commits', async () => {
    store.storage = { other: 'x'.repeat(60 * 1024) };
    seed();
    const res = await act(HOST, { type: 'remember', value: 'y'.repeat(8 * 1024) });
    expect(res.status).toBe(422);
    expect(dbFns.setGameSessionStateCAS).not.toHaveBeenCalled();
    expect(dbFns.writePluginDataBatch).not.toHaveBeenCalled();
  });

  it('chat.post goes out after the commit, as the plugin', async () => {
    seed();
    expect((await act(HOST, { type: 'announce', text: '  Team A won 12–9.  ' })).status).toBe(200);
    expect(postAppMessage).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'srv-1', sessionId: 'sess-1', pluginId: 'timer-game', pluginName: 'Timer Game', text: 'Team A won 12–9.' })
    );
  });
});
