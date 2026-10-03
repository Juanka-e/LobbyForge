/**
 * Server join requests (0043) — the approval queue behind an access policy
 * that holds newcomers for a moderator (`accessPolicyRequiresApproval`).
 *
 * security-review AUTHZ-004 first made every membership path REFUSE under
 * such a policy, because there was nowhere to hold a newcomer. Now:
 *   - an invite redeem (`redeemInvite`) files a PENDING request instead of
 *     a membership — or returns the one already pending;
 *   - the /lobby never files one on a page load (`autoJoinServer` only
 *     reports the state); its "Ask to join" button does, through
 *     POST /api/servers/{id}/join-requests/mine (`requestToJoinServer`);
 *   - a moderator approves it (`approveJoinRequest`: the membership is
 *     created exactly like the auto-join creates one, with any stored
 *     sanction) or rejects it (`rejectJoinRequest`);
 *   - the requester can cancel it (`cancelJoinRequest`).
 *
 * Bans win everywhere: a banned user cannot file a request, a ban rejects
 * the pending one (`banUser`), and approval re-checks the ban. A rejection
 * written by a ban is flagged `rejectedByBan` and starts no cooldown: while
 * the ban lasts it keeps the user out anyway, and once it is lifted (or
 * expires) the user may ask again at once.
 *
 * Flood limits (on top of the routes' rate limits):
 *   - one PENDING request per (server, user) — a partial unique index;
 *   - after a moderator's rejection, no new request for
 *     JOIN_REQUEST_REJECTION_COOLDOWN_MS;
 *   - at most JOIN_REQUEST_DAILY_LIMIT requests per (server, user) per 24 h,
 *     whatever became of them (a cancel → re-request loop stops there);
 *   - an invite-sourced request consumes one use of the invite — once per
 *     user and code (`hasFiledThroughInvite`, see `redeemInvite`), so a
 *     code's `maxUses` bounds how many people it can put in the queue, and
 *     a withdraw → re-request loop does not burn the code's uses.
 */
import { and, desc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbClient } from '../client.js';
import { invites, memberships, serverJoinRequests, users } from '../schema.js';
import { isCurrentlyBanned } from './bans.js';
import { createMembershipWithEveryone, getServerMember, type MembershipRow } from './memberships.js';
import { isNewMemberApprovalRequired } from './serverAccessPolicies.js';

export type JoinRequestSource = 'invite' | 'auto_join';
export type JoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** The longest note a requester can leave for the moderators (characters). */
export const JOIN_REQUEST_NOTE_MAX_LENGTH = 500;
/** After a rejection, the user cannot ask again for this long (7 days). */
export const JOIN_REQUEST_REJECTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Requests one user may file to one server per rolling 24 hours. */
export const JOIN_REQUEST_DAILY_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface JoinRequestRow {
  id: string;
  serverId: string;
  userId: string;
  source: JoinRequestSource;
  inviteCode: string | null;
  note: string | null;
  status: JoinRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  /** The rejection was written by a ban — it starts no cooldown. */
  rejectedByBan: boolean;
}

/** Trimmed, at most JOIN_REQUEST_NOTE_MAX_LENGTH characters, null when empty. */
export function normalizeJoinRequestNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  if (!trimmed) return null;
  // Code points, like Postgres char_length — never splits a surrogate pair.
  return Array.from(trimmed).slice(0, JOIN_REQUEST_NOTE_MAX_LENGTH).join('');
}

/** When a rejected user may ask again. */
export function joinRequestRetryAfter(request: Pick<JoinRequestRow, 'decidedAt' | 'createdAt'>): Date {
  return new Date((request.decidedAt ?? request.createdAt).getTime() + JOIN_REQUEST_REJECTION_COOLDOWN_MS);
}

function forServerAndUser(serverId: string, userId: string): SQL {
  return and(eq(serverJoinRequests.serverId, serverId), eq(serverJoinRequests.userId, userId)) as SQL;
}

