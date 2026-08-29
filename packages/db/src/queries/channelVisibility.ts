/**
 * Role-gated channel visibility (0028).
 *
 * Model: a channel with NO override rows is visible to every member
 * (inherited). A channel WITH rows is visible only to members holding
 * at least one of the listed roles. The owner and members with
 * manage_channels/administrator always see everything — that bypass is
 * applied by the ROUTE layer (permission-aware), these queries answer
 * the pure role question.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import { channelRoleOverrides, channels, memberships, membershipRoles, roles } from '../schema.js';
import type { ChannelRow } from './channels.js';

export interface ChannelRoleOverrideRow {
  id: string;
  channelId: string;
  roleId: string;
  createdAt: Date;
}

export async function listChannelRoleOverrides(
  db: DbClient,
  channelId: string
): Promise<ChannelRoleOverrideRow[]> {
  const rows = await db
    .select()
    .from(channelRoleOverrides)
    .where(eq(channelRoleOverrides.channelId, channelId));
  return rows as ChannelRoleOverrideRow[];
}

/**
 * Replace a channel's visibility override set. `roleIds = []` removes
 * every override (channel returns to inherited/everyone visibility).
 * Caller validates that each role belongs to the same server.
 */
export async function setChannelRoleOverrides(
  db: DbClient,
  channelId: string,
  roleIds: string[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(channelRoleOverrides).where(eq(channelRoleOverrides.channelId, channelId));
    const unique = Array.from(new Set(roleIds));
    if (unique.length > 0) {
      await tx
        .insert(channelRoleOverrides)
        .values(unique.map((roleId) => ({ channelId, roleId })));
    }
  });
}

/**
 * The member's role ids for a server: the legacy single-role column
 * PLUS every membership_roles row (multi-role).
 */
async function memberRoleIds(db: DbClient, serverId: string, userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const legacy = await db
    .select({ roleId: memberships.roleId })
    .from(memberships)
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)));
  for (const row of legacy) if (row.roleId) ids.add(row.roleId);
  const multi = await db
    .select({ roleId: membershipRoles.roleId })
    .from(membershipRoles)
    .innerJoin(memberships, eq(membershipRoles.membershipId, memberships.id))
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)));
  for (const row of multi) ids.add(row.roleId);
  return ids;
}

/**
 * Can this member SEE the channel (pure role semantics — the route adds
 * the owner/manage_channels bypass)? true when the channel has no
 * overrides, or the member holds at least one listed role.
 */
export async function canMemberAccessChannel(
  db: DbClient,
  serverId: string,
  channelId: string,
  userId: string
): Promise<boolean> {
  const overrides = await listChannelRoleOverrides(db, channelId);
  if (overrides.length === 0) return true;
  const held = await memberRoleIds(db, serverId, userId);
  return overrides.some((o) => held.has(o.roleId));
}

/**
 * Channels of the server this member can see. Two queries, no N+1:
 * visible = (channels with no overrides) ∪ (channels with an override
 * matching one of the member's roles).
 */
export async function listVisibleChannelsForMember(
  db: DbClient,
  serverId: string,
  userId: string
): Promise<ChannelRow[]> {
  const overridden = await db
    .selectDistinct({ channelId: channelRoleOverrides.channelId })
    .from(channelRoleOverrides)
    .innerJoin(channels, eq(channelRoleOverrides.channelId, channels.id))
    .where(eq(channels.serverId, serverId));
  const overriddenIds = new Set(overridden.map((r) => r.channelId));

  const all = (await db.select().from(channels).where(eq(channels.serverId, serverId))) as ChannelRow[];
  if (overriddenIds.size === 0) return all;

  const held = await memberRoleIds(db, serverId, userId);
  // A member with NO roles can never match an override — only the
  // non-gated channels are visible. (A sentinel uuid comparison would
  // fail the uuid cast; skipping the query is both correct and cheaper.)
  if (held.size === 0) {
    return all.filter((c) => !overriddenIds.has(c.id));
  }
  const allowed = await db
    .selectDistinct({ channelId: channelRoleOverrides.channelId })
    .from(channelRoleOverrides)
    .where(
      and(
        inArray(channelRoleOverrides.channelId, [...overriddenIds]),
        inArray(channelRoleOverrides.roleId, [...held])
      )
    );
  const allowedIds = new Set(allowed.map((r) => r.channelId));
  return all.filter((c) => !overriddenIds.has(c.id) || allowedIds.has(c.id));
}

/** Roles of a server, for the visibility editor (id/name/position). */
export async function listRolesBriefForServer(
  db: DbClient,
  serverId: string
): Promise<Array<{ id: string; name: string; position: number }>> {
  const rows = await db
    .select({ id: roles.id, name: roles.name, position: roles.position })
    .from(roles)
    .where(eq(roles.serverId, serverId));
  return rows;
}

/** All overrides of a server in one query (admin editor seeding). */
export async function getAllChannelRoleOverridesForServer(
  db: DbClient,
  serverId: string
): Promise<ChannelRoleOverrideRow[]> {
  const rows = await db
    .select({
      id: channelRoleOverrides.id,
      channelId: channelRoleOverrides.channelId,
      roleId: channelRoleOverrides.roleId,
      createdAt: channelRoleOverrides.createdAt,
    })
    .from(channelRoleOverrides)
    .innerJoin(channels, eq(channelRoleOverrides.channelId, channels.id))
    .where(eq(channels.serverId, serverId));
  return rows as ChannelRoleOverrideRow[];
}
