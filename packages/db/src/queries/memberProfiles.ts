/**
 * Member profile queries — what the profile card reads for ONE member of
 * ONE server (`GET /api/servers/{id}/members/{userId}/profile`).
 *
 * The member list (`listMemberSummariesForServer`) already carries names,
 * image references, bio and status for everyone. The card needs a few
 * fields the list leaves out on purpose — when the member joined, when the
 * account was created, every role with its permissions (for the "which
 * roles may this viewer hand out" decision) and the communities two people
 * share — so it asks for one member instead of widening the list.
 *
 * Nothing here decides who may SEE what: the route projects every field
 * per viewer (profile visibility, blocks) exactly like the lobby does.
 */
import { and, asc, eq, isNull, not, sql } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { membershipRoles, memberships, roles, servers, users } from '../schema.js';
import { activeBanOnMembershipSql } from './bans.js';
import { profileVisibilitySql, toProfileVisibility, userImageRefSql } from './userImages.js';
import type { ActivityVisibilityScope } from './userSettings.js';

export interface MemberProfileRole {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  position: number;
  /** Online holders get their own heading in the lobby member list. */
  displaySeparately: boolean;
  permissions: string[];
}

export interface MemberProfileRecord {
  userId: string;
  /** `users.display_name` — the account's own name. */
  globalDisplayName: string;
  /** The community nickname, when one is set. */
  nickname: string | null;
  /** Short image reference (version token or legacy https URL), never the image. */
  avatarRef: string | null;
  /** Short image reference (version token or legacy https URL), never the image. */
  bannerRef: string | null;
  profileVisibility: ActivityVisibilityScope;
  isGuest: boolean;
  statusText: string | null;
  bio: string | null;
  /** 0050: the handle (an identity field, always shown), pronouns and profile colour. */
  username: string | null;
  pronouns: string | null;
  accentColor: string | null;
  accountCreatedAt: Date;
  /** When the membership row was created — "member since" in this community. */
  joinedAt: Date;
  timedOutUntil: Date | null;
  voiceMuted: boolean;
  /**
   * Every role the member holds in this server, highest first: the join
   * table plus the legacy `memberships.role_id`, `@everyone` included (a
   * role PUT replaces the whole set, so callers need it).
   */
  roles: MemberProfileRole[];
}

const ROLE_FIELDS = {
  id: roles.id,
  name: roles.name,
  color: roles.color,
  icon: roles.icon,
  position: roles.position,
  displaySeparately: roles.displaySeparately,
  permissions: roles.permissions,
};

function toRole(row: {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  position: number;
  displaySeparately?: boolean | null;
  permissions: unknown;
}): MemberProfileRole {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    position: row.position,
    displaySeparately: row.displaySeparately === true,
    permissions: Array.isArray(row.permissions) ? (row.permissions as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  };
}

/**
 * One CURRENT member of a live server, or null: no membership, a
 * soft-deleted account, a soft-deleted server, or an active ban (a
 * membership row that outlived a ban does not count — the same rule as
 * `isServerMember`).
 */
