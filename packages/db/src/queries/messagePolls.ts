/**
 * Polls in text channels (0047, docs/CHAT_POLLS.md).
 *
 * A poll rides on a message row: the message's `content` is the question
 * (what bots, search and notifications see) and its `metadata.poll.id`
 * points at the `message_polls` row. Both are written in ONE transaction.
 *
 * Anonymity: `message_poll_votes` keeps who chose what (a vote can be
 * changed or removed, and "your vote" shows on every device), but nothing
 * here returns another member's choice — reads come back as per-option
 * counts, the number of voters, and the CALLER's own choices.
 *
 * Closing is lazy: a poll is closed once `closesAt` has passed or
 * `closedAt` is set. Every write takes `now` so the routes (and tests)
 * decide with one clock.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { channels, messagePollVotes, messagePolls, messages, servers } from '../schema.js';
import type { MessageRow } from './messages.js';

export interface MessagePollRow {
  id: string;
  messageId: string;
  channelId: string;
  creatorUserId: string | null;
  question: string;
  options: string[];
  allowMultiple: boolean;
  closesAt: Date;
  closedAt: Date | null;
  closedByUserId: string | null;
  createdAt: Date;
}

/** A poll with its public tally and the viewer's own choices — never anyone else's. */
export interface MessagePollWithTally extends MessagePollRow {
  /** Votes per option, by option index (same length as `options`). */
  counts: number[];
  /** How many members have voted (a multiple-choice voter counts once). */
  totalVoters: number;
  /** The viewer's chosen option indexes, ascending; empty when they have not voted. */
  viewerChoices: number[];
}

export interface CreateMessagePollInput {
  channelId: string;
  userId: string;
  question: string;
  options: string[];
  allowMultiple: boolean;
  closesAt: Date;
}

/** True once the poll has passed its closing time or was closed early. */
export function isMessagePollClosed(poll: { closesAt: Date; closedAt: Date | null }, now: Date = new Date()): boolean {
  return poll.closedAt !== null || poll.closesAt.getTime() <= now.getTime();
}

const pollColumns = {
  id: messagePolls.id,
  messageId: messagePolls.messageId,
  channelId: messagePolls.channelId,
  creatorUserId: messagePolls.creatorUserId,
  question: messagePolls.question,
  options: messagePolls.options,
  allowMultiple: messagePolls.allowMultiple,
  closesAt: messagePolls.closesAt,
  closedAt: messagePolls.closedAt,
  closedByUserId: messagePolls.closedByUserId,
  createdAt: messagePolls.createdAt,
};

