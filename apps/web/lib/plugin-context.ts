/**
 * HTTP context builder for plugins.
 *
 * The plugin SDK defines a rich `GamePluginContext` (players, messages,
 * state, cache, pubsub, timer, votes, scores, voice, storage). Reducers
 * are pure and synchronous, so what a plugin wants the host to DO goes
 * through effects (`withEffects`, lib/activity-effects.ts), not through
 * ctx methods:
 *
 *  - `ctx.storage` is a read-only snapshot of the plugin's storage in the
 *    community (`get`, `keys`); the routes fill it for the call
 *    (`setCallContext`) when the plugin has the `storage` permission, and
 *    writes are `storage.set` / `storage.delete` effects.
 *  - `ctx.timer` and `ctx.messages` are deprecated no-op stubs: timers are
 *    `timer.set` / `timer.clear` effects, chat lines `chat.post` effects.
 *  - `state.save`, cache, pubsub, votes and scores are no-ops — the host
 *    persists the returned state itself.
 *  - `ctx.now` is the call's clock (a timer's due time for a system action).
 */
import {
  createStorageSnapshot,
  type GamePluginContext,
  type RegisteredGamePlugin,
} from '@lobbyforge/plugin-sdk';
import type { DbClient } from '@lobbyforge/db';
import { listPlayersForSession, users } from '@lobbyforge/db';
import { inArray } from 'drizzle-orm';

export interface BuildPluginContextInput {
  db: DbClient;
  sessionId: string;
  actorUserId: string;
  /**
   * A user joining the roster with this action: listed in `ctx.players`
   * while it runs, before the host has written them to the roster.
   */
  pendingPlayerId?: string;
  /** The community and plugin the call runs for (the sandbox envelope's scope). */
  serverId?: string;
  pluginId?: string;
  /**
   * The user ids in the activity's voice room (LiveKit), oldest first, when
   * the route read them — `ctx.voice.getParticipants()` returns them.
   */
  voiceParticipantIds?: readonly string[];
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
  const playersSnapshot: Array<{ userId: string; name: string }> = [];
  try {
    const rows: Array<{ userId: string; characterName: string | null }> = await listPlayersForSession(
      input.db,
      input.sessionId
    );
    if (input.pendingPlayerId && !rows.some((r) => r.userId === input.pendingPlayerId)) {
      rows.push({ userId: input.pendingPlayerId, characterName: null });
    }
    // A player is named by their in-game character when they chose one,
    // else by their display name — never by a raw user id when a name exists.
    const ids = rows.map((r) => r.userId);
    const names = new Map<string, string>();
    if (ids.length > 0) {
      try {
        const found = await input.db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, ids));
        for (const u of found) names.set(u.id, u.displayName);
      } catch {
        // Names are cosmetic: fall back to ids rather than fail the action.
      }
    }
    for (const r of rows) {
      playersSnapshot.push({ userId: r.userId, name: r.characterName ?? names.get(r.userId) ?? r.userId });
    }
  } catch {
    // If the session doesn't exist yet, the snapshot is empty.
  }
  const playersContext = {
    list: (): string[] => playersSnapshot.map((p) => p.userId),
    get: (playerId: string) => {
      const row = playersSnapshot.find((p) => p.userId === playerId);
      if (!row) return undefined;
      return { id: row.userId, name: row.name };
    },
  };

  const messagesContext = {
    // Deprecated: a reducer returns a `chat.post` effect instead. Logged so
    // the plugin's intent is visible in server output.
    sendGameMessage: async (message: string): Promise<void> => {
      console.warn(
        `[plugin:activity] ${input.sessionId}: ctx.messages.sendGameMessage is deprecated (return a chat.post effect):`,
        JSON.stringify(String(message).slice(0, 200))
      );
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

  // Deprecated no-ops: a reducer returns `timer.set` / `timer.clear` effects instead.
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

  // Who is in the activity's voice room, as the route read it from LiveKit
  // for this call (lib/activity-voice.ts) — the actions route reads it for
  // plugins that require voice. Empty when nobody asked.
  const voiceSnapshot = [...(input.voiceParticipantIds ?? [])];
  const voiceContext = {
    getParticipants: (): string[] => [...voiceSnapshot],
  };

  // The plugin's storage: empty until the route fills the call's snapshot
  // (lib/activity-effects.ts setCallContext — only with the `storage`
  // permission). A reducer cannot await a database; it writes with effects.
  const storageContext = createStorageSnapshot({});

  const ctx: GamePluginContext = {
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
    storage: storageContext,
    now: Date.now(),
  };
  // Non-enumerable scope for the isolated worker runtime: the worker-backed
  // plugin packages (serverId, pluginId) into its RPC envelope. Invisible to
  // in-process plugins (not enumerable, not in the SDK contract).
  Object.defineProperty(ctx, '__lfScope', {
    value: { serverId: input.serverId, pluginId: input.pluginId },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return ctx;
}

/** CPU budget for plugin reducer calls (ms). A reducer that takes longer
 *  than this is considered hung/malicious and the call is aborted. */
const PLUGIN_TIMEOUT_MS = 5_000;

/**
 * Run a synchronous plugin function with a wall-clock timeout. Since the
 * function runs in-process (no true sandbox), this at least prevents
 * infinite loops from hanging the API route indefinitely. The function
 * runs in the next microtask via Promise.resolve, so the event loop can
 * still process the timeout.
 */
function runWithTimeout<T>(fn: () => T, pluginId: string, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Plugin "${pluginId}" timed out after ${ms}ms`));
    }, ms);
    try {
      const result = fn();
      clearTimeout(timer);
      resolve(result);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/**
 * Compute the initial state of a plugin. Wrapped in try/catch + timeout.
 * Now async — callers must await.
 */
export async function callCreateInitialState(
  plugin: RegisteredGamePlugin,
  ctx: GamePluginContext
): Promise<unknown> {
  try {
    return await runWithTimeout(
      () => plugin.createInitialState(ctx),
      plugin.manifest.id,
      PLUGIN_TIMEOUT_MS
    );
  } catch (err) {
    console.error(`[plugin-context] createInitialState failed for "${plugin.manifest.id}":`, (err as Error).message);
    throw new Error(`Plugin "${plugin.manifest.id}" failed to initialize.`);
  }
}

/**
 * Dispatch an action through the plugin. Wrapped in try/catch + timeout
 * to prevent infinite loops in dynamically-loaded marketplace plugins.
 * Now async — callers must await.
 */
export async function callHandleAction(
  plugin: RegisteredGamePlugin,
  ctx: GamePluginContext,
  state: unknown,
  action: unknown
): Promise<unknown> {
  try {
    return await runWithTimeout(
      () => plugin.handleAction(ctx, state, action),
      plugin.manifest.id,
      PLUGIN_TIMEOUT_MS
    );
  } catch (err) {
    console.error(`[plugin-context] handleAction failed for "${plugin.manifest.id}":`, (err as Error).message);
    throw new Error(`Plugin "${plugin.manifest.id}" failed to handle action.`);
  }
}