export async function getMemberProfileRecord(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<MemberProfileRecord | null> {
  // A multi-table select: Drizzle qualifies every column, so the
  // subqueries below (visibility, ban) cannot pick up a bare "id".
  const [row] = await db
    .select({
      membershipId: memberships.id,
      legacyRoleId: memberships.roleId,
      userId: users.id,
      globalDisplayName: users.displayName,
      nickname: memberships.nickname,
      // security-review FILE-001: references only — the data URLs stay in Postgres.
      avatarRef: userImageRefSql(users.avatarUrl),
      bannerRef: userImageRefSql(users.bannerUrl),
      profileVisibility: profileVisibilitySql(users.id),
      isGuest: users.isGuest,
      statusText: users.statusText,
      bio: users.bio,
      username: users.username,
      pronouns: users.pronouns,
      accentColor: users.accentColor,
      accountCreatedAt: users.createdAt,
      joinedAt: memberships.createdAt,
      timedOutUntil: memberships.timedOutUntil,
      voiceMuted: memberships.voiceMuted,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(servers, eq(servers.id, memberships.serverId))
    .where(
      and(
        eq(memberships.serverId, serverId),
        eq(memberships.userId, userId),
        isNull(users.deletedAt),
        isNull(servers.deletedAt),
        not(activeBanOnMembershipSql())
      )
    )
    .limit(1);
  if (!row) return null;

  const linked = await db
    .select(ROLE_FIELDS)
    .from(membershipRoles)
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(and(eq(membershipRoles.membershipId, row.membershipId), eq(roles.serverId, serverId)));
  const held = linked.map(toRole);
  if (row.legacyRoleId && !held.some((role) => role.id === row.legacyRoleId)) {
    const [legacy] = await db
      .select(ROLE_FIELDS)
      .from(roles)
      .where(and(eq(roles.id, row.legacyRoleId), eq(roles.serverId, serverId)))
      .limit(1);
    if (legacy) held.push(toRole(legacy));
  }
  held.sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));

  return {
    userId: row.userId,
    globalDisplayName: row.globalDisplayName,
    nickname: row.nickname && row.nickname.trim() ? row.nickname : null,
    avatarRef: row.avatarRef ?? null,
    bannerRef: row.bannerRef ?? null,
    profileVisibility: toProfileVisibility(row.profileVisibility),
    isGuest: row.isGuest,
    statusText: row.statusText,
    bio: row.bio,
    username: row.username ?? null,
    pronouns: row.pronouns ?? null,
    accentColor: row.accentColor ?? null,
    accountCreatedAt: row.accountCreatedAt,
    joinedAt: row.joinedAt,
    timedOutUntil: row.timedOutUntil,
    voiceMuted: row.voiceMuted,
    roles: held,
  };
}

export interface MutualServerRow {
  id: string;
  name: string;
  /** A legacy https icon URL, or null — never a data URL (security-review FILE-001). */
  iconUrl: string | null;
}

/** Longest https icon URL passed through (the same bound as user images). */
const MAX_ICON_URL_LENGTH = 2048;

/**
 * Communities BOTH users currently belong to: a membership each, a live
 * server, and an active ban for neither of them. The viewer is a member of
 * every one, so the list names nothing the viewer could not already see.
 * `total` counts all of them; `servers` is the first `limit` by name.
 */
export async function listMutualServers(
  db: DbClient,
  viewerUserId: string,
  userId: string,
  options: { limit?: number } = {}
): Promise<{ servers: MutualServerRow[]; total: number }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const subject = sql`${userId}::uuid`;
  // Joined (not a single-table select): every column renders qualified,
  // so `servers.id` inside the subqueries stays "servers"."id".
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      iconUrl: sql<string | null>`case
        when substr(${servers.iconUrl}, 1, 8) = 'https://' and octet_length(${servers.iconUrl}) <= ${sql.raw(String(MAX_ICON_URL_LENGTH))} then ${servers.iconUrl}
        else null
      end`,
      total: sql<string | number>`count(*) over ()`,
    })
    .from(servers)
    .innerJoin(memberships, and(eq(memberships.serverId, servers.id), eq(memberships.userId, viewerUserId)))
    .where(
      and(
        isNull(servers.deletedAt),
        // The viewer is not banned there (a membership can outlive a ban).
        not(activeBanOnMembershipSql()),
        sql`exists (
          select 1 from memberships subject_m
          join users subject_u on subject_u.id = subject_m.user_id and subject_u.deleted_at is null
          where subject_m.server_id = ${servers.id} and subject_m.user_id = ${subject}
        )`,
        sql`not exists (
          select 1 from server_bans subject_b
          where subject_b.server_id = ${servers.id} and subject_b.user_id = ${subject}
            and (subject_b.expires_at is null or subject_b.expires_at > now())
        )`
      )
    )
    .orderBy(asc(servers.name), asc(servers.id))
    .limit(limit);
  const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
  return {
    servers: rows.map((row) => ({ id: row.id, name: row.name, iconUrl: row.iconUrl ?? null })),
    total: Number.isFinite(total) ? total : rows.length,
  };
}
