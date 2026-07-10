/**
 * Channel queries — thin wrappers over the Drizzle client.
 *
 * A "channel" lives inside a server and is the unit of (a) text chat and
 * (b) voice / activity rooms. The schema is in `../schema.ts`; see the
 * `channels` table.
 *
 * The `type` column is free-text today (matching the spec §6 which calls
 * out `text / voice / activity / announcement / stage`). A future migration
 * will replace it with a Postgres enum once the plugin ecosystem settles.
 */
import { and, asc, eq, isNull, sql, lt, lte, gt, gte } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { channels, servers } from '../schema.js';

export type ChannelType = 'text' | 'voice' | 'activity' | 'announcement' | 'stage';

export interface ChannelRow {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  position: number;
  pluginId: string | null;
  topic: string | null;
  createdAt: Date;
}

export interface CreateChannelInput {
  serverId: string;
  name: string;
  type: ChannelType;
  position?: number;
  topic?: string | null;
  pluginId?: string | null;
}

/**
 * Verify the parent server exists and is not soft-deleted. The caller
 * is expected to be a member of the server — that authorization check
 * lives in the route layer (see `apps/web/app/api/servers/[id]/channels/...`).
 */
async function assertServerExists(db: DbClient, serverId: string): Promise<void> {
  const rows = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`Server ${serverId} does not exist`);
  }
}

/**
 * Create a channel in the given server. The `position` defaults to
 * `(max(position) + 1)` for the server so a freshly created channel
 * appears at the bottom of the list — this matches Discord / Slack
 * semantics. If the server has no channels yet, the new one gets
 * position 0.
 */
export async function createChannel(db: DbClient, input: CreateChannelInput): Promise<ChannelRow> {
  await assertServerExists(db, input.serverId);

  // Compute the next position in a single round-trip. If the server has
  // no existing channels, COALESCE returns 0 and the new row goes to 0.
  const nextPositionRows = await db
    .select({ next: channels.position })
    .from(channels)
    .where(eq(channels.serverId, input.serverId))
    .orderBy(asc(channels.position))
    .limit(1_000); // bounded; positions are dense in practice

  const computedPosition =
    input.position !== undefined
      ? input.position
      : nextPositionRows.length === 0
        ? 0
        : Math.max(...nextPositionRows.map((r) => r.next)) + 1;

  const [row] = await db
    .insert(channels)
    .values({
      serverId: input.serverId,
      name: input.name,
      type: input.type,
      position: computedPosition,
      topic: input.topic ?? null,
      pluginId: input.pluginId ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('createChannel: insert returned no rows');
  }
  return row as ChannelRow;
}

/**
 * List the channels in a server, ordered by position ascending. Soft-deleted
 * servers are excluded by joining on `servers.deletedAt IS NULL` (we can't
 * just filter on the channels side because channels have no `deletedAt` —
 * a server-level delete cascades and removes them in the FK action).
 */
export async function listChannelsForServer(
  db: DbClient,
  serverId: string,
  options: { limit?: number } = {}
): Promise<ChannelRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const rows = await db
    .select({
      id: channels.id,
      serverId: channels.serverId,
      name: channels.name,
      type: channels.type,
      position: channels.position,
      pluginId: channels.pluginId,
      topic: channels.topic,
      createdAt: channels.createdAt,
    })
    .from(channels)
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(eq(channels.serverId, serverId), isNull(servers.deletedAt)))
    .orderBy(asc(channels.position))
    .limit(limit);
  return rows as ChannelRow[];
}

/**
 * Fetch a single channel. Returns `null` if the channel doesn't exist
 * OR the parent server is soft-deleted. The caller should not treat
 * these two cases differently (the user-facing behavior is the same:
 * "you don't see this channel").
 */
export async function getChannelById(db: DbClient, channelId: string): Promise<ChannelRow | null> {
  const rows = await db
    .select({
      id: channels.id,
      serverId: channels.serverId,
      name: channels.name,
      type: channels.type,
      position: channels.position,
      pluginId: channels.pluginId,
      topic: channels.topic,
      createdAt: channels.createdAt,
    })
    .from(channels)
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(eq(channels.id, channelId), isNull(servers.deletedAt)))
    .limit(1);
  return (rows[0] as ChannelRow | undefined) ?? null;
}

export interface UpdateChannelInput {
  name?: string;
  topic?: string | null;
  position?: number;
}

/**
 * Partial update for a channel. Only the fields supplied in `input` are
 * touched; the rest of the row is left alone. The caller is expected to
 * have verified the channel exists and the user has the right permission.
 */
export async function updateChannel(
  db: DbClient,
  channelId: string,
  input: UpdateChannelInput
): Promise<ChannelRow> {
  const patch: Partial<UpdateChannelInput> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.topic !== undefined) patch.topic = input.topic;
  if (input.position !== undefined) patch.position = input.position;

  if (Object.keys(patch).length === 0) {
    // Nothing to update — return the current row so the route can return 200.
    const existing = await getChannelById(db, channelId);
    if (!existing) throw new Error(`Channel ${channelId} not found`);
    return existing;
  }

  return db.transaction(async (tx) => {
    if (input.position !== undefined) {
      const [current] = await tx
        .select({ serverId: channels.serverId, position: channels.position })
        .from(channels)
        .where(eq(channels.id, channelId));
      if (!current) throw new Error(`updateChannel: channel ${channelId} not found`);

      const oldPos = current.position;
      const newPos = input.position;

      if (oldPos !== newPos) {
        if (newPos > oldPos) {
          // Shift channels between oldPos+1 and newPos down by 1
          await tx
            .update(channels)
            .set({ position: sql`${channels.position} - 1` })
            .where(
              and(
                eq(channels.serverId, current.serverId),
                gt(channels.position, oldPos),
                lte(channels.position, newPos)
              )
            );
        } else {
          // Shift channels between newPos and oldPos-1 up by 1
          await tx
            .update(channels)
            .set({ position: sql`${channels.position} + 1` })
            .where(
              and(
                eq(channels.serverId, current.serverId),
                gte(channels.position, newPos),
                lt(channels.position, oldPos)
              )
            );
        }
      }
    }

    const [row] = await tx
      .update(channels)
      .set(patch)
      .where(eq(channels.id, channelId))
      .returning();
    if (!row) {
      throw new Error(`updateChannel: channel ${channelId} not found`);
    }
    return row as ChannelRow;
  });
}

/**
 * Hard-delete a channel. The schema's `ON DELETE CASCADE` on
 * `channels.serverId` handles the case where the parent server is deleted;
 * this helper exists for explicit channel removal by an owner.
 */
export async function deleteChannel(db: DbClient, channelId: string): Promise<void> {
  await db.delete(channels).where(eq(channels.id, channelId));
}
