import { GamePlugin, GamePluginContext } from './index.js';

export interface TestHarnessOptions<TState, TAction> {
  plugin: GamePlugin<TState, TAction>;
  players: string[];
  settings?: Record<string, unknown>;
}

export interface TestHarness<TState, TAction> {
  startGame: () => Promise<void>;
  performAction: (playerId: string, action: TAction) => Promise<void>;
  getState: () => TState;
  advanceTimer: (seconds: number) => Promise<void>;
  context: GamePluginContext<TState>;
}

export function createTestHarness<TState = unknown, TAction = unknown>(
  options: TestHarnessOptions<TState, TAction>
): TestHarness<TState, TAction> {
  let state: TState;
  let currentTimerSeconds = 0;
  const timerCallback: () => Promise<void> = async () => {};

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
    start: async (seconds: number) => {
      currentTimerSeconds = seconds;
    },
    stop: async () => {
      currentTimerSeconds = 0;
    },
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
  };

  return {
    context,
    startGame: async () => {
      state = options.plugin.createInitialState(context);
    },
    performAction: async (playerId: string, action: TAction) => {
      context.actorUserId = playerId;
      state = options.plugin.handleAction(context, state, action);
    },
    getState: () => {
      if (state === undefined) {
        throw new Error('Game has not started yet. Call startGame() first.');
      }
      return state;
    },
    advanceTimer: async (seconds: number) => {
      if (currentTimerSeconds > 0) {
        currentTimerSeconds = Math.max(0, currentTimerSeconds - seconds);
      }
      if (currentTimerSeconds === 0) {
        await timerCallback();
      }
    },
  };
}
