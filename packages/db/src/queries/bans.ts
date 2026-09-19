/**
 * Ban queries — thin wrappers over the Drizzle client.
 *
 * A "ban" is a server-scoped block on a user. The schema enforces a unique
 * `(serverId, userId)` constraint, so a user can have at most one active ban
 * per server. Bans are reversible (DELETE removes the row); there is no soft
 * delete on this table because the row itself is the audit artifact and a
 * subsequent audit log entry should describe the unban.
 */
import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { memberships, serverBans, servers, users } from '../schema.js';

/**
 * beta-review (S2): SQL predicate "the `memberships` row in the current
 * query belongs to a user with an ACTIVE ban on that server" (no expiry,
 * or an expiry in the future). Membership gates (`isServerMember`,
 * `getUserPermissions`) negate it so a ban denies access even when a
 * membership row survived — pre-fix bans never removed the membership,
 * and a concurrent invite redeem can race the ban's membership delete.
 * Only valid inside a query whose FROM includes `memberships`.
 */
export function activeBanOnMembershipSql(): SQL {
  return sql`exists (
    select 1 from ${serverBans}
    where ${serverBans.serverId} = ${memberships.serverId}
      and ${serverBans.userId} = ${memberships.userId}
      and (${serverBans.expiresAt} is null or ${serverBans.expiresAt} > now())
  )`;
}

function isBanActive(row: { expiresAt: Date | null }, now: number = Date.now()): boolean {
  return !row.expiresAt || row.expiresAt.getTime() > now;
}

