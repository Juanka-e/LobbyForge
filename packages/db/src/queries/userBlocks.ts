/**
 * User block queries — directional block list for per-user message masking.
 *
 * When user A blocks user B:
 *   - A sees B's messages as "Blocked user" (content hidden, row stays)
 *   - B's messages still appear normally for everyone else
 *   - The block is one-directional — B can still see A's messages
 *
 * The block list is checked by the messages API route when listing
 * messages for a channel; the route masks blocked authors before
 * returning the response.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { userBlocks, users } from '../schema.js';
import { profileVisibilitySql, sharesServerSql, toProfileVisibility, userImageRefSql } from './userImages.js';
import type { ActivityVisibilityScope } from './userSettings.js';

export interface UserBlockRow {
  id: string;
  blockerUserId: string;
  blockedUserId: string;
  blockedDisplayName: string;
  /**
   * security-review FILE-001: short image reference (version token or
   * legacy https URL) — never the stored data URL.
   */
  blockedAvatarRef: string | null;
  /** security-review AUTHZ-005: the blocked user's profile visibility. */
  blockedProfileVisibility: ActivityVisibilityScope;
  /** Whether the blocker and the blocked user share a server. */
  sharesServerWithBlocked: boolean;
  createdAt: Date;
}

/**
 * Block a user. Idempotent — if the block already exists, returns the
 * existing row without error.
 */
export async function blockUser(
  db: DbClient,
  blockerUserId: string,
  blockedUserId: string
): Promise<void> {
  if (blockerUserId === blockedUserId) {
    throw new Error('Cannot block yourself.');
  }
  await db
    .insert(userBlocks)
    .values({ blockerUserId, blockedUserId })
    .onConflictDoNothing({
      target: [userBlocks.blockerUserId, userBlocks.blockedUserId],
    });
}

/**
 * Unblock a user. No-op if the block doesn't exist.
 */
export async function unblockUser(
  db: DbClient,
  blockerUserId: string,
  blockedUserId: string
): Promise<void> {
  await db
    .delete(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerUserId, blockerUserId),
        eq(userBlocks.blockedUserId, blockedUserId)
      )
    );
}

/**
 * List all users blocked by `blockerUserId`, joined with display names
 * so the settings UI can render the list without N extra lookups.
 */
export async function listBlockedUsers(
  db: DbClient,
  blockerUserId: string
): Promise<UserBlockRow[]> {
  const rows = await db
    .select({
      id: userBlocks.id,
      blockerUserId: userBlocks.blockerUserId,
      blockedUserId: userBlocks.blockedUserId,
      blockedDisplayName: users.displayName,
      blockedAvatarRef: userImageRefSql(users.avatarUrl),
      blockedProfileVisibility: profileVisibilitySql(users.id),
      sharesServerWithBlocked: sharesServerSql(blockerUserId, users.id),
      createdAt: userBlocks.createdAt,
    })
    .from(userBlocks)
    .innerJoin(users, eq(users.id, userBlocks.blockedUserId))
    .where(eq(userBlocks.blockerUserId, blockerUserId))
    .orderBy(asc(userBlocks.createdAt));
  return rows.map((row) => ({
    ...row,
    blockedAvatarRef: row.blockedAvatarRef ?? null,
    blockedProfileVisibility: toProfileVisibility(row.blockedProfileVisibility),
    sharesServerWithBlocked: row.sharesServerWithBlocked === true,
  }));
}

/**
 * Get the set of user IDs that `blockerUserId` has blocked. Used by
 * the messages API to mask blocked authors in a single set lookup.
 * Returns an empty Set if no blocks exist.
 */
export async function getBlockedUserIds(
  db: DbClient,
  blockerUserId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ blockedUserId: userBlocks.blockedUserId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerUserId, blockerUserId));
  return new Set(rows.map((r) => r.blockedUserId));
}

/**
 * Check if `blockerUserId` has blocked `blockedUserId`. Returns a
 * boolean. Used by the block button in the user profile popover.
 */
export async function isUserBlocked(
  db: DbClient,
  blockerUserId: string,
  blockedUserId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerUserId, blockerUserId),
        eq(userBlocks.blockedUserId, blockedUserId)
      )
    )
    .limit(1);
  return rows.length > 0;
}
