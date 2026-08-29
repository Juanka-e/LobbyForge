/**
 * Membership queries — thin wrappers over the Drizzle client.
 *
 * A "membership" is the row in the `memberships` table that says "this user
 * belongs to this server". Every channel / message / role check ultimately
 * bottoms out in a membership lookup, so these helpers exist to keep the
 * SQL in one place.
 *
 * As of M15.5 a member can hold multiple roles via the `membership_roles`
 * join table. The `memberships.roleId` column is kept as the "primary /
 * display role" (the one shown in the member list) and is mirrored in
 * the join table so the union read path returns the right set.
 *
 * Conventions:
 *   - The first argument is always a `DbClient`.
 *   - Functions never read from `process.env` and never hold state.
 *   - Soft-deleted users are excluded by joining the `users` table and
 *     filtering on `deletedAt IS NULL`.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { membershipRoles, memberships, roles, users } from '../schema.js';

export interface MembershipRow {
  id: string;
  serverId: string;
  userId: string;
  roleId: string | null;
  nickname: string | null;
  timedOutUntil: Date | null;
  createdAt: Date;
}

/**
 * Returns true if the user is currently a member of the server.
 * A user is "currently a member" when:
 *   - there is a memberships row linking them, AND
 *   - the underlying user row is not soft-deleted.
 *
 * Owners always count as members — the `createServer` query in
 * `queries/servers.ts` inserts a memberships row for the owner in the same
 * transaction, so no separate code path is needed.
 */
export async function isServerMember(
  db: DbClient,
  userId: string,
  serverId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.serverId, serverId),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Fetch the membership row itself. Returns `null` if the user is not a
 * member or the user is soft-deleted. Use this when you need the `roleId`
 * or `nickname` (not just a boolean).
 */