function toPollRow(row: Record<string, unknown>): MessagePollRow {
  const options = Array.isArray(row.options) ? (row.options as unknown[]).map((o) => String(o)) : [];
  return {
    id: row.id as string,
    messageId: row.messageId as string,
    channelId: row.channelId as string,
    creatorUserId: (row.creatorUserId as string | null) ?? null,
    question: row.question as string,
    options,
    allowMultiple: Boolean(row.allowMultiple),
    closesAt: row.closesAt as Date,
    closedAt: (row.closedAt as Date | null) ?? null,
    closedByUserId: (row.closedByUserId as string | null) ?? null,
    createdAt: row.createdAt as Date,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Create the message and its poll together. The message carries
 * `metadata.poll = { id }` (a server-only key — the messages route refuses
 * it from clients); the poll row points back at the message. Throws when
 * the channel does not exist or its server is deleted, like createMessage.
 */
export async function createMessagePoll(
  db: DbClient,
  input: CreateMessagePollInput
): Promise<{ message: MessageRow; poll: MessagePollRow }> {
  const pollId = randomUUID();
  return db.transaction(async (tx) => {
    const alive = await tx
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(servers, eq(servers.id, channels.serverId))
      .where(and(eq(channels.id, input.channelId), isNull(servers.deletedAt)))
      .limit(1);
    if (alive.length === 0) throw new Error(`Channel ${input.channelId} does not exist`);

    const [message] = await tx
      .insert(messages)
      .values({
        channelId: input.channelId,
        userId: input.userId,
        botId: null,
        content: input.question,
        metadata: { poll: { id: pollId } },
        replyToId: null,
      })
      .returning();
    if (!message) throw new Error('createMessagePoll: message insert returned no rows');

    const [poll] = await tx
      .insert(messagePolls)
      .values({
        id: pollId,
        messageId: message.id,
        channelId: input.channelId,
        creatorUserId: input.userId,
        question: input.question,
        options: input.options,
        allowMultiple: input.allowMultiple,
        closesAt: input.closesAt,
      })
      .returning();
    if (!poll) throw new Error('createMessagePoll: poll insert returned no rows');
    return { message: message as MessageRow, poll: toPollRow(poll) };
  });
}

/** A poll by id, or null when unknown or its message was deleted. */
export async function getMessagePollById(db: DbClient, pollId: string): Promise<MessagePollRow | null> {
  const rows = await db
    .select(pollColumns)
    .from(messagePolls)
    .innerJoin(messages, eq(messages.id, messagePolls.messageId))
    .where(and(eq(messagePolls.id, pollId), isNull(messages.deletedAt)))
    .limit(1);
  return rows[0] ? toPollRow(rows[0]) : null;
}

/**
 * The polls of a page of messages, each with its tally and the viewer's
 * own choices, in ONE query (correlated subqueries per poll row). Keyed by
 * message id. Polls of deleted messages are left out.
 *
 * The subqueries name the outer row as "message_polls"."id" on purpose: a
 * Drizzle column interpolated into raw SQL renders unqualified in some
 * selects, and a bare "id" would bind to the wrong table.
 */
export async function listMessagePollsForMessages(
  db: DbClient,
  messageIds: readonly string[],
  viewerUserId: string | null
): Promise<Map<string, MessagePollWithTally>> {
  const out = new Map<string, MessagePollWithTally>();
  const ids = Array.from(new Set(messageIds));
  if (ids.length === 0) return out;
  return loadWithTally(db, inArray(messagePolls.messageId, ids), viewerUserId, (poll) => {
    out.set(poll.messageId, poll);
  }).then(() => out);
}

/** One poll with its tally and the viewer's own choices; null when unknown or its message was deleted. */
export async function getMessagePollWithTally(
  db: DbClient,
  pollId: string,
  viewerUserId: string | null
): Promise<MessagePollWithTally | null> {
  let found: MessagePollWithTally | null = null;
  await loadWithTally(db, eq(messagePolls.id, pollId), viewerUserId, (poll) => {
    found = poll;
  });
  return found;
}

async function loadWithTally(
  db: DbClient,
  where: SQL,
  viewerUserId: string | null,
  each: (poll: MessagePollWithTally) => void
): Promise<void> {
  const viewer = viewerUserId ?? '00000000-0000-0000-0000-000000000000';
  const rows = await db
    .select({
      ...pollColumns,
      counts: sql<unknown>`coalesce((
        select jsonb_object_agg("c"."option_index", "c"."n")
        from (
          select "v"."option_index", count(*)::int as "n"
          from "message_poll_votes" "v"
          where "v"."poll_id" = "message_polls"."id"
          group by "v"."option_index"
        ) "c"
      ), '{}'::jsonb)`,
      voters: sql<number>`(
        select count(distinct "v"."user_id")::int
        from "message_poll_votes" "v"
        where "v"."poll_id" = "message_polls"."id"
      )`,
      mine: sql<unknown>`coalesce((
        select jsonb_agg("v"."option_index" order by "v"."option_index")
        from "message_poll_votes" "v"
        where "v"."poll_id" = "message_polls"."id" and "v"."user_id" = ${viewer}::uuid
      ), '[]'::jsonb)`,
    })
    .from(messagePolls)
    .innerJoin(messages, eq(messages.id, messagePolls.messageId))
    .where(and(where, isNull(messages.deletedAt)));

  for (const row of rows) {
    const poll = toPollRow(row);
    const countsByIndex = (parseJson(row.counts) ?? {}) as Record<string, unknown>;
    const counts = poll.options.map((_, index) => Number(countsByIndex[String(index)] ?? 0) || 0);
    const mineRaw = parseJson(row.mine);
    const viewerChoices = viewerUserId && Array.isArray(mineRaw)
      ? mineRaw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < poll.options.length)
      : [];
    each({ ...poll, counts, totalVoters: Number(row.voters) || 0, viewerChoices });
  }
}

export type MessagePollWriteResult = { ok: true } | { ok: false; reason: 'not_found' | 'closed' };

/**
 * Lock the poll for this voter's write and check it is still open. The
 * advisory lock serializes one member's writes to one poll (two devices
 * voting at once cannot leave a single-choice poll with two rows); the
 * FOR SHARE row lock waits out a concurrent close.
 */
async function lockOpenPoll(
  tx: Parameters<Parameters<DbClient['transaction']>[0]>[0],
  pollId: string,
  userId: string,
  now: Date
): Promise<MessagePollWriteResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lobbyforge:poll-vote:${pollId}:${userId}`}))`);
  const [poll] = await tx
    .select({ closesAt: messagePolls.closesAt, closedAt: messagePolls.closedAt })
    .from(messagePolls)
    .innerJoin(messages, eq(messages.id, messagePolls.messageId))
    .where(and(eq(messagePolls.id, pollId), isNull(messages.deletedAt)))
    .for('share', { of: messagePolls })
    .limit(1);
  if (!poll) return { ok: false, reason: 'not_found' };
  if (isMessagePollClosed(poll, now)) return { ok: false, reason: 'closed' };
  return { ok: true };
}

