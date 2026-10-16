/**
 * Direct message channel queries — instance-local 1:1 conversations.
 *
 * A DM channel is unique per user pair (canonicalized so userAId < userBId).
 * Messages cascade-delete with the channel. The `lastMessageAt` column drives
 * sidebar ordering without a join.
 */
import { and, eq, isNull, notInArray, or, desc, lt, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { dmChannels, dmMessages, users } from '../schema.js';
import { isUserBlocked } from './userBlocks.js';
import { profileVisibilitySql, sharesServerSql, toProfileVisibility, userImageRefSql } from './userImages.js';
import type { ActivityVisibilityScope } from './userSettings.js';
import { completeLastMillisecond, inMillisecondOf } from './pagination.js';

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
  /**
   * security-review FILE-001: short image reference (version token or
   * legacy https URL) — never the stored data URL.
   */
  otherUserAvatarRef: string | null;
  /** security-review AUTHZ-005: the other participant's profile visibility. */
  otherUserProfileVisibility: ActivityVisibilityScope;
  /** Whether the caller and the other participant share a server. */
  sharesServerWithOtherUser: boolean;
  lastMessageAt: Date;
  /**
   * Who wrote the newest message still shown (deleted ones skipped), or
   * null before the first. The lobby's DM list marks a conversation unread
   * when it moved and the newest message is not the viewer's own.
   */
  lastMessageAuthorId: string | null;
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

/**
 * Canonicalize the pair so (A,B) and (B,A) map to the same row. The ids are
 * lower-cased FIRST (security review 2026-10, A8): Postgres stores a uuid
 * in lower case whatever case it was sent in, but JavaScript orders "A" <
 * "a", so a recipient id sent in upper case could order the pair the other
 * way round — a second conversation for the same two people, or (with the
 * caller's own id in upper case) a "DM" with oneself.
 */
function orderedPair(a: string, b: string): [string, string] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? [x, y] : [y, x];
}

async function selectPairRow(db: DbClient, userAId: string, userBId: string): Promise<DmChannelRow | null> {
  const [row] = await db
    .select()
    .from(dmChannels)
    .where(and(eq(dmChannels.userAId, userAId), eq(dmChannels.userBId, userBId)))
    .limit(1);
  return (row as DmChannelRow | undefined) ?? null;
}

/**
 * Find or create a DM channel between two users. Returns the existing row
 * if one already exists (idempotent on the user pair).
 *
 * Race-safe: two first messages at once both used to miss the lookup and
 * insert, and the loser hit the pair's unique index (a 500). The insert now
 * does nothing on that conflict and the winner's row is read back. A row
 * the case bug above stored the other way round is still found (no
 * migration rewrites it).
 */
export async function findOrCreateDmChannel(
  db: DbClient,
  currentUserId: string,
  otherUserId: string
): Promise<DmChannelRow> {
  const [userAId, userBId] = orderedPair(currentUserId, otherUserId);
  const existing = (await selectPairRow(db, userAId, userBId)) ?? (await selectPairRow(db, userBId, userAId));
  if (existing) return existing;

  const [created] = await db
    .insert(dmChannels)
    .values({
      userAId,
      userBId,
      createdBy: currentUserId.toLowerCase(),
    })
    .onConflictDoNothing({ target: [dmChannels.userAId, dmChannels.userBId] })
    .returning();
  if (created) return created as DmChannelRow;
  // A concurrent request created it first — adopt its row.
  const winner = await selectPairRow(db, userAId, userBId);
  if (!winner) throw new Error('findOrCreateDmChannel: the DM channel could not be written');
  return winner;
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
      otherAvatarRef: userImageRefSql(users.avatarUrl),
      otherProfileVisibility: profileVisibilitySql(users.id),
      sharesServer: sharesServerSql(userId, users.id),
      // One index probe per conversation (idx_dm_messages_channel_created).
      lastAuthorId: sql<string | null>`(
        select last_m.author_id from dm_messages last_m
        where last_m.dm_channel_id = ${dmChannels.id} and last_m.deleted_at is null
        order by last_m.created_at desc
        limit 1
      )`,
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
      otherUserAvatarRef: r.otherAvatarRef ?? null,
      otherUserProfileVisibility: toProfileVisibility(r.otherProfileVisibility),
      sharesServerWithOtherUser: r.sharesServer === true,
      lastMessageAt: r.channel.lastMessageAt,
      lastMessageAuthorId: r.lastAuthorId ?? null,
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

/** Fetch a single DM message (reply-target validation). */
export async function getDmMessageById(
  db: DbClient,
  messageId: string
): Promise<DmMessageRow | null> {
  const [row] = await db
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.id, messageId))
    .limit(1);
  return (row as DmMessageRow) ?? null;
}

/**
 * LF-SEC-006: canonical DM access decision, shared by REST and the WS
 * gateway so the policy cannot diverge.
 *
 * Product policy (documented):
 *   - read-history: participant-only. A block freezes communication but
 *     does not retroactively hide the conversation from a participant.
 *   - send / subscribe: participant AND no block in EITHER direction —
 *     a block on an EXISTING channel must stop new messages and
 *     realtime delivery immediately.
 */
/**
 * LF-SEC-003: find the DM channel between two users (no create). The
 * block route uses it to resolve which channel's live subscriptions
 * must be invalidated when a new block lands.
 */