/** The user's PENDING request to the server, or null. */
export async function getPendingJoinRequest(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<JoinRequestRow | null> {
  const [row] = await db
    .select()
    .from(serverJoinRequests)
    .where(and(forServerAndUser(serverId, userId), eq(serverJoinRequests.status, 'pending')))
    .limit(1);
  return (row as JoinRequestRow | undefined) ?? null;
}

/**
 * The request that still decides what the user sees: their PENDING
 * request, else their latest moderator rejection while its cooldown runs,
 * else null (approved and cancelled requests are history, and so is a
 * rejection written by a ban: the ban itself keeps the user out while it
 * lasts, and lifting it must not leave a 7-day cooldown behind).
 */
export async function getOpenJoinRequest(
  db: DbClient,
  serverId: string,
  userId: string,
  now: Date = new Date()
): Promise<JoinRequestRow | null> {
  const cooldownStart = new Date(now.getTime() - JOIN_REQUEST_REJECTION_COOLDOWN_MS);
  const [row] = await db
    .select()
    .from(serverJoinRequests)
    .where(
      and(
        forServerAndUser(serverId, userId),
        or(
          eq(serverJoinRequests.status, 'pending'),
          and(
            eq(serverJoinRequests.status, 'rejected'),
            eq(serverJoinRequests.rejectedByBan, false),
            gt(serverJoinRequests.decidedAt, cooldownStart)
          )
        )
      )
    )
    .orderBy(sql`(${serverJoinRequests.status} = 'pending') desc`, desc(serverJoinRequests.createdAt))
    .limit(1);
  return (row as JoinRequestRow | undefined) ?? null;
}

/**
 * Whether the user already filed a request to this server through this
 * invite code — whatever became of it (pending, approved, rejected,
 * cancelled). That request took one use of the invite, so `redeemInvite`
 * charges no second one: withdrawing and asking again, or asking again
 * after a cooldown, does not burn the code's uses.
 */
export async function hasFiledThroughInvite(
  db: DbClient,
  input: { serverId: string; userId: string; inviteCode: string }
): Promise<boolean> {
  const [row] = await db
    .select({ id: serverJoinRequests.id })
    .from(serverJoinRequests)
    .where(and(forServerAndUser(input.serverId, input.userId), eq(serverJoinRequests.inviteCode, input.inviteCode)))
    .limit(1);
  return row !== undefined;
}

export type FileJoinRequestResult =
  | { kind: 'pending'; request: JoinRequestRow; created: boolean }
  | { kind: 'rejected'; request: JoinRequestRow; retryAfter: Date }
  | { kind: 'limited' };

/**
 * File a join request, or return the one already pending. The caller has
 * already decided the user needs approval (`isNewMemberApprovalRequired`)
 * and is neither banned nor a member. A recent rejection is returned as
 * `rejected` (nothing is written); too many requests in 24 h as `limited`.
 */
export async function fileJoinRequest(
  db: DbClient,
  input: {
    serverId: string;
    userId: string;
    source: JoinRequestSource;
    inviteCode?: string | null;
    note?: string | null;
  },
  now: Date = new Date()
): Promise<FileJoinRequestResult> {
  const open = await getOpenJoinRequest(db, input.serverId, input.userId, now);
  if (open?.status === 'pending') return { kind: 'pending', request: open, created: false };
  if (open) return { kind: 'rejected', request: open, retryAfter: joinRequestRetryAfter(open) };

  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(serverJoinRequests)
    .where(
      and(
        forServerAndUser(input.serverId, input.userId),
        gt(serverJoinRequests.createdAt, new Date(now.getTime() - DAY_MS))
      )
    );
  if (Number(recent?.n ?? 0) >= JOIN_REQUEST_DAILY_LIMIT) return { kind: 'limited' };

  const [created] = await db
    .insert(serverJoinRequests)
    .values({
      serverId: input.serverId,
      userId: input.userId,
      source: input.source,
      inviteCode: input.inviteCode ?? null,
      note: normalizeJoinRequestNote(input.note),
      status: 'pending',
      createdAt: now,
    })
    // The partial unique index (one pending per server + user): a
    // concurrent request won — adopt its row below.
    .onConflictDoNothing()
    .returning();
  if (created) return { kind: 'pending', request: created as JoinRequestRow, created: true };

  const raced = await getPendingJoinRequest(db, input.serverId, input.userId);
  if (!raced) throw new Error('fileJoinRequest: the request could not be written');
  return { kind: 'pending', request: raced, created: false };
}

export type AutoJoinOutcome =
  | { kind: 'member'; membership: MembershipRow; created: boolean }
  | { kind: 'banned' }
  /**
   * The server holds newcomers for approval. Nothing was written: `open`
   * is the user's pending request, or a moderator rejection still in its
   * cooldown, or null (they may ask — `requestToJoinServer`).
   */
  | { kind: 'approval_required'; open: JoinRequestRow | null };

/**
 * The /lobby auto-join on an open instance (a page load — a GET). Like
 * `ensureServerMembershipDetailed`, but a server whose access policy holds
 * newcomers for approval reports where the user stands instead of a bare
 * refusal. It NEVER files a join request: a page load (possibly a
 * cross-site top-level link) must not put anyone in the queue — the
 * lobby's "Ask to join" button does that (`requestToJoinServer`).
 * `created` is true only when THIS call created the membership — the
 * Welcome Bot greets only a real join.
 */
export async function autoJoinServer(
  db: DbClient,
  serverId: string,
  userId: string,
  now: Date = new Date()
): Promise<AutoJoinOutcome> {
  if (await isCurrentlyBanned(db, serverId, userId)) return { kind: 'banned' };
  const existing = await getServerMember(db, serverId, userId);
  if (existing) return { kind: 'member', membership: existing, created: false };
  if (await isNewMemberApprovalRequired(db, serverId, userId)) {
    return { kind: 'approval_required', open: await getOpenJoinRequest(db, serverId, userId, now) };
  }
  const joined = await createMembershipWithEveryone(db, serverId, userId);
  return { kind: 'member', membership: joined.membership, created: joined.created };
}

export type RequestToJoinOutcome =
  | { kind: 'banned' }
  | { kind: 'already_member' }
  /** The server admits newcomers without approval — the lobby joins them on load. */
  | { kind: 'approval_not_required' }
  | FileJoinRequestResult;

/**
 * The lobby's "Ask to join" (POST /api/servers/{id}/join-requests/mine):
 * file an `auto_join` request with the user's optional note, under the
 * same rules as an invite-filed one — bans first, then membership, then
 * one pending request, the rejection cooldown and the daily limit
 * (`fileJoinRequest`). The route decides whether the user may ask this
 * server without an invite at all.
 */
export async function requestToJoinServer(
  db: DbClient,
  input: { serverId: string; userId: string; note?: string | null },
  now: Date = new Date()
): Promise<RequestToJoinOutcome> {
  if (await isCurrentlyBanned(db, input.serverId, input.userId)) return { kind: 'banned' };
  if (await getServerMember(db, input.serverId, input.userId)) return { kind: 'already_member' };
  if (!(await isNewMemberApprovalRequired(db, input.serverId, input.userId))) {
    return { kind: 'approval_not_required' };
  }
  return fileJoinRequest(
    db,
    { serverId: input.serverId, userId: input.userId, source: 'auto_join', note: input.note ?? null },
    now
  );
}

export interface JoinRequestListItem extends JoinRequestRow {
  displayName: string;
  isGuest: boolean;
  /** When the requester's account was created — a fresh account is worth a closer look. */
  accountCreatedAt: Date;
  /** Display name of whoever created the invite used, while that invite still exists. */
  inviterName: string | null;
  decidedByName: string | null;
}

/**
 * A pending request whose user is a member by now (the policy was switched
 * off and they joined another way) is not waiting for anyone — leave it out.
 */
function stillWaitingSql(): SQL {
  return sql`(${serverJoinRequests.status} <> 'pending' or not exists (
    select 1 from ${memberships}
    where ${memberships.serverId} = ${serverJoinRequests.serverId}
      and ${memberships.userId} = ${serverJoinRequests.userId}
  ))`;
}

/**
 * The moderation list. Pending requests first, oldest first (a queue);
 * then, with `status: 'all'`, decided ones, most recent decision first.
 * Requesters whose account is soft-deleted are left out. `pendingCount`
 * counts every pending request regardless of the page.
 */
export async function listJoinRequestsForServer(
  db: DbClient,
  serverId: string,
  options: { status?: 'pending' | 'all'; limit?: number; offset?: number } = {}
): Promise<{ requests: JoinRequestListItem[]; pendingCount: number; nextOffset: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const inviter = alias(users, 'join_request_inviter');
  const decider = alias(users, 'join_request_decider');
  const visible = and(
    eq(serverJoinRequests.serverId, serverId),
    isNull(users.deletedAt),
    stillWaitingSql(),
    ...(options.status === 'all' ? [] : [eq(serverJoinRequests.status, 'pending')])
  );

  const rows = await db
    .select({
      id: serverJoinRequests.id,
      serverId: serverJoinRequests.serverId,
      userId: serverJoinRequests.userId,
      source: serverJoinRequests.source,
      inviteCode: serverJoinRequests.inviteCode,
      note: serverJoinRequests.note,
      status: serverJoinRequests.status,
      createdAt: serverJoinRequests.createdAt,
      decidedAt: serverJoinRequests.decidedAt,
      decidedBy: serverJoinRequests.decidedBy,
      rejectedByBan: serverJoinRequests.rejectedByBan,
      displayName: users.displayName,
      isGuest: users.isGuest,
      accountCreatedAt: users.createdAt,
      inviterName: inviter.displayName,
      decidedByName: decider.displayName,
    })
    .from(serverJoinRequests)
    .innerJoin(users, eq(users.id, serverJoinRequests.userId))
    .leftJoin(
      invites,
      and(eq(invites.code, serverJoinRequests.inviteCode), eq(invites.serverId, serverJoinRequests.serverId))
    )
    .leftJoin(inviter, eq(inviter.id, invites.createdBy))
    .leftJoin(decider, eq(decider.id, serverJoinRequests.decidedBy))
    .where(visible)
    .orderBy(
      sql`case when ${serverJoinRequests.status} = 'pending' then 0 else 1 end`,
      sql`case when ${serverJoinRequests.status} = 'pending' then ${serverJoinRequests.createdAt} end asc`,
      sql`coalesce(${serverJoinRequests.decidedAt}, ${serverJoinRequests.createdAt}) desc`,
      desc(serverJoinRequests.id)
    )
    .limit(limit + 1)
    .offset(offset);

  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(serverJoinRequests)
    .innerJoin(users, eq(users.id, serverJoinRequests.userId))
    .where(
      and(
        eq(serverJoinRequests.serverId, serverId),
        eq(serverJoinRequests.status, 'pending'),
        isNull(users.deletedAt),
        stillWaitingSql()
      )
    );

  const page = rows.slice(0, limit) as JoinRequestListItem[];
  return {
    requests: page,
    pendingCount: Number(counted?.n ?? 0),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export type DecideJoinRequestError = 'not_found' | 'not_pending' | 'banned';

export type ApproveJoinRequestResult =
  | { ok: true; request: JoinRequestRow; membership: MembershipRow; created: boolean }
  | { ok: false; error: DecideJoinRequestError; request?: JoinRequestRow };

async function lockJoinRequest(
  tx: DbClient,
  serverId: string,
  requestId: string
): Promise<JoinRequestRow | null> {
  const [row] = await tx
    .select()
    .from(serverJoinRequests)
    .where(and(eq(serverJoinRequests.id, requestId), eq(serverJoinRequests.serverId, serverId)))
    .for('update');
  return (row as JoinRequestRow | undefined) ?? null;
}

async function setDecision(
  tx: DbClient,
  requestId: string,
  status: Exclude<JoinRequestStatus, 'pending'>,
  decidedBy: string,
  now: Date,
  options: { rejectedByBan?: boolean } = {}
): Promise<JoinRequestRow> {
  const [row] = await tx
    .update(serverJoinRequests)
    .set({ status, decidedAt: now, decidedBy, ...(options.rejectedByBan ? { rejectedByBan: true } : {}) })
    .where(eq(serverJoinRequests.id, requestId))
    .returning();
  if (!row) throw new Error(`setDecision: join request ${requestId} disappeared`);
  return row as JoinRequestRow;
}

/**
 * Approve a pending request: create the membership the way the auto-join
 * does (`createMembershipWithEveryone` — @everyone, stored timeout and
 * server mute) and record the decision, in ONE transaction with the
 * request row locked, so two moderators cannot both decide it. A user who
 * was banned meanwhile is not admitted: the request is rejected instead
 * (flagged `rejectedByBan`: no cooldown once the ban is lifted) and
 * `banned` returned. The route layer checks the moderator's permission.
 */
export async function approveJoinRequest(
  db: DbClient,
  input: { serverId: string; requestId: string; decidedBy: string },
  now: Date = new Date()
): Promise<ApproveJoinRequestResult> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as DbClient;
    const request = await lockJoinRequest(executor, input.serverId, input.requestId);
    if (!request) return { ok: false as const, error: 'not_found' as const };
    if (request.status !== 'pending') return { ok: false as const, error: 'not_pending' as const, request };
    if (await isCurrentlyBanned(executor, input.serverId, request.userId)) {
      const rejected = await setDecision(executor, request.id, 'rejected', input.decidedBy, now, {
        rejectedByBan: true,
      });
      return { ok: false as const, error: 'banned' as const, request: rejected };
    }
    const joined = await createMembershipWithEveryone(executor, input.serverId, request.userId);
    const approved = await setDecision(executor, request.id, 'approved', input.decidedBy, now);
    return { ok: true as const, request: approved, membership: joined.membership, created: joined.created };
  });
}

