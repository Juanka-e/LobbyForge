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
import { and, asc, eq, inArray, isNull, not } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { membershipRoles, memberships, roles, users } from '../schema.js';
import { activeBanOnMembershipSql, isCurrentlyBanned } from './bans.js';
import { EVERYONE_ROLE_NAME } from './roles.js';
import { getMemberSanction, membershipValuesFromSanction, recordMemberSanction } from './memberSanctions.js';
import { isNewMemberApprovalRequired } from './serverAccessPolicies.js';
import { profileVisibilitySql, toProfileVisibility, userImageRefSql } from './userImages.js';
import type { ActivityVisibilityScope } from './userSettings.js';

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
 *
 * beta-review (S2): a user with an ACTIVE ban is never a member, even if
 * a memberships row survived (pre-fix bans left it in place; a redeem
 * can race the ban). Every route gate bottoms out here.
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
        isNull(users.deletedAt),
        not(activeBanOnMembershipSql())
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

/**
 * Idempotently make `userId` a member of `serverId`. Returns `null` — and
 * creates nothing — when the user holds an ACTIVE ban on the server, or
 * (security-review AUTHZ-004) when the server's access policy requires
 * approval for a newcomer. The /lobby auto-join uses `autoJoinServer`
 * (queries/joinRequests.ts), which reports the user's join request in
 * that case instead (the lobby's "Ask to join" files one).
 *
 * beta-review (S2): the lobby called this unconditionally, so a banned
 * user on an open instance was silently re-joined on their next visit.
 */
