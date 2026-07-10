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
  const patch: Record<string, unknown> = { state };
  if (publicSummary !== undefined) patch.publicSummary = publicSummary;
  const [row] = await db
    .update(gameSessions)
    .set(patch)
    .where(eq(gameSessions.id, sessionId))
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
