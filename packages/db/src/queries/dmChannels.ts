/**
 * Direct message channel queries — instance-local 1:1 conversations.
 *
 * A DM channel is unique per user pair (canonicalized so userAId < userBId).
 * Messages cascade-delete with the channel. The `lastMessageAt` column drives
 * sidebar ordering without a join.
 */
import { and, eq, or, desc, lt } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { dmChannels, dmMessages, users } from '../schema.js';

export interface DmChannelRow {
  id: string;
  userAId: string;
  userBId: string;
  createdBy: string;
  lastMessageAt: Date;
  createdAt: Date;
}

export interface DmChannelSummary {
  id: string;
  /** The OTHER participant's user id (not the caller). */
  otherUserId: string;
  otherUserDisplayName: string;
  otherUserAvatarUrl: string | null;
  lastMessageAt: Date;
}

export interface DmMessageRow {
  id: string;
  dmChannelId: string;
  authorId: string;
  content: string;
  replyToId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

/** Canonicalize the pair so (A,B) and (B,A) map to the same row. */
function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Find or create a DM channel between two users. Returns the existing row
 *  if one already exists (idempotent on the user pair). */
export async function findOrCreateDmChannel(
  db: DbClient,
  currentUserId: string,
  otherUserId: string
): Promise<DmChannelRow> {
  const [userAId, userBId] = orderedPair(currentUserId, otherUserId);
  // Try to find an existing channel first.
  const [existing] = await db
    .select()
    .from(dmChannels)
    .where(
      and(eq(dmChannels.userAId, userAId), eq(dmChannels.userBId, userBId))
    )
    .limit(1);
  if (existing) return existing as DmChannelRow;

  const [created] = await db
    .insert(dmChannels)
    .values({
      userAId,
      userBId,
      createdBy: currentUserId,
    })
    .returning();
  return created as DmChannelRow;
}

/** List all DM channels for a user, with the other participant's profile. */
export async function listDmChannelsForUser(
  db: DbClient,
  userId: string
): Promise<DmChannelSummary[]> {
  const rows = await db
    .select({
      channel: dmChannels,
      otherId: users.id,
      otherName: users.displayName,
      otherAvatar: users.avatarUrl,
    })
    .from(dmChannels)
    .leftJoin(users, or(eq(users.id, dmChannels.userAId), eq(users.id, dmChannels.userBId)))
    .where(or(eq(dmChannels.userAId, userId), eq(dmChannels.userBId, userId)));

  // Filter out the self-join row (the join matches BOTH participants).
  return rows
    .filter((r) => r.otherId !== null && r.otherId !== userId)
    .map((r) => ({
      id: r.channel.id,
      otherUserId: r.otherId!,
      otherUserDisplayName: r.otherName ?? 'Unknown',
      otherUserAvatarUrl: r.otherAvatar ?? null,
      lastMessageAt: r.channel.lastMessageAt,
    }))
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
}

/** Verify the caller is a participant in the DM channel. */
export async function isDmChannelParticipant(
  db: DbClient,
  channelId: string,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ userAId: dmChannels.userAId, userBId: dmChannels.userBId })
    .from(dmChannels)
    .where(eq(dmChannels.id, channelId))
    .limit(1);
  if (!row) return false;
  return row.userAId === userId || row.userBId === userId;
}

/** Send a DM message and bump the channel's lastMessageAt. */
export async function sendDmMessage(
  db: DbClient,
  channelId: string,
  authorId: string,
  content: string,
  replyToId?: string | null
): Promise<DmMessageRow> {
  // Transactional: message insert + channel timestamp bump must succeed together.
  return await db.transaction(async (tx) => {
    const [message] = await tx
      .insert(dmMessages)
      .values({
        dmChannelId: channelId,
        authorId,
        content: content.slice(0, 4000),
        ...(replyToId ? { replyToId } : {}),
      })
      .returning();
    await tx
      .update(dmChannels)
      .set({ lastMessageAt: new Date() })
      .where(eq(dmChannels.id, channelId));
    return message as DmMessageRow;
  });
}

/** List messages in a DM channel (paginated by cursor). */
export async function listDmMessages(
  db: DbClient,
  channelId: string,
  options: { limit?: number; before?: Date } = {}
): Promise<DmMessageRow[]> {
  const limit = Math.min(options.limit ?? 50, 100);
  const conditions = [eq(dmMessages.dmChannelId, channelId)];
  if (options.before) {
    conditions.push(lt(dmMessages.createdAt, options.before));
  }
  const rows = await db
    .select()
    .from(dmMessages)
    .where(and(...conditions))
    .orderBy(desc(dmMessages.createdAt))
    .limit(limit);
  return rows as DmMessageRow[];
}

/** Soft-delete a DM message (author only; enforced by the route). */
export async function deleteDmMessage(
  db: DbClient,
  messageId: string
): Promise<void> {
  await db
    .update(dmMessages)
    .set({ deletedAt: new Date() })
    .where(eq(dmMessages.id, messageId));
}