export async function getServerMember(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<MembershipRow | null> {
  const rows = await db
    .select({
      id: memberships.id,
      serverId: memberships.serverId,
      userId: memberships.userId,
      roleId: memberships.roleId,
      nickname: memberships.nickname,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.serverId, serverId),
        eq(memberships.userId, userId),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  return (rows[0] as MembershipRow | undefined) ?? null;
}

export async function ensureServerMembership(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<MembershipRow> {
  const existing = await getServerMember(db, serverId, userId);
  if (existing) return existing;

  const [created] = await db
    .insert(memberships)
    .values({ serverId, userId })
    .onConflictDoNothing({
      target: [memberships.serverId, memberships.userId],
    })
    .returning({
      id: memberships.id,
      serverId: memberships.serverId,
      userId: memberships.userId,
      roleId: memberships.roleId,
      nickname: memberships.nickname,
      createdAt: memberships.createdAt,
    });
  if (created) return created as MembershipRow;

  const repaired = await getServerMember(db, serverId, userId);
  if (!repaired) throw new Error(`ensureServerMembership: could not create membership for ${userId}`);
  return repaired;
}

export async function updateMemberNickname(
  db: DbClient,
  serverId: string,
  userId: string,
  nickname: string | null
): Promise<MembershipRow> {
  const existing = await getServerMember(db, serverId, userId);
  if (!existing) throw new Error(`updateMemberNickname: user ${userId} is not a member of server ${serverId}`);
  const [updated] = await db
    .update(memberships)
    .set({ nickname: nickname?.trim() || null })
    .where(eq(memberships.id, existing.id))
    .returning({
      id: memberships.id,
      serverId: memberships.serverId,
      userId: memberships.userId,
      roleId: memberships.roleId,
      nickname: memberships.nickname,
      createdAt: memberships.createdAt,
    });
  if (!updated) throw new Error(`updateMemberNickname: update returned no row for ${existing.id}`);
  return updated as MembershipRow;
}

/**
 * Assign (or clear) a role on a member. `roleId: null` is a valid input
 * and means "remove the role assignment". Throws if the user is not a
 * member of the server.
 *
 * As of M15.5 the role is mirrored in the `membership_roles` join table
 * so the union read path in `getUserPermissions` returns it. The single
 * `memberships.roleId` column is kept as the "primary / display role".
 */
export async function assignRole(
  db: DbClient,
  serverId: string,
  userId: string,
  roleId: string | null
): Promise<MembershipRow> {
  const existing = await getServerMember(db, serverId, userId);
  if (!existing) {
    throw new Error(`assignRole: user ${userId} is not a member of server ${serverId}`);
  }
  await db
    .update(memberships)
    .set({ roleId })
    .where(eq(memberships.id, existing.id));
  // Mirror in the join table: clear any existing entries for this
  // membership and insert the new one. `null` means "no roles" — the
  // join table is empty, and `memberships.roleId` is also null.
  await db.delete(membershipRoles).where(eq(membershipRoles.membershipId, existing.id));
  if (roleId) {
    await db.insert(membershipRoles).values({ membershipId: existing.id, roleId });
  }
  return { ...existing, roleId };
}

/**
 * Set the full set of roles a member holds (M15.5 — multi-role). An
 * empty array clears all role assignments. The first id in the list, if
 * any, is mirrored to `memberships.roleId` so the UI's "display role"
 * stays stable; the rest land in the join table.
 *
 * Throws if the user is not a member of the server.
 */
export async function setMemberRoles(
  db: DbClient,
  serverId: string,
  userId: string,
  roleIds: string[]
): Promise<MembershipRow> {
  const existing = await getServerMember(db, serverId, userId);
  if (!existing) {
    throw new Error(`setMemberRoles: user ${userId} is not a member of server ${serverId}`);
  }
  // Dedupe so the unique (membershipId, roleId) index doesn't reject
  // a list like ['a', 'a'] from a careless caller.
  const unique = Array.from(new Set(roleIds));
  const primary = unique[0] ?? null;
  await db
    .update(memberships)
    .set({ roleId: primary })
    .where(eq(memberships.id, existing.id));
  await db.delete(membershipRoles).where(eq(membershipRoles.membershipId, existing.id));
  if (unique.length > 0) {
    await db
      .insert(membershipRoles)
      .values(unique.map((roleId) => ({ membershipId: existing.id, roleId })));
  }
  return { ...existing, roleId: primary };
}

/**
 * Remove a member from a server. Hard delete — the row goes away. Used
 * by the kick endpoint; bans are a different code path (`serverBans`).
 * The CASCADE on the FK takes care of clearing `membership_roles` rows.
 */
export async function removeMember(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<void> {
  const result = await db
    .delete(memberships)
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)))
    .returning({ id: memberships.id });
  if (result.length === 0) {
    throw new Error(`removeMember: user ${userId} is not a member of server ${serverId}`);
  }
}

/**
 * Return every role id assigned to a member, deduped, with the primary
 * (`memberships.roleId`) first. Returns an empty array if the user is
 * not a member.
 */
export async function getMemberRoleIds(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<string[]> {
  const m = await getServerMember(db, serverId, userId);
  if (!m) return [];
  const joined = await db
    .select({ roleId: membershipRoles.roleId })
    .from(membershipRoles)
    .where(eq(membershipRoles.membershipId, m.id));
  const all = new Set<string>();
  if (m.roleId) all.add(m.roleId);
  for (const r of joined) all.add(r.roleId);
  return Array.from(all);
}

/**
 * Look up a list of (userId, [roleIds]) pairs in one round trip. Used
 * by `listMembersForServer` to surface every role a member holds.
 */
export async function listRoleIdsForMemberships(
  db: DbClient,
  membershipIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (membershipIds.length === 0) return map;
  const rows = await db
    .select({ membershipId: membershipRoles.membershipId, roleId: membershipRoles.roleId })
    .from(membershipRoles)
    .where(inArray(membershipRoles.membershipId, membershipIds));
  for (const r of rows) {
    const list = map.get(r.membershipId) ?? [];
    list.push(r.roleId);
    map.set(r.membershipId, list);
  }
  return map;
}

/**
 * Member summary for the admin "Members" page — every non-deleted member
 * of a server with display name, avatar, primary role label, and join
 * date. Returns a flat list ordered by `createdAt` ascending so the
 * oldest member (usually the owner) shows up first. Used by the
 * Community Settings → Members screen.
 *
 * "Display role" is read from `memberships.roleId`; we join `roles` for
 * the name and color, falling back to "Member" / "Guest" if no role is
 * assigned. Online/voice presence is intentionally omitted — the admin
 * screen is for offline review.
 */
export interface MemberSummary {
  userId: string;
  displayName: string;
  globalDisplayName: string;
  nickname: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  isGuest: boolean;
  roleName: string | null;
  roleColor: string | null;
  roleIcon: string | null;
  statusText: string | null;
  bio: string | null;
  roles: Array<{ id: string; name: string; color: string | null; icon: string | null; position: number; displaySeparately: boolean }>;
  joinedAt: Date;
}

export async function listMemberSummariesForServer(
  db: DbClient,
  serverId: string
): Promise<MemberSummary[]> {
  // We leftJoin roles so members without a role still surface. `users`
  // is the source of truth for display name / username / avatar.
  const rows = await db
    .select({
      userId: memberships.userId,
      membershipId: memberships.id,
      displayName: memberships.nickname,
      globalDisplayName: users.displayName,
      nickname: memberships.nickname,
      avatarUrl: users.avatarUrl,
      bannerUrl: users.bannerUrl,
      isGuest: users.isGuest,
      roleName: roles.name,
      roleColor: roles.color,
      roleIcon: roles.icon,
      statusText: users.statusText,
      bio: users.bio,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(roles, eq(roles.id, memberships.roleId))
    .where(
      and(
        eq(memberships.serverId, serverId),
        isNull(users.deletedAt)
      )
    )
    .orderBy(asc(memberships.createdAt));
  const roleLinks = rows.length === 0
    ? []
    : await db
        .select({
          membershipId: membershipRoles.membershipId,
          id: roles.id,
          name: roles.name,
          color: roles.color,
          icon: roles.icon,
          position: roles.position,
          displaySeparately: roles.displaySeparately,
        })
        .from(membershipRoles)
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .where(inArray(membershipRoles.membershipId, rows.map((row) => row.membershipId)));
  const rolesByMembership = new Map<string, MemberSummary['roles']>();
  for (const role of roleLinks) {
    const current = rolesByMembership.get(role.membershipId) ?? [];
    current.push({ id: role.id, name: role.name, color: role.color, icon: role.icon, position: role.position, displaySeparately: role.displaySeparately });
    rolesByMembership.set(role.membershipId, current);
  }
  return rows.map(({ membershipId, ...row }) => ({
    ...row,
    displayName: row.displayName || row.globalDisplayName,
    roles: (rolesByMembership.get(membershipId) ?? []).sort((a, b) => b.position - a.position),
  }));
}

/**
 * MODERATE_MEMBERS: set/clear a member's timeout (muted from text AND
 * voice until the given instant). `until = null` clears an active
 * timeout. Returns the updated row.
 */
export async function setMemberTimeout(
  db: DbClient,
  serverId: string,
  userId: string,
  until: Date | null
): Promise<MembershipRow> {
  const [row] = await db
    .update(memberships)
    .set({ timedOutUntil: until })
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)))
    .returning();
  if (!row) throw new Error(`setMemberTimeout: user ${userId} is not a member of server ${serverId}`);
  return row as MembershipRow;
}

/** Active (non-expired) timeout for a member, or null. */
export async function getActiveMemberTimeout(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<Date | null> {
  const [row] = await db
    .select({ timedOutUntil: memberships.timedOutUntil })
    .from(memberships)
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)))
    .limit(1);
  const until = row?.timedOutUntil ?? null;
  return until && until.getTime() > Date.now() ? until : null;
}
