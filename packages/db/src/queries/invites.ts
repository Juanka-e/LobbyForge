/**
 * Invite queries — thin wrappers over the Drizzle client.
 *
 * An "invite" is a server-scoped shareable code that lets a user join the
 * server. The code is a 12-character Crockford-base32 string (10^18
 * combinations; collisions handled by a unique-index on `invites.code`).
 * A redeem atomically checks `expiresAt` + `maxUses`, increments
 * `currentUses`, and inserts a `memberships` row assigned to the server's
 * `@everyone` role — or, when the server's access policy holds newcomers
 * for approval, files a join request instead (queries/joinRequests.ts).
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import type { DbClient } from '../client.js';
import { isPgUniqueViolation } from '../pg-errors.js';
import { invites, membershipRoles, memberships, roles, serverBans, servers } from '../schema.js';
import { EVERYONE_ROLE_NAME } from './roles.js';
import { getMemberSanction, membershipValuesFromSanction } from './memberSanctions.js';
import { isNewMemberApprovalRequired } from './serverAccessPolicies.js';
import {
  fileJoinRequest,
  getOpenJoinRequest,
  hasFiledThroughInvite,
  joinRequestRetryAfter,
  type JoinRequestRow,
} from './joinRequests.js';

export interface InviteRow {
  id: string;
  serverId: string;
  createdBy: string | null;
  code: string;
  maxUses: number | null;
  currentUses: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface InviteMetadata {
  code: string;
  serverId: string;
  serverName: string;
  expiresAt: Date | null;
  currentUses: number;
  maxUses: number | null;
  isExpired: boolean;
  isExhausted: boolean;
}

export interface CreateInviteInput {
  serverId: string;
  createdBy: string;
  maxUses?: number | null;
  expiresAt?: Date | null;
}

/**
 * Crockford's base32 alphabet, minus `U` (excluded by spec to avoid
 * accidental obscenities) and minus `0`/`O`/`1`/`I`/`L` (visually
 * ambiguous). 30 characters × 12 positions ≈ 5.3 × 10^17.
 */
const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateInviteCode(length: number = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    // randomInt draws uniformly; `byte % 30` would favour the first six
    // characters (256 is not a multiple of 30).
    out += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
  }
  return out;
}

/**
 * Create a new invite. The code is generated locally (not from a sequence)
 * and validated by a unique index on `invites.code` — a duplicate insert
 * is retried with a fresh code up to 5 times before we give up.
 */
export async function createInvite(
  db: DbClient,
  input: CreateInviteInput
): Promise<InviteRow> {
  // Verify the server exists (not soft-deleted) before we insert.
  const server = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, input.serverId), isNull(servers.deletedAt)))
    .limit(1);
  if (server.length === 0) {
    throw new Error(`createInvite: server ${input.serverId} does not exist`);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      const [row] = await db
        .insert(invites)
        .values({
          serverId: input.serverId,
          createdBy: input.createdBy,
          code,
          maxUses: input.maxUses ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      if (!row) throw new Error('createInvite: insert returned no rows');
      return row as InviteRow;
    } catch (err) {
      // Postgres unique violation (Drizzle wraps it) → retry with a fresh code.
      if (!isPgUniqueViolation(err)) throw err;
    }
  }
  throw new Error('createInvite: failed to generate a unique code after 5 attempts');
}

export async function getInviteById(db: DbClient, inviteId: string): Promise<InviteRow | null> {
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.id, inviteId))
    .limit(1);
  return (rows[0] as InviteRow | undefined) ?? null;
}

export async function getInviteByCode(db: DbClient, code: string): Promise<InviteRow | null> {
  const rows = await db
    .select()
    .from(invites)
    .where(eq(invites.code, code))
    .limit(1);
  return (rows[0] as InviteRow | undefined) ?? null;
}

/**
 * List invites for a server, newest first. The route layer is responsible
 * for the membership / permission check; this helper only filters out
 * invites whose parent server is soft-deleted.
 *
 * beta-review (F7): `createdBy` narrows the list to one creator — members
 * without MANAGE_SERVER only see (and may only revoke) their own invites.
 */
