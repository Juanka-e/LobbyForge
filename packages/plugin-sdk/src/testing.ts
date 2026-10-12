import type { GamePlugin, GamePluginContext } from './index.js';
import {
  applyStorageEffects,
  applyTimerEffects,
  chatPostsOf,
  createStorageSnapshot,
  isEffectPermission,
  nextDueTimer,
  unwrapReducerResult,
  validateEffects,
  type PendingTimer,
  type ReducerResult,
} from './effects.js';

export interface TestHarnessOptions<TState, TAction> {
  plugin: GamePlugin<TState, TAction, unknown, ReducerResult<TState>>;
  players: string[];
  settings?: Record<string, unknown>;
  /** The harness clock at the start (ms). Default: `Date.now()` when the harness is created. */
  now?: number;
  /**
   * The effect permissions the plugin has. Default: the effect permissions
   * in `plugin.manifest.permissions` (what a compiled-in plugin gets).
   */
  permissions?: readonly string[];
  /** The plugin's storage in the community before the game (what `ctx.storage` starts with). */
  storage?: Record<string, unknown>;
}

/**
 * An effect the host would refuse (`code: 'effect_refused'`): the call's
 * state and effects were NOT applied. `reason` names the problem.
 */
export class EffectRefusedError extends Error {
  readonly code = 'effect_refused' as const;
  constructor(readonly reason: string) {
    super(`effect_refused: ${reason}`);
    this.name = 'EffectRefusedError';
  }
}

export interface TestHarness<TState, TAction> {
  startGame: () => Promise<void>;
  /**
   * Run a client action as `playerId`, with its effects. Throws
   * `EffectRefusedError` when the host would refuse an effect (nothing is
   * applied), and refuses a `role: "system"` action, which no client can
   * send (fire it with a timer and `advanceTime`).
   */
  performAction: (playerId: string, action: TAction) => Promise<void>;
  getState: () => TState;
  /**
   * Move the clock forward by `ms` and fire every timer that falls due on
   * the way, in due order, each as its system action with `ctx.now` = its
   * due time (effects included, so a timer may set the next one).
   */
  advanceTime: (ms: number) => Promise<void>;
  /** @deprecated `advanceTime(seconds * 1000)`. */
  advanceTimer: (seconds: number) => Promise<void>;
  /** The harness clock (ms). */
  now: () => number;
  /** The session's pending timers, as the host stores them. */
  getTimers: () => PendingTimer[];
  /** The plugin's storage in the community, after the effects applied so far. */
  getStorage: () => Record<string, unknown>;
  /** The chat posts applied so far, in order. */
  getChatPosts: () => string[];
  context: GamePluginContext<TState>;
}

/** A timer chain that never settles would loop forever. */
const MAX_FIRINGS_PER_ADVANCE = 10_000;

