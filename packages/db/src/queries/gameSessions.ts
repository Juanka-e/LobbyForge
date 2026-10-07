/**
 * Game session queries — thin wrappers over the Drizzle client.
 *
 * A "game session" is an instance of a plugin running in a specific
 * channel. The row holds the plugin's current `state` (JSONB), a
 * `publicSummary` (JSONB) for cheap list views, a `status` field
 * (lobby / running / paused / ended / cancelled) that the read path
 * uses to filter out finished sessions, and an `endedAt` timestamp
 * as a redundant termination signal.
 *
 * Player membership lives in a separate `game_session_players` table
 * (one row per user per session, with `joinedAt` / `leftAt` /
 * `characterData`). The route layer uses `addPlayerToSession` /
 * `removePlayerFromSession` to mutate it; reads use
 * `listPlayersForSession` to enumerate active members.
 *
 * M16 scope:
 *   - The voice room's "Start Activity" button calls `createGameSession`.
 *   - The voice room's activity panel polls `getGameSessionById` every 2s
 *     to pick up state changes driven by other clients' actions.
 *   - The `actions` route calls `setGameSessionState` after running the
 *     plugin's `handleAction` to persist the new state.
 *   - The `end` route calls `endGameSession` to set `status = 'ended'`.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { pgErrorCode } from '../pg-errors.js';
import { gameSessionPlayers, gameSessions } from '../schema.js';

export interface GameSessionRow {
  id: string;
  serverId: string;
  channelId: string;
  pluginId: string;
  status: string;
  state: Record<string, unknown>;
  publicSummary: Record<string, unknown>;
  /**
   * M20a — `team_size` and `difficulty_distribution` are plugin-defined
   * knobs the session was started with. They mirror fields on the
   * persisted JSONB `state` so the reducer can read either source
   * (the columns are the source of truth at the row layer; the state
   * blob is what the reducer operates on). Nullable so non-team /
   * non-difficulty plugins don't have to populate them.
   */
  teamSize: number | null;
  difficultyDistribution: Record<string, number> | null;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface GameSessionPlayerRow {
  id: string;
  sessionId: string;
  userId: string;
  characterName: string | null;
  characterData: Record<string, unknown>;
  status: string;
  score: number;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface CreateGameSessionInput {
  serverId: string;
  channelId: string;
  pluginId: string;
  createdBy: string;
  state: Record<string, unknown>;
  publicSummary?: Record<string, unknown>;
  /**
   * M20a — optional plugin-defined knobs the session was started with.
   * `teamSize` becomes the `team_size` column; `difficultyDistribution`
   * becomes the JSONB column. Both default to NULL so non-team /
   * non-difficulty plugins don't have to set them.
   */
  teamSize?: number | null;
  difficultyDistribution?: Record<string, number> | null;
}

/**
 * Insert a new game session. The `status` defaults to `lobby`; the
 * plugin can transition to `running` from its first action. Returns
 * the persisted row.
 *
 * The per-channel mutex is enforced at the DB layer by the partial
 * unique index `game_sessions_channel_open_unique` (see migration
 * `0006_hushle_difficulty_and_team_size.sql`). A second open row in
 * the same channel throws a unique-constraint violation; the activity
 * start route catches it and translates to a 409.
 */
export async function createGameSession(
  db: DbClient,
  input: CreateGameSessionInput
): Promise<GameSessionRow> {
  const [row] = await db
    .insert(gameSessions)
    .values({
      serverId: input.serverId,
      channelId: input.channelId,
      pluginId: input.pluginId,
      status: 'lobby',
      createdBy: input.createdBy,
      state: input.state,
      publicSummary: input.publicSummary ?? {},
      teamSize: input.teamSize ?? null,
      difficultyDistribution: input.difficultyDistribution ?? null,
      // startedAt / endedAt: NULL until the plugin transitions.
    })
    .returning();
  if (!row) {
    throw new Error('createGameSession: insert returned no rows');
  }
  return row as GameSessionRow;
}

/**
 * Look up a session by id, treating ended sessions as gone. The
 * "ended" status is the soft-delete signal — the row sticks around as
 * an audit artifact, but the read path ignores it.
 */
export async function getGameSessionById(
  db: DbClient,
  sessionId: string
): Promise<GameSessionRow | null> {
  const [row] = await db
    .select()
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.id, sessionId),
        isNull(gameSessions.endedAt),
        sql`${gameSessions.status} <> 'ended'`
      )
    )
    .limit(1);
  return (row as GameSessionRow | undefined) ?? null;
}