export async function listInvitesForServer(
  db: DbClient,
  serverId: string,
  options: { createdBy?: string } = {}
): Promise<InviteRow[]> {
  const rows = await db
    .select({
      id: invites.id,
      serverId: invites.serverId,
      createdBy: invites.createdBy,
      code: invites.code,
      maxUses: invites.maxUses,
      currentUses: invites.currentUses,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .innerJoin(servers, eq(servers.id, invites.serverId))
    .where(
      and(
        eq(invites.serverId, serverId),
        isNull(servers.deletedAt),
        ...(options.createdBy !== undefined ? [eq(invites.createdBy, options.createdBy)] : [])
      )
    )
    .orderBy(sql`${invites.createdAt} DESC`);
  return rows as InviteRow[];
}

/**
 * Public invite metadata (no PII). Used by the join page before the user
 * has accepted. Joins the server to surface the server's display name.
 */
export async function getInviteMetadata(db: DbClient, code: string): Promise<InviteMetadata | null> {
  const rows = await db
    .select({
      code: invites.code,
      serverId: invites.serverId,
      serverName: servers.name,
      expiresAt: invites.expiresAt,
      currentUses: invites.currentUses,
      maxUses: invites.maxUses,
    })
    .from(invites)
    .innerJoin(servers, eq(servers.id, invites.serverId))
    .where(and(eq(invites.code, code), isNull(servers.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  return {
    code: row.code,
    serverId: row.serverId,
    serverName: row.serverName,
    expiresAt: row.expiresAt,
    currentUses: row.currentUses,
    maxUses: row.maxUses,
    isExpired: row.expiresAt ? row.expiresAt.getTime() < now : false,
    isExhausted: row.maxUses !== null && row.currentUses >= row.maxUses,
  };
}

/**
 * Hard-delete an invite. Returns true if a row was deleted.
 */
export async function revokeInvite(db: DbClient, inviteId: string): Promise<boolean> {
  const result = await db
    .delete(invites)
    .where(eq(invites.id, inviteId))
    .returning({ id: invites.id });
  return result.length > 0;
}

/**
 * Reason a redeem failed. The route layer maps this to a status code:
 *   - `not_found` / `expired` / `exhausted` / `banned` → 403
 *   - `already_member` → 409
 */
export type RedeemInviteError =
  | 'not_found'
  | 'expired'
  | 'exhausted'
  | 'already_member'
  | 'no_everyone_role'
  | 'banned';

/**
 * The redeem did not create a membership because the server's access
 * policy holds newcomers for approval (security-review AUTHZ-004 follow-up):
 *   - `pending_approval` — a join request is waiting (`created`: filed by
 *     THIS call, which consumed one use of the invite unless the user had
 *     already filed one through this code) → 202;
 *   - `join_rejected` — a moderator rejected the user's last request and
 *     the cooldown runs until `retryAfter` → 403;
 *   - `join_request_limit` — too many requests in 24 h → 429.
 */
export type RedeemInviteHeld =
  | { ok: false; error: 'pending_approval'; serverId: string; request: JoinRequestRow; created: boolean }
  | { ok: false; error: 'join_rejected'; serverId: string; retryAfter: Date }
  | { ok: false; error: 'join_request_limit'; serverId: string };

export type RedeemInviteResult =
  | { ok: true; membershipId: string; serverId: string; roleId: string }
  | { ok: false; error: RedeemInviteError }
  | RedeemInviteHeld;

/**
 * Atomically redeem an invite. The whole flow runs inside a Drizzle
 * transaction so two concurrent redeems can't both push `currentUses`
 * past `maxUses`:
 *   1. Lock the invite row.
 *   2. Verify the user is not banned (BEFORE the membership probe — a
 *      banned user must never be told "already a member").
 *   3. Verify the user is not already a member.
 *   4. Verify `expiresAt` + `currentUses < maxUses`.
 *   5. Look up the server's `@everyone` role.
 *   6. Insert the `memberships` row with `roleId = @everyone.id`.
 *   7. Increment `currentUses`.
 *
 * Under an approval policy, steps 5-6 are replaced by filing a join
 * request (`options.note` is the requester's optional message). The
 * user's existing pending request — or a rejection still in its cooldown —
 * is returned BEFORE the expiry / use checks: the use their own request
 * consumed may be the invite's last. A user's FIRST request through this
 * code consumes one use (step 7), so `maxUses` bounds how many people one
 * code can put in the queue. Nothing else does: a repeat redeem of a
 * pending request, a new request after the user withdrew (or after a
 * rejection's cooldown) through the same code — which also skips the
 * exhausted check, the user already holds a use — and the approval.
 *
 * Returns a discriminated-union result so the route layer can map errors
 * to status codes without parsing strings.
 */
export async function redeemInvite(
  db: DbClient,
  code: string,
  userId: string,
  options: { note?: string | null } = {}
): Promise<RedeemInviteResult> {
  return db.transaction(async (tx) => {
    // 1. Lock the invite row. Through the query builder, not a raw
    //    `tx.execute(sql…)`: a raw result skips Drizzle's column mapping,
    //    so `expires_at` arrived as the driver's STRING and the expiry check
    //    below threw (`getTime is not a function`) — every invite with an
    //    expiry failed to redeem with a 500.
    const [invite] = await tx
      .select({
        id: invites.id,
        serverId: invites.serverId,
        maxUses: invites.maxUses,
        currentUses: invites.currentUses,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .where(eq(invites.code, code))
      .limit(1)
      .for('update');
    if (!invite) {
      return { ok: false as const, error: 'not_found' as RedeemInviteError };
    }

    // 2. Banned? A ban with a past `expiresAt` is treated as not-banned;
    //    the row sticks around as an audit artifact but the read path
    //    ignores it. The UI surfaces "you were banned from this server"
    //    with a 403-ish status.
    //    beta-review (S2): checked BEFORE the membership probe — a banned
    //    user whose membership row survived a pre-fix ban used to get
    //    "already_member" (409) instead of "banned".
    const banRows = await tx
      .select({ expiresAt: serverBans.expiresAt })
      .from(serverBans)
      .where(
        and(eq(serverBans.serverId, invite.serverId), eq(serverBans.userId, userId))
      )
      .limit(1);
    if (banRows.length > 0 && (!banRows[0]?.expiresAt || banRows[0].expiresAt.getTime() > Date.now())) {
      return { ok: false as const, error: 'banned' as RedeemInviteError };
    }

    // 3. Already a member?
    const existingMember = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.serverId, invite.serverId)))
      .limit(1);
    if (existingMember.length > 0) {
      return { ok: false as const, error: 'already_member' as RedeemInviteError };
    }

    // security-review AUTHZ-004 follow-up: the server's access policy can
    // hold newcomers for moderator approval — the redeem files a join
    // request (the approval queue) instead of a membership. Registration
    // refuses such a policy before it gets here; an invite must not be a
    // way around the queue.
    const executor = tx as unknown as DbClient;
    const needsApproval = await isNewMemberApprovalRequired(executor, invite.serverId, userId);
    if (needsApproval) {
      const open = await getOpenJoinRequest(executor, invite.serverId, userId);
      if (open?.status === 'pending') {
        return { ok: false as const, error: 'pending_approval' as const, serverId: invite.serverId, request: open, created: false };
      }
      if (open) {
        return { ok: false as const, error: 'join_rejected' as const, serverId: invite.serverId, retryAfter: joinRequestRetryAfter(open) };
      }
    }
    // Invite-use burning: an earlier request of this user through this
    // code (whatever became of it) already took a use, so asking again —
    // after withdrawing, or after a rejection's cooldown — takes none.
    // Refunding on withdraw instead would hand the use to the next
    // stranger, and the code would no longer bound how many people it
    // queues; this way `maxUses` is "how many people may ask through it".
    const alreadyHoldsUse =
      needsApproval &&
      (await hasFiledThroughInvite(executor, { serverId: invite.serverId, userId, inviteCode: code }));

    // 4. Expired?
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      return { ok: false as const, error: 'expired' as RedeemInviteError };
    }
    // Exhausted? (Not for a requester whose own earlier request took the use.)
    if (!alreadyHoldsUse && invite.maxUses !== null && invite.currentUses >= invite.maxUses) {
      return { ok: false as const, error: 'exhausted' as RedeemInviteError };
    }

    if (needsApproval) {
      const filed = await fileJoinRequest(executor, {
        serverId: invite.serverId,
        userId,
        source: 'invite',
        inviteCode: code,
        note: options.note ?? null,
      });
      if (filed.kind === 'limited') {
        return { ok: false as const, error: 'join_request_limit' as const, serverId: invite.serverId };
      }
      if (filed.kind === 'rejected') {
        return { ok: false as const, error: 'join_rejected' as const, serverId: invite.serverId, retryAfter: filed.retryAfter };
      }
      // A request filed by THIS redeem takes one use of the invite (the
      // row is locked above), so one code cannot flood the queue past
      // its maxUses. A concurrent duplicate (created: false) takes none,
      // and neither does the user's second request through this code.
      if (filed.created && !alreadyHoldsUse) {
        await tx
          .update(invites)
          .set({ currentUses: sql`${invites.currentUses} + 1` })
          .where(eq(invites.id, invite.id));
      }
      return {
        ok: false as const,
        error: 'pending_approval' as const,
        serverId: invite.serverId,
        request: filed.request,
        created: filed.created,
      };
    }

    // 5. Look up the server's @everyone role. The M13 seed runs on
    //    `createServer`; if the role is missing something is very wrong,
    //    so we surface the error to the route layer.
    const everyoneRows = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.serverId, invite.serverId), eq(roles.name, EVERYONE_ROLE_NAME)))
      // Role names are not unique: the real @everyone is the lowest, oldest.
      .orderBy(asc(roles.position), asc(roles.createdAt))
      .limit(1);
    const everyoneId = everyoneRows[0]?.id;
    if (!everyoneId) {
      return { ok: false as const, error: 'no_everyone_role' as RedeemInviteError };
    }

    // 6. Insert the membership. security-review AUTHZ-002: a returning
    //    member starts with the timeout / server mute they left with —
    //    leave + redeem used to hand them a clean row.
    const sanction = await getMemberSanction(executor, invite.serverId, userId);
    const [member] = await tx
      .insert(memberships)
      .values({
        serverId: invite.serverId,
        userId,
        roleId: everyoneId,
        ...membershipValuesFromSanction(sanction),
      })
      .returning({ id: memberships.id });
    if (!member) {
      throw new Error('redeemInvite: insert membership returned no rows');
    }

    // Mirror the role assignment in the membership_roles join table (M15.5)
    await tx.insert(membershipRoles).values({
      membershipId: member.id,
      roleId: everyoneId,
    });

    // 7. Increment currentUses.
    await tx
      .update(invites)
      .set({ currentUses: sql`${invites.currentUses} + 1` })
      .where(eq(invites.id, invite.id));

    return {
      ok: true as const,
      membershipId: member.id,
      serverId: invite.serverId,
      roleId: everyoneId,
    };
  });
}