export type RejectJoinRequestResult =
  | { ok: true; request: JoinRequestRow }
  | { ok: false; error: Exclude<DecideJoinRequestError, 'banned'>; request?: JoinRequestRow };

/** Reject a pending request (row locked; a decided request is `not_pending`). */
export async function rejectJoinRequest(
  db: DbClient,
  input: { serverId: string; requestId: string; decidedBy: string },
  now: Date = new Date()
): Promise<RejectJoinRequestResult> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as DbClient;
    const request = await lockJoinRequest(executor, input.serverId, input.requestId);
    if (!request) return { ok: false as const, error: 'not_found' as const };
    if (request.status !== 'pending') return { ok: false as const, error: 'not_pending' as const, request };
    const rejected = await setDecision(executor, request.id, 'rejected', input.decidedBy, now);
    return { ok: true as const, request: rejected };
  });
}

/** The requester withdraws their pending request. Returns it, or null when there was none. */
export async function cancelJoinRequest(
  db: DbClient,
  serverId: string,
  userId: string,
  now: Date = new Date()
): Promise<JoinRequestRow | null> {
  const [row] = await db
    .update(serverJoinRequests)
    .set({ status: 'cancelled', decidedAt: now, decidedBy: userId })
    .where(and(forServerAndUser(serverId, userId), eq(serverJoinRequests.status, 'pending')))
    .returning();
  return (row as JoinRequestRow | undefined) ?? null;
}