export function createTestHarness<TState = unknown, TAction = unknown>(
  options: TestHarnessOptions<TState, TAction>
): TestHarness<TState, TAction> {
  let state: TState | undefined;
  let clock = options.now ?? Date.now();
  let timers: PendingTimer[] = [];
  let storage: Record<string, unknown> = { ...(options.storage ?? {}) };
  const chatPosts: string[] = [];
  const permissions = options.permissions ?? options.plugin.manifest.permissions.filter(isEffectPermission);
  const policies = options.plugin.actionPolicies ?? {};
  const systemActions = Object.keys(policies).filter((type) => policies[type]?.role === 'system');

  // Mock sub-contexts
  const playersContext = {
    list: () => options.players,
    get: (id: string) => (options.players.includes(id) ? { id, name: `Player ${id}` } : undefined),
  };

  const messagesContext = {
    sendGameMessage: async (_msg: string) => {},
  };

  const stateContext = {
    save: async (newState: TState) => {
      state = newState;
    },
  };

  const cacheContext = {
    store: new Map<string, unknown>(),
    get: async (key: string) => cacheContext.store.get(key),
    set: async (key: string, value: unknown) => {
      cacheContext.store.set(key, value);
    },
  };

  const pubsubContext = {
    publish: async (_topic: string, _data: unknown) => {},
    subscribe: async (_topic: string, _callback: (data: unknown) => void) => {},
  };

  const timerContext = {
    start: async (_seconds: number) => {},
    stop: async () => {},
  };

  const votesContext = {
    create: async (_question: string, _options: string[]) => {},
  };

  const scoresContext = {
    store: new Map<string, number>(),
    add: async (playerId: string, score: number) => {
      const current = scoresContext.store.get(playerId) || 0;
      scoresContext.store.set(playerId, current + score);
    },
  };

  const voiceContext = {
    getParticipants: () => options.players,
  };

  const context: GamePluginContext<TState> = {
    actorUserId: options.players[0] ?? 'test-actor',
    players: playersContext,
    messages: messagesContext,
    state: stateContext,
    cache: cacheContext,
    pubsub: pubsubContext,
    timer: timerContext,
    votes: votesContext,
    scores: scoresContext,
    voice: voiceContext,
    storage: createStorageSnapshot(storage),
    now: clock,
  };

  /** One reducer call the way the host runs it: unwrap, validate, then apply everything or nothing. */
  const run = (actorUserId: string, now: number, call: () => unknown): void => {
    context.actorUserId = actorUserId;
    context.now = now;
    // Storage is only readable with the permission, as on the host.
    context.storage = createStorageSnapshot(permissions.includes('storage') ? storage : {});
    const { state: next, effects } = unwrapReducerResult(call());
    const valid = validateEffects(effects, { permissions, systemActions, now });
    if (!valid.ok) throw new EffectRefusedError(valid.error);
    const nextTimers = applyTimerEffects(timers, valid.effects);
    if (!nextTimers.ok) throw new EffectRefusedError(nextTimers.error);
    const nextStorage = applyStorageEffects(storage, valid.effects);
    if (!nextStorage.ok) throw new EffectRefusedError(nextStorage.error);
    state = next as TState;
    timers = nextTimers.timers;
    storage = nextStorage.entries;
    chatPosts.push(...chatPostsOf(valid.effects));
  };

  const advanceTime = async (ms: number): Promise<void> => {
    const target = clock + Math.max(0, ms);
    for (let fired = 0; ; fired++) {
      const due = nextDueTimer(timers, target);
      if (!due) break;
      if (fired >= MAX_FIRINGS_PER_ADVANCE) throw new Error('advanceTime: the timers keep re-arming; stopped after 10000 firings');
      clock = due.at;
      timers = timers.filter((timer) => timer !== due);
      const current = state as TState;
      run('', due.at, () => options.plugin.handleAction(context, current, due.action as TAction));
    }
    clock = target;
    context.now = clock;
  };

  return {
    context,
    startGame: async () => {
      timers = [];
      run(options.players[0] ?? 'test-actor', clock, () => options.plugin.createInitialState(context));
    },
    // Without startGame() the reducer gets `undefined` as the state (some
    // plugins start from their first action).
    performAction: async (playerId: string, action: TAction) => {
      const type = (action as { type?: unknown } | null)?.type;
      if (typeof type === 'string' && Object.hasOwn(policies, type) && policies[type]?.role === 'system') {
        throw new Error(`"${type}" is a system action: no client can send it (set a timer and advanceTime)`);
      }
      const current = state as TState;
      run(playerId, clock, () => options.plugin.handleAction(context, current, action));
    },
    getState: () => {
      if (state === undefined) {
        throw new Error('Game has not started yet. Call startGame() first.');
      }
      return state;
    },
    advanceTime,
    advanceTimer: (seconds: number) => advanceTime(seconds * 1000),
    now: () => clock,
    getTimers: () => timers.map((timer) => ({ ...timer, action: { ...timer.action } })),
    getStorage: () => structuredClone(storage),
    getChatPosts: () => [...chatPosts],
  };
}