export async function findDmChannelByPair(
  db: DbClient,
  userAId: string,
  userBId: string
): Promise<string | null> {
  const [a, b] = orderedPair(userAId, userBId);
  // Either order: a row stored the other way round (see orderedPair) is the
  // same conversation.
  const [row] = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .where(
      or(
        and(eq(dmChannels.userAId, a), eq(dmChannels.userBId, b)),
        and(eq(dmChannels.userAId, b), eq(dmChannels.userBId, a))
      )
    )
    .orderBy(desc(sql`${dmChannels.userAId} = ${a}`))
    .limit(1);
  return row?.id ?? null;
}

export interface DmRecipientEligibility {
  /** The recipient is a live (not soft-deleted) user. */
  exists: boolean;
  /**
   * Both users are current members of at least one live server — neither
   * holds an active ban there (a ban leaves the membership row in place).
   */
  sharesServer: boolean;
  /** The DM channel the pair already has (looked up only when they share no server). */
  existingChannelId: string | null;
}

/**
 * May `viewerUserId` open a DM with `recipientUserId`? The route opens one
 * only for a live user who shares a community with the caller, or with
 * whom the caller already has a conversation; anything else answers the
 * same 404 (no existence oracle — an unknown id used to be an FK error).
 */
export async function getDmRecipientEligibility(
  db: DbClient,
  viewerUserId: string,
  recipientUserId: string
): Promise<DmRecipientEligibility> {
  // Ids as PARAMETERS: a single-table select renders `users.id` unqualified,
  // which the memberships subquery would read as its own `id` column.
  const viewer = sql`${viewerUserId}::uuid`;
  const recipient = sql`${recipientUserId}::uuid`;
  const [row] = await db
    .select({
      sharesServer: sql<boolean>`exists (
        select 1 from memberships viewer_m
        join memberships recipient_m on recipient_m.server_id = viewer_m.server_id
        join servers shared_s on shared_s.id = viewer_m.server_id and shared_s.deleted_at is null
        where viewer_m.user_id = ${viewer} and recipient_m.user_id = ${recipient}
          and not exists (
            select 1 from server_bans b
            where b.server_id = viewer_m.server_id
              and b.user_id in (viewer_m.user_id, recipient_m.user_id)
              and (b.expires_at is null or b.expires_at > now())
          )
      )`,
    })
    .from(users)
    .where(and(eq(users.id, recipientUserId), isNull(users.deletedAt)))
    .limit(1);
  if (!row) return { exists: false, sharesServer: false, existingChannelId: null };
  const sharesServer = row.sharesServer === true;
  return {
    exists: true,
    sharesServer,
    existingChannelId: sharesServer ? null : await findDmChannelByPair(db, viewerUserId, recipientUserId),
  };
}

export type DmAccessDecision = 'ok' | 'not_found' | 'not_participant' | 'blocked';

export async function checkDmChannelAccess(
  db: DbClient,
  channelId: string,
  userId: string,
  operation: 'read-history' | 'send'
): Promise<DmAccessDecision> {
  const [row] = await db
    .select({ userAId: dmChannels.userAId, userBId: dmChannels.userBId })
    .from(dmChannels)
    .where(eq(dmChannels.id, channelId))
    .limit(1);
  if (!row) return 'not_found';

  const isParticipant = row.userAId === userId || row.userBId === userId;
  if (!isParticipant) return 'not_participant';

  if (operation === 'send') {
    const otherUserId = row.userAId === userId ? row.userBId : row.userAId;
    if (await isUserBlocked(db, userId, otherUserId)) return 'blocked';
    if (await isUserBlocked(db, otherUserId, userId)) return 'blocked';
  }
  return 'ok';
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
  // 1..100 (default 50) whatever the caller passed: NaN or 0 must not reach
  // LIMIT (security review 2026-10, A9 — the route validates it as well).
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(Math.trunc(options.limit!), 100)) : 50;
  const conditions: SQL[] = [eq(dmMessages.dmChannelId, channelId)];
  if (options.before && !Number.isNaN(options.before.getTime())) {
    conditions.push(lt(dmMessages.createdAt, options.before));
  }
  const select = (where: SQL[]) =>
    db
      .select()
      .from(dmMessages)
      .where(and(...where))
      .orderBy(desc(dmMessages.createdAt), desc(dmMessages.id));
  const page = (await select(conditions).limit(limit)) as DmMessageRow[];
  // Security review 2026-10 (A11): millisecond-complete pages
  // (./pagination.ts), so the next `before` skips nothing.
  return completeLastMillisecond(page, limit, async (boundary, seenIds) =>
    (await select([
      ...conditions,
      inMillisecondOf(dmMessages.createdAt, boundary),
      ...(seenIds.length > 0 ? [notInArray(dmMessages.id, seenIds)] : []),
    ])) as DmMessageRow[]
  );
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

/** The two participants of a DM channel, or null when it does not exist. */
export async function getDmChannelParticipants(
  db: DbClient,
  channelId: string
): Promise<{ userAId: string; userBId: string } | null> {
  const [row] = await db
    .select({ userAId: dmChannels.userAId, userBId: dmChannels.userBId })
    .from(dmChannels)
    .where(eq(dmChannels.id, channelId))
    .limit(1);
  return row ?? null;
}