/**
 * List the active sessions in a channel, newest first. Bounded to
 * 50 to keep the read cheap — a channel that runs more than 50
 * concurrent activities has a different problem.
 */
export async function listGameSessionsForChannel(
  db: DbClient,
  channelId: string
): Promise<GameSessionRow[]> {
  const rows = await db
    .select()
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.channelId, channelId),
        isNull(gameSessions.endedAt),
        sql`${gameSessions.status} <> 'ended'`
      )
    )
    .orderBy(desc(gameSessions.createdAt))
    .limit(50);
  return rows as GameSessionRow[];
}

export async function getActiveGameSessionForChannel(
  db: DbClient,
  channelId: string
): Promise<GameSessionRow | null> {
  const [row] = await db
    .select()
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.channelId, channelId),
        isNull(gameSessions.endedAt),
        sql`${gameSessions.status} in ('lobby', 'running', 'paused')`
      )
    )
    .orderBy(desc(gameSessions.createdAt))
    .limit(1);
  return (row as GameSessionRow | undefined) ?? null;
}

/**
 * Persist a new state blob. The route layer calls this after the
 * plugin's `handleAction` returns. We also bump `publicSummary` so
 * the list endpoint can show a small JSON dump without paying the
 * full-state read cost.
 */
export async function setGameSessionState(
  db: DbClient,
  sessionId: string,
  state: Record<string, unknown>,
  publicSummary?: Record<string, unknown>
): Promise<GameSessionRow | null> {
  const patch: Record<string, unknown> = { state, revision: sql`${gameSessions.revision} + 1` };
  if (publicSummary !== undefined) patch.publicSummary = publicSummary;
  const [row] = await db
    .update(gameSessions)
    .set(patch)
    .where(eq(gameSessions.id, sessionId))
    .returning();
  return (row as GameSessionRow | undefined) ?? null;
}

/**
 * Compare-and-swap state update with optimistic concurrency.
 * Returns { ok: true, row } on success, { ok: false, row } if the
 * revision didn't match (concurrent modification) or the session is
 * ended/cancelled. The caller should stop when `row.status` is terminal;
 * otherwise retry by re-reading the state, re-running the reducer, and
 * retrying with the new revision.
 *
 * The actions route writes through this inside `withGameSessionWriteLock`,
 * where the revision always matches; the check stays as the guard against
 * a writer that does not take the lock (and the terminal-status guard).
 */
export async function setGameSessionStateCAS(
  db: DbClient,
  sessionId: string,
  expectedRevision: number,
  state: Record<string, unknown>,
  publicSummary?: Record<string, unknown>
): Promise<{ ok: boolean; row: GameSessionRow | null }> {
  const patch: Record<string, unknown> = { state, revision: sql`${gameSessions.revision} + 1` };
  if (publicSummary !== undefined) patch.publicSummary = publicSummary;
  const [row] = await db
    .update(gameSessions)
    .set(patch)
    .where(
      and(
        eq(gameSessions.id, sessionId),
        eq(gameSessions.revision, expectedRevision),
        // beta-review: a terminal session is read-only. endGameSession
        // does not bump the revision, so without this guard an action
        // racing a concurrent END still committed onto the ended row.
        sql`${gameSessions.status} not in ('ended', 'cancelled')`
      )
    )
    .returning();
  if (row) return { ok: true, row: row as GameSessionRow };
  // Revision didn't match (concurrent modification) or the session is
  // terminal. Return the current row — callers check its status.
  const [current] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId)).limit(1);
  return { ok: false, row: (current as GameSessionRow | undefined) ?? null };
}

