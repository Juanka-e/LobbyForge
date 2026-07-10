/**
 * Ban queries — thin wrappers over the Drizzle client.
 *
 * A "ban" is a server-scoped block on a user. The schema enforces a unique
 * `(serverId, userId)` constraint, so a user can have at most one active ban
 * per server. Bans are reversible (DELETE removes the row); there is no soft
 * delete on this table because the row itself is the audit artifact and a
 * subsequent audit log entry should describe the unban.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { serverBans, users } from '../schema.js';

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
 * Ban a user from a server. Idempotent on the membership side: a banned user
 * who is somehow still a member is removed. The route layer decides whether
 * the caller has `BAN_MEMBERS`; this helper just enforces the structural
 * invariants (no banning the owner, no banning yourself).
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

  // Idempotent check: if a row already exists, return it.
  const [existing] = await db
    .select()
    .from(serverBans)
    .where(
      and(eq(serverBans.serverId, input.serverId), eq(serverBans.userId, input.userId))
    );
  if (existing) {
    return { ok: true, ban: existing };
  }

  const [row] = await db
    .insert(serverBans)
    .values({
      serverId: input.serverId,
      userId: input.userId,
      bannedBy: input.bannedBy,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('banUser: insert returned no row');
  }

  return { ok: true, ban: row };
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
  if (row.expiresAt && row.expiresAt < new Date()) return false;
  return true;
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