export async function ensureServerMembership(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<MembershipRow | null> {
  const result = await ensureServerMembershipDetailed(db, serverId, userId);
  return result ? result.membership : null;
}

/**
 * `ensureServerMembership` that also says whether THIS call created the
 * membership — the join hooks (Welcome Bot) fire only for a real join,
 * never for a returning member.
 *
 * A new membership holds the server's `@everyone` role (in
 * `membership_roles`, the set `getUserPermissions` reads): the auto-join
 * used to insert a role-less membership, and a member without roles has
 * no permissions at all — the newcomer could not read or send anywhere.
 * The display role (`memberships.roleId`) stays empty, as before, so
 * `seedDefaultRoles` can still make `@admin` the owner's display role.
 */
export async function ensureServerMembershipDetailed(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<{ membership: MembershipRow; created: boolean } | null> {
  if (await isCurrentlyBanned(db, serverId, userId)) return null;
  const existing = await getServerMember(db, serverId, userId);
  if (existing) return { membership: existing, created: false };
  // security-review AUTHZ-004: a server whose access policy asks for
  // approval takes no new member without a moderator's decision. Returns
  // null like a ban: nothing is created (a join request is filed by an
  // invite redeem or the lobby's "Ask to join").
  if (await isNewMemberApprovalRequired(db, serverId, userId)) return null;

  return createMembershipWithEveryone(db, serverId, userId);
}

/**
 * Insert the membership for a NEW member: the `@everyone` role in
 * `membership_roles`, an empty display role, and the timeout / server
 * mute stored in `server_member_sanctions` (security-review AUTHZ-002).
 * The ONE creation path shared by the auto-join and an approved join
 * request; callers have already checked bans and the access policy.
 * Idempotent on (server, user): a concurrent insert yields
 * `created: false` with the existing row.
 */
export async function createMembershipWithEveryone(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<{ membership: MembershipRow; created: boolean }> {
  const [everyone] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.serverId, serverId), eq(roles.name, EVERYONE_ROLE_NAME)))
    // Role names are not unique: the real @everyone is the lowest, oldest.
    .orderBy(asc(roles.position), asc(roles.createdAt))
    .limit(1);

  // security-review AUTHZ-002: a returning member starts with the timeout
  // / server mute they left with — leaving must not lift a sanction.
  const sanction = await getMemberSanction(db, serverId, userId);

  const [created] = await db
    .insert(memberships)
    .values({ serverId, userId, ...membershipValuesFromSanction(sanction) })
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
  if (created) {
    if (everyone) {
      await db
        .insert(membershipRoles)
        .values({ membershipId: created.id, roleId: everyone.id })
        .onConflictDoNothing();
    }
    return { membership: created as MembershipRow, created: true };
  }

  const repaired = await getServerMember(db, serverId, userId);
  if (!repaired) throw new Error(`ensureServerMembership: could not create membership for ${userId}`);
  return { membership: repaired, created: false };
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
 *
 * security-review FILE-001: images are returned as short references
 * (`userImageRefSql`), never as the stored data URLs — the list is
 * serialized into every /lobby render. security-review AUTHZ-005:
 * `profileVisibility` is the member's setting; callers project avatar /
 * banner / bio / status per viewer.
 */
export interface MemberSummary {
  userId: string;
  displayName: string;
  globalDisplayName: string;
  nickname: string | null;
  /** Short image reference (version token or legacy https URL), never the image. */
  avatarRef: string | null;
  /** Short image reference (version token or legacy https URL), never the image. */
  bannerRef: string | null;
  profileVisibility: ActivityVisibilityScope;
  isGuest: boolean;
  roleName: string | null;
  roleColor: string | null;
  roleIcon: string | null;
  statusText: string | null;
  bio: string | null;
  roles: Array<{ id: string; name: string; color: string | null; icon: string | null; position: number; displaySeparately: boolean }>;
  joinedAt: Date;
}

/**
 * Every member by default, oldest first. `limit` is optional and has no
 * default on purpose: the lobby member list, mention autocomplete, voice
 * rosters and the admin Members page all treat this as the COMPLETE member
 * set — a cap (security-review FILE-001 briefly had one at 500) made later
 * members vanish from the list and show as "Unknown user" in voice. Rows
 * carry short image references, not images, so a full list stays small.
 */
export async function listMemberSummariesForServer(
  db: DbClient,
  serverId: string,
  options: { limit?: number } = {}
): Promise<MemberSummary[]> {
  // We leftJoin roles so members without a role still surface. `users`
  // is the source of truth for display name / username / avatar.
  const query = db
    .select({
      userId: memberships.userId,
      membershipId: memberships.id,
      displayName: memberships.nickname,
      globalDisplayName: users.displayName,
      nickname: memberships.nickname,
      // security-review FILE-001: references only — the data URLs stay in Postgres.
      avatarRef: userImageRefSql(users.avatarUrl),
      bannerRef: userImageRefSql(users.bannerUrl),
      profileVisibility: profileVisibilitySql(users.id),
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
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
  const rows = options.limit === undefined
    ? await query
    : await query.limit(Math.max(1, Math.floor(options.limit)));
  // Scoped by server through a join rather than `IN (<every membership
  // id>)`: with no cap, a list of one bind parameter per member would hit
  // Postgres' 65,535-parameter ceiling on a very large server. Links of
  // members outside `rows` (soft-deleted users, beyond `limit`) are ignored.
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
        .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .where(eq(memberships.serverId, serverId));
  const rolesByMembership = new Map<string, MemberSummary['roles']>();
  for (const role of roleLinks) {
    const current = rolesByMembership.get(role.membershipId) ?? [];
    current.push({ id: role.id, name: role.name, color: role.color, icon: role.icon, position: role.position, displaySeparately: role.displaySeparately });
    rolesByMembership.set(role.membershipId, current);
  }
  return rows.map(({ membershipId, ...row }) => ({
    ...row,
    displayName: row.displayName || row.globalDisplayName,
    avatarRef: row.avatarRef ?? null,
    bannerRef: row.bannerRef ?? null,
    profileVisibility: toProfileVisibility(row.profileVisibility),
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
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(memberships)
      .set({ timedOutUntil: until })
      .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)))
      .returning();
    if (!row) throw new Error(`setMemberTimeout: user ${userId} is not a member of server ${serverId}`);
    // security-review AUTHZ-002: mirror the moderation state outside the
    // membership row (same transaction) so leave + rejoin keeps it.
    await recordMemberSanction(tx as unknown as DbClient, {
      serverId,
      userId,
      timedOutUntil: row.timedOutUntil,
      voiceMuted: row.voiceMuted,
    });
    return row as MembershipRow;
  });
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
