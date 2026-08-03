/**
 * HTTP context builder for plugins.
 *
 * The plugin SDK defines a rich `GamePluginContext` (players, messages,
 * state, cache, pubsub, timer, votes, scores, voice). For the M16
 * HTTP-host scenario, most of these are no-op stubs — the host
 * persists state via `setGameSessionState` after `handleAction`
 * returns, so the plugin's `state.save` is a write-back no-op; the
 * timer / cache / pubsub / scores sub-contexts are exposed but not
 * wired to anything (M17+ will add Redis-backed implementations).
 *
 * The `messages.sendGameMessage` is a console.log stub so a plugin
 * that wants to post to the channel during M16 has a non-throwing
 * surface to call.
 */
import type {
  GamePluginContext,
  RegisteredGamePlugin,
} from '@lobbyforge/plugin-sdk';
import type { DbClient } from '@lobbyforge/db';
import { listPlayersForSession } from '@lobbyforge/db';

export interface BuildPluginContextInput {
  db: DbClient;
  sessionId: string;
  actorUserId: string;
}

/**
 * Build a `GamePluginContext` for an HTTP call. The returned object
 * is plain — it does not retain a reference to the db transaction,
 * so the route layer is free to commit/rollback before the plugin
 * finishes its work.
 */
export async function buildHttpPluginContext(
  input: BuildPluginContextInput
): Promise<GamePluginContext> {
  // The SDK's `PlayersSubContext` is synchronous. For the HTTP host
  // we cache a snapshot of the active players at the start of the
  // call (and again at the end, if the plugin's handleAction adds
  // anyone — which the host persists in a follow-up query).
  const playersSnapshot: Array<{ userId: string; characterName: string | null }> = [];
  try {
    const rows = await listPlayersForSession(input.db, input.sessionId);
    for (const r of rows) {
      playersSnapshot.push({ userId: r.userId, characterName: r.characterName });
    }
  } catch {
    // If the session doesn't exist yet, the snapshot is empty.
  }
  const playersContext = {
    list: (): string[] => playersSnapshot.map((p) => p.userId),
    get: (playerId: string) => {
      const row = playersSnapshot.find((p) => p.userId === playerId);
      if (!row) return undefined;
      return { id: row.userId, name: row.characterName ?? row.userId };
    },
  };

  const messagesContext = {
    sendGameMessage: async (message: string): Promise<void> => {
      // M16 stub: the route layer would call `createMessage` here
      // once M17 lands message-writeback. For M16 we just log so
      // the plugin's intent is visible in server output.
      console.warn(`[plugin:activity] ${input.sessionId} says: ${message}`);
    },
  };

  const stateContext = {
    // The host persists state in `setGameSessionState` AFTER the
    // plugin returns. `state.save` is a no-op so the plugin can
    // call it without an error.
    save: async (_state: unknown): Promise<void> => {
      // intentionally empty
    },
  };

  const cacheContext = {
    get: async <T = unknown>(_key: string): Promise<T | undefined> => undefined,
    set: async (_key: string, _value: unknown, _ttlSeconds?: number): Promise<void> => {
      // intentionally empty
    },
  };

  const pubsubContext = {
    publish: async (_topic: string, _data: unknown): Promise<void> => {
      // intentionally empty
    },
    subscribe: async (
      _topic: string,
      _callback: (data: unknown) => void
    ): Promise<void> => {
      // intentionally empty
    },
  };

  const timerContext = {
    start: async (_seconds: number): Promise<void> => {
      // intentionally empty
    },
    stop: async (): Promise<void> => {
      // intentionally empty
    },
  };

  const votesContext = {
    create: async (_question: string, _options: string[]): Promise<void> => {
      // intentionally empty
    },
  };

  const scoresContext = {
    add: async (_playerId: string, _score: number): Promise<void> => {
      // intentionally empty
    },
  };

  const voiceContext = {
    // M16 doesn't bridge plugin voice calls to the livekit room.
    // Returning the players list is the closest meaningful answer.
    getParticipants: (): string[] => [],
  };

  return {
    actorUserId: input.actorUserId,
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
}

/**
 * Compute the initial state of a plugin against the HTTP context. Most
 * plugins ignore the context for this; the signature is part of the
 * SDK so the host has a uniform call site.
 */
export function callCreateInitialState(
  plugin: RegisteredGamePlugin,
  ctx: GamePluginContext
): unknown {
  try {
    return plugin.createInitialState(ctx);
  } catch (err) {
    console.error(`[plugin-context] createInitialState threw for "${plugin.manifest.id}":`, (err as Error).message);
    throw new Error(`Plugin "${plugin.manifest.id}" failed to initialize.`);
  }
}

/**
 * Dispatch an action through the plugin. We trust the plugin's
 * handleAction to be a pure function of (state, action, ctx) — the
 * host does not enforce that, but every registered plugin is a
 * redux-style reducer. For dynamically-loaded plugins (marketplace),
 * a try/catch prevents a buggy reducer from crashing the API route.
 */
export function callHandleAction(
  plugin: RegisteredGamePlugin,
  ctx: GamePluginContext,
  state: unknown,
  action: unknown
): unknown {
  try {
    return plugin.handleAction(ctx, state, action);
  } catch (err) {
    console.error(`[plugin-context] handleAction threw for "${plugin.manifest.id}":`, (err as Error).message);
    throw new Error(`Plugin "${plugin.manifest.id}" failed to handle action.`);
  }
}