export interface ServerBanRow {
  id: string;
  serverId: string;
  userId: string;
  bannedBy: string | null;
  reason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface BanResult {
  ok: true;
  ban: ServerBanRow;
}
export type BanError =
  | { ok: false; error: 'already_banned' }
  | { ok: false; error: 'cannot_ban_owner' }
  | { ok: false; error: 'cannot_ban_self' };

/**
 * Ban a user from a server AND remove their membership, in ONE
 * transaction. The route layer decides whether the caller has
 * `BAN_MEMBERS`; this helper enforces the structural invariants (no
 * banning the owner, no banning yourself).
 *
 * beta-review (S2): the old helper only inserted the `server_bans` row —
 * the membership survived, so a banned user kept posting messages and
 * minting LiveKit tokens. The membership delete (membership_roles
 * cascade) now commits atomically with the ban. Re-banning is
 * idempotent for an ACTIVE ban (the existing row is returned and any
 * lingering membership is still removed); an EXPIRED ban row (the
 * unique (server, user) constraint keeps it around) is refreshed with
 * the new ban's values instead of being returned as if it still applied.
 */
export async function banUser(
  db: DbClient,
  input: {
    serverId: string;
    userId: string;
    bannedBy: string;
    reason?: string;
    expiresAt?: Date;
  }
): Promise<BanResult | BanError> {
  // No banning yourself — a ban is a moderation action, not a self-leave.
  if (input.userId === input.bannedBy) {
    return { ok: false, error: 'cannot_ban_self' };
  }

  return db.transaction(async (tx) => {
    const [server] = await tx
      .select({ ownerUserId: servers.ownerUserId })
      .from(servers)
      .where(eq(servers.id, input.serverId))
      .limit(1);
    if (server && server.ownerUserId === input.userId) {
      return { ok: false as const, error: 'cannot_ban_owner' as const };
    }

    const whereBan = and(
      eq(serverBans.serverId, input.serverId),
      eq(serverBans.userId, input.userId)
    );
    const [existing] = await tx.select().from(serverBans).where(whereBan).limit(1);

    let ban: ServerBanRow | undefined;
    if (existing && isBanActive(existing)) {
      ban = existing;
    } else if (existing) {
      [ban] = await tx
        .update(serverBans)
        .set({
          bannedBy: input.bannedBy,
          reason: input.reason ?? null,
          expiresAt: input.expiresAt ?? null,
          createdAt: new Date(),
        })
        .where(eq(serverBans.id, existing.id))
        .returning();
    } else {
      [ban] = await tx
        .insert(serverBans)
        .values({
          serverId: input.serverId,
          userId: input.userId,
          bannedBy: input.bannedBy,
          reason: input.reason ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .onConflictDoNothing({ target: [serverBans.serverId, serverBans.userId] })
        .returning();
      // A concurrent ban won the insert — adopt its row.
      if (!ban) [ban] = await tx.select().from(serverBans).where(whereBan).limit(1);
    }
    if (!ban) {
      throw new Error('banUser: ban row could not be written');
    }

    // The CASCADE on membership_roles.membership_id clears role links.
    await tx
      .delete(memberships)
      .where(and(eq(memberships.serverId, input.serverId), eq(memberships.userId, input.userId)));

    return { ok: true as const, ban };
  });
}

/**
 * Lift a ban. Idempotent: un-banning a user who isn't banned is a no-op
 * (returns null), so the route layer can call it without first probing.
 */
export async function unbanUser(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<ServerBanRow | null> {
  const [row] = await db
    .delete(serverBans)
    .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId)))
    .returning();
  return row ?? null;
}

/**
 * List the bans for a server, joined to `users` so the UI can render a
 * display name + ban info. Newest first. Bounded to 200 to keep the read
 * cheap; the UI paginates beyond that.
 */
export async function listBansForServer(
  db: DbClient,
  serverId: string
): Promise<Array<ServerBanRow & { displayName: string | null }>> {
  const rows = await db
    .select({
      id: serverBans.id,
      serverId: serverBans.serverId,
      userId: serverBans.userId,
      bannedBy: serverBans.bannedBy,
      reason: serverBans.reason,
      expiresAt: serverBans.expiresAt,
      createdAt: serverBans.createdAt,
      displayName: users.displayName,
    })
    .from(serverBans)
    .leftJoin(users, eq(users.id, serverBans.userId))
    .where(eq(serverBans.serverId, serverId))
    .orderBy(desc(serverBans.createdAt))
    .limit(200);
  return rows;
}

/**
 * Check whether a user is currently banned from a server. A ban with a
 * past `expiresAt` is treated as not-banned — the row sticks around as an
 * audit artifact but the read path ignores it. Use `isCurrentlyBanned`
 * for the join / redeem / message-send gates; use `getBan` if you want
 * the raw row.
 */
export async function isCurrentlyBanned(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: serverBans.id, expiresAt: serverBans.expiresAt })
    .from(serverBans)
    .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId)));
  if (!row) return false;
  return isBanActive(row);
}

/**
 * beta-review (S2): the subset of `serverIds` (or every server, when
 * omitted) on which the user holds an ACTIVE ban — one query. Lets
 * list views (the /lobby server rail) drop servers whose membership row
 * outlived a pre-fix ban.
 */
export async function listActivelyBannedServerIds(
  db: DbClient,
  userId: string,
  serverIds?: string[]
): Promise<Set<string>> {
  if (serverIds && serverIds.length === 0) return new Set();
  const rows = await db
    .select({ serverId: serverBans.serverId })
    .from(serverBans)
    .where(
      and(
        eq(serverBans.userId, userId),
        or(isNull(serverBans.expiresAt), gt(serverBans.expiresAt, sql`now()`)),
        ...(serverIds ? [inArray(serverBans.serverId, serverIds)] : [])
      )
    );
  return new Set(rows.map((r) => r.serverId));
}

/**
 * Find a ban by id. Returns null if not found.
 */
export async function getBanById(
  db: DbClient,
  banId: string
): Promise<ServerBanRow | null> {
  const [row] = await db.select().from(serverBans).where(eq(serverBans.id, banId));
  return row ?? null;
}

// Re-export the schema symbol the audit log writes need.
void isNull;