/** Advisory-lock key of one session's state writes (`hashtext` of it). */
export function gameSessionWriteLockKey(sessionId: string): string {
  return `lobbyforge:game-session-write:${sessionId}`;
}

/** How long a write waits for the session's lock before giving up. */
export const GAME_SESSION_LOCK_TIMEOUT_MS = 10_000;

/**
 * The session's write lock was not granted within the lock timeout — the
 * session is busy (a slow reducer, a burst of actions). Retryable.
 */
export class GameSessionBusyError extends Error {
  readonly code = 'game_session_busy' as const;
  constructor(sessionId: string) {
    super(`Game session ${sessionId} is busy; retry the write`);
    this.name = 'GameSessionBusyError';
  }
}

/** Postgres `lock_not_available` (lock_timeout expired), possibly wrapped by Drizzle. */
function isLockTimeout(err: unknown): boolean {
  return pgErrorCode(err) === '55P03';
}

// Per client (connection pool): the tail of each session's queue of writers.
const writeQueues = new WeakMap<object, Map<string, Promise<void>>>();

/** Run `task` after every earlier task queued for `key` on this pool has settled. */
async function queueBehind<T>(db: object, key: string, task: () => Promise<T>): Promise<T> {
  let queues = writeQueues.get(db);
  if (!queues) {
    queues = new Map();
    writeQueues.set(db, queues);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `previous` never rejects: every tail resolves through its `release`.
  const tail = previous.then(() => done);
  queues.set(key, tail);
  try {
    await previous;
    return await task();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/**
 * Serialize one session's read → reduce → write. Concurrent actions on a
 * session used to race on the CAS: of 8 players rolling dice at once only 3
 * or 4 got through the 3 optimistic attempts, the rest saw a 409.
 *
 * `fn` runs inside a transaction that holds a transaction-scoped Postgres
 * advisory lock on the session (`pg_advisory_xact_lock`), so writers run one
 * at a time across every web process; it receives the transaction and the
 * session row AS IT STANDS UNDER THE LOCK (null when the row is gone). Read
 * and write through `tx`: the lock lives on that one connection, and a second
 * pooled connection taken while holding it could wait on writers that each
 * hold one. The lock is released when the transaction ends — commit or
 * rollback — so a throw inside `fn` undoes its writes and frees the session.
 *
 * Within one process (one pool), writers to the same session also queue in
 * memory first, so a burst does not park one pooled connection per waiter
 * on the lock.
 *
 * Throws `GameSessionBusyError` when the lock is not granted within
 * `lockTimeoutMs` (default `GAME_SESSION_LOCK_TIMEOUT_MS`).
 */
export async function withGameSessionWriteLock<T>(
  db: DbClient,
  sessionId: string,
  fn: (tx: DbClient, row: GameSessionRow | null) => Promise<T>,
  options: { lockTimeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(options.lockTimeoutMs ?? GAME_SESSION_LOCK_TIMEOUT_MS));
  return queueBehind(db, sessionId, async () => {
    try {
      return await db.transaction(async (tx) => {
        // SET LOCAL cannot take a parameter; set_config(..., true) is the same.
        await tx.execute(sql`select set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${gameSessionWriteLockKey(sessionId)}))`);
        const [row] = await tx.select().from(gameSessions).where(eq(gameSessions.id, sessionId)).limit(1);
        return fn(tx as unknown as DbClient, (row as GameSessionRow | undefined) ?? null);
      });
    } catch (err) {
      if (isLockTimeout(err)) throw new GameSessionBusyError(sessionId);
      throw err;
    }
  });
}

/**
 * Move a session's hosting (`created_by`, which the host reads as "the
 * host") to another user. Compare-and-swap on the CURRENT host, so two
 * requests that both decided to move it cannot both win — the loser gets
 * null and re-reads. A terminal (ended / cancelled) session is refused.
 *
 * `state`, when given, is written in the same statement (a plugin's own
 * notion of host, from `onHostChange`). The revision is bumped either way,
 * so a writer holding an older revision re-reads before it writes. Call it
 * inside `withGameSessionWriteLock` (pass its `tx`) to serialize with
 * actions on the session.
 */
export async function transferGameSessionHost(
  db: DbClient,
  sessionId: string,
  input: { fromUserId: string | null; toUserId: string; state?: Record<string, unknown> }
): Promise<GameSessionRow | null> {
  const patch: Record<string, unknown> = {
    createdBy: input.toUserId,
    revision: sql`${gameSessions.revision} + 1`,
  };
  if (input.state !== undefined) patch.state = input.state;
  const [row] = await db
    .update(gameSessions)
    .set(patch)
    .where(
      and(
        eq(gameSessions.id, sessionId),
        input.fromUserId === null ? isNull(gameSessions.createdBy) : eq(gameSessions.createdBy, input.fromUserId),
        isNull(gameSessions.endedAt),
        sql`${gameSessions.status} in ('lobby', 'running', 'paused')`
      )
    )
    .returning();
  return (row as GameSessionRow | undefined) ?? null;
}

/**
 * Mark a session as ended. Sets `status = 'ended'` and
 * `endedAt = now()`. Returns the updated row, or null if the session
 * didn't exist.
 */
export async function endGameSession(
  db: DbClient,
  sessionId: string
): Promise<GameSessionRow | null> {
  const [row] = await db
    .update(gameSessions)
    .set({
      status: 'ended',
      endedAt: new Date(),
    })
    .where(eq(gameSessions.id, sessionId))
    .returning();
  return (row as GameSessionRow | undefined) ?? null;
}

/**
 * Add a player to a session. Idempotent: if a row already exists for
 * (sessionId, userId) with `leftAt IS NULL`, returns it as-is;
 * otherwise inserts a new active row.
 */
export async function addPlayerToSession(
  db: DbClient,
  sessionId: string,
  userId: string
): Promise<GameSessionPlayerRow> {
  const [existing] = await db
    .select()
    .from(gameSessionPlayers)
    .where(
      and(
        eq(gameSessionPlayers.sessionId, sessionId),
        eq(gameSessionPlayers.userId, userId),
        isNull(gameSessionPlayers.leftAt)
      )
    )
    .limit(1);
  if (existing) return existing as GameSessionPlayerRow;
  const [row] = await db
    .insert(gameSessionPlayers)
    .values({ sessionId, userId })
    .returning();
  if (!row) throw new Error('addPlayerToSession: insert returned no rows');
  return row as GameSessionPlayerRow;
}

/**
 * Mark a player as having left the session. Idempotent: leaving a
 * session the user isn't in is a no-op. Returns the updated row, or
 * null if the session didn't exist.
 */
export async function removePlayerFromSession(
  db: DbClient,
  sessionId: string,
  userId: string
): Promise<GameSessionPlayerRow | null> {
  const [row] = await db
    .update(gameSessionPlayers)
    .set({ leftAt: new Date(), status: 'left' })
    .where(
      and(
        eq(gameSessionPlayers.sessionId, sessionId),
        eq(gameSessionPlayers.userId, userId),
        isNull(gameSessionPlayers.leftAt)
      )
    )
    .returning();
  return (row as GameSessionPlayerRow | undefined) ?? null;
}

/**
 * List the currently-active players for a session (leftAt IS NULL).
 * Used by the activity route to build the plugin's `players`
 * sub-context and by the UI to render the participant list.
 */
export async function listPlayersForSession(
  db: DbClient,
  sessionId: string
): Promise<GameSessionPlayerRow[]> {
  const rows = await db
    .select()
    .from(gameSessionPlayers)
    .where(
      and(eq(gameSessionPlayers.sessionId, sessionId), isNull(gameSessionPlayers.leftAt))
    )
    .orderBy(asc(gameSessionPlayers.joinedAt));
  return rows as GameSessionPlayerRow[];
}
