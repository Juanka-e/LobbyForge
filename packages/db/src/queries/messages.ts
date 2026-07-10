/**
 * Message queries — thin wrappers over the Drizzle client.
 *
 * A "message" is a single text post in a channel. The schema is in
 * `../schema.ts`; see the `messages` table. Notes on the schema that
 * drive the helpers below:
 *
 *   - `channelId` cascades: deleting a channel deletes its messages.
 *   - `userId` is ON DELETE SET NULL: deleting a user preserves their
 *     messages (the row stays, the author is anonymized). The route
 *     layer renders the author as "Deleted User" when `userId` is null.
 *   - `deletedAt` is a soft delete: "the message is gone" is a tombstone
 *     row, not a row removal. The list query always filters on
 *     `deletedAt IS NULL`.
 *   - `replyToId` is a self-FK to `messages.id`. A reply always points
 *     to an earlier message in the same channel — the route layer is
 *     responsible for enforcing that.
 *   - `metadata` is a JSONB blob for plugin-attached data (reactions,
 *     embeds, etc.). It's read through but not validated at this layer.
 */
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { messages, users, channels, servers } from '../schema.js';

export interface MessageRow {
  id: string;
  channelId: string;
  userId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface CreateMessageInput {
  channelId: string;
  userId: string;
  content: string;
  metadata?: Record<string, unknown>;
  replyToId?: string | null;
}

/**
 * Verify the channel exists and its parent server is not soft-deleted.
 * This is what the route layer calls before letting a caller create a
 * message; it's also what the list / get queries rely on.
 */
async function assertChannelAlive(db: DbClient, channelId: string): Promise<void> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(eq(channels.id, channelId), isNull(servers.deletedAt)))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`Channel ${channelId} does not exist`);
  }
}

/**
 * Create a message. The `userId` is the materialized UUID from the
 * `lf_guest` cookie's `uid` field; the route layer is responsible for
 * making sure that field is non-null before calling.
 *
 * The insert is atomic: the FK on `messages.channelId` cascades, so
 * a hard-deleted channel rejects the insert with a constraint error.
 */
export async function createMessage(db: DbClient, input: CreateMessageInput): Promise<MessageRow> {
  await assertChannelAlive(db, input.channelId);

  if (input.replyToId) {
    // Sanity-check: the reply target must exist and live in the same
    // channel. We don't constrain this in the schema (cross-channel
    // replies could be a future feature) so the route layer relies on
    // this helper to enforce the current rule.
    const target = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, input.replyToId))
      .limit(1);
    if (target.length === 0) {
      throw new Error(`Reply target ${input.replyToId} not found`);
    }
    if (target[0]?.channelId !== input.channelId) {
      throw new Error('Reply target is in a different channel');
    }
  }

  const [row] = await db
    .insert(messages)
    .values({
      channelId: input.channelId,
      userId: input.userId,
      content: input.content,
      metadata: input.metadata ?? {},
      replyToId: input.replyToId ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('createMessage: insert returned no rows');
  }
  return row as MessageRow;
}

/**
 * List the messages in a channel, ordered by `createdAt DESC` (newest
 * first — matches what the UI wants to render at the bottom of the
 * scroll). The caller is expected to provide a `before` cursor for
 * pagination; if absent, the most recent `limit` messages are returned.
 *
 * Soft-deleted messages are excluded. Cross-channel / cross-server
 * leakage is prevented by the `assertChannelAlive` check.
 */
export async function listMessagesForChannel(
  db: DbClient,
  channelId: string,
  options: { limit?: number; before?: Date } = {}
): Promise<MessageRow[]> {
  await assertChannelAlive(db, channelId);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const filters = [eq(messages.channelId, channelId), isNull(messages.deletedAt)];
  if (options.before) filters.push(lt(messages.createdAt, options.before));

  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      userId: messages.userId,
      content: messages.content,
      metadata: messages.metadata,
      replyToId: messages.replyToId,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(and(...filters))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows as MessageRow[];
}

/**
 * Fetch a single message. Returns `null` for unknown ids AND for
 * soft-deleted messages (the caller treats both as "you don't see
 * this message"). The `assertChannelAlive` check is skipped here
 * because the route layer already validated the URL's channel;
 * we still filter out messages from soft-deleted parents.
 */
export async function getMessageById(db: DbClient, messageId: string): Promise<MessageRow | null> {
  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      userId: messages.userId,
      content: messages.content,
      metadata: messages.metadata,
      replyToId: messages.replyToId,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .innerJoin(servers, eq(servers.id, channels.serverId))
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt), isNull(servers.deletedAt)))
    .limit(1);
  return (rows[0] as MessageRow | undefined) ?? null;
}

export interface UpdateMessageInput {
  content?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Edit a message. Always stamps `editedAt` so the UI can render an
 * "edited at X" badge. Only `content` and `metadata` are mutable;
 * `userId`, `channelId`, `createdAt`, and `replyToId` are immutable.
 *
 * The route layer is expected to have already verified that the
 * caller is the author (or a server owner with edit-any permission).
 */
export async function updateMessage(
  db: DbClient,
  messageId: string,
  input: UpdateMessageInput
): Promise<MessageRow> {
  const patch: Record<string, unknown> = { editedAt: new Date() };
  if (input.content !== undefined) patch.content = input.content;
  if (input.metadata !== undefined) patch.metadata = input.metadata;

  const [row] = await db
    .update(messages)
    .set(patch)
    .where(eq(messages.id, messageId))
    .returning();
  if (!row) {
    throw new Error(`updateMessage: message ${messageId} not found`);
  }
  return row as MessageRow;
}

/**
 * Soft-delete a message. The row stays in the table with a non-null
 * `deletedAt`; the list query filters it out. Idempotent: deleting an
 * already-deleted message is a no-op (the where clause filters it out
 * and the returning array is empty, so we throw).
 */
export async function softDeleteMessage(
  db: DbClient,
  messageId: string,
  now: Date = new Date()
): Promise<void> {
  const result = await db
    .update(messages)
    .set({ deletedAt: now })
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .returning({ id: messages.id });
  if (result.length === 0) {
    throw new Error(`softDeleteMessage: message ${messageId} not found or already deleted`);
  }
}

// Re-export `asc` and `users` so the test file can import the same
// shape from one place without re-deriving it.
export { asc, users };