/**
 * Set the member's vote: replaces whatever they chose before. The route
 * validates `optionIndexes` against the poll (count, range, duplicates)
 * first; this only writes.
 */
export async function setMessagePollVote(
  db: DbClient,
  input: { pollId: string; userId: string; optionIndexes: readonly number[]; now?: Date }
): Promise<MessagePollWriteResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const open = await lockOpenPoll(tx, input.pollId, input.userId, now);
    if (!open.ok) return open;
    await tx
      .delete(messagePollVotes)
      .where(and(eq(messagePollVotes.pollId, input.pollId), eq(messagePollVotes.userId, input.userId)));
    const unique = Array.from(new Set(input.optionIndexes));
    if (unique.length > 0) {
      await tx
        .insert(messagePollVotes)
        .values(unique.map((optionIndex) => ({ pollId: input.pollId, userId: input.userId, optionIndex })))
        .onConflictDoNothing();
    }
    return { ok: true } as const;
  });
}

/** Remove the member's vote (a no-op when they had none) — only while the poll is open. */
export async function clearMessagePollVote(
  db: DbClient,
  input: { pollId: string; userId: string; now?: Date }
): Promise<MessagePollWriteResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const open = await lockOpenPoll(tx, input.pollId, input.userId, now);
    if (!open.ok) return open;
    await tx
      .delete(messagePollVotes)
      .where(and(eq(messagePollVotes.pollId, input.pollId), eq(messagePollVotes.userId, input.userId)));
    return { ok: true } as const;
  });
}

/**
 * Close a poll early. Only an open poll closes: an expired one or one
 * closed before answers `closed`; a missing one (or its message deleted)
 * `not_found`. The route checks who may close.
 */
export async function closeMessagePoll(
  db: DbClient,
  input: { pollId: string; userId: string; now?: Date }
): Promise<{ ok: true; poll: MessagePollRow } | { ok: false; reason: 'not_found' | 'closed' }> {
  const now = input.now ?? new Date();
  const updated = await db
    .update(messagePolls)
    .set({ closedAt: now, closedByUserId: input.userId })
    .where(and(eq(messagePolls.id, input.pollId), isNull(messagePolls.closedAt), gt(messagePolls.closesAt, now)))
    .returning();
  if (updated[0]) return { ok: true, poll: toPollRow(updated[0]) };
  const existing = await getMessagePollById(db, input.pollId);
  return { ok: false, reason: existing ? 'closed' : 'not_found' };
}

/**
 * Delete the poll of a message (its votes cascade). The messages DELETE
 * route soft-deletes the message row, which the FK cascade never sees —
 * so it calls this too: a deleted poll message leaves no ballots behind.
 * Returns true when a poll was removed.
 */
export async function deleteMessagePollForMessage(db: DbClient, messageId: string): Promise<boolean> {
  const removed = await db
    .delete(messagePolls)
    .where(eq(messagePolls.messageId, messageId))
    .returning({ id: messagePolls.id });
  return removed.length > 0;
}
