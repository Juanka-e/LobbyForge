/**
 * Role queries — thin wrappers over the Drizzle client.
 *
 * A "role" is a named bundle of permissions that can be assigned to a
 * member. Every server ships with two seed roles:
 *   - `@everyone` (position 0) — assigned to every new member. Its
 *     `permissions` array is the default capability set (speak, send
 *     messages, react, connect to voice).
 *   - `@admin` (position 100) — assigned to the owner at server creation.
 *     It carries `CorePermission.ADMINISTRATOR`, which `hasPermission` in
 *     `@lobbyforge/core` treats as the "allow anything" override.
 *
 * Position is dense within a server (no gaps unless the caller explicitly
 * sets one). Higher position = more authority; the order matters when
 * multiple roles are assigned to a single member.
 */
import { and, asc, eq, inArray, isNull, sql, lt, lte, gt, gte } from 'drizzle-orm';
import type { DbClient } from '../client.js';
import {
  CorePermission,
  type CorePermission as CorePermissionT,
} from '@lobbyforge/core';
import { membershipRoles, memberships, roles, servers } from '../schema.js';

export interface RoleRow {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  icon: string | null;
  displaySeparately: boolean;
  position: number;
  permissions: string[];
  createdAt: Date;
}

export interface CreateRoleInput {
  serverId: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  displaySeparately?: boolean;
  position?: number;
  permissions: string[];
}

/**
 * The two reserved role names. They are matched on insert / update so the
 * route layer can reject a rename of `@everyone` or a position-0 collision.
 */
export const EVERYONE_ROLE_NAME = '@everyone';
export const ADMIN_ROLE_NAME = 'Owner';

/**
 * The default permission set for `@everyone`. New members get exactly
 * these unless a server admin changes the role.
 */
export const DEFAULT_EVERYONE_PERMISSIONS: CorePermissionT[] = [
  CorePermission.SEND_MESSAGES,
  CorePermission.READ_MESSAGE_HISTORY,
  CorePermission.MENTION_EVERYONE,
  CorePermission.CONNECT_VOICE,
  CorePermission.SPEAK,
  CorePermission.STREAM,
  CorePermission.ADD_REACTIONS,
  CorePermission.CREATE_INVITE,
];

/**
 * The default permission set for `@admin`. ADMINISTRATOR short-circuits
 * `hasPermission` to true; we still list the other permissions so the UI
 * can render the "all perms" badge without a special case.
 */
export const DEFAULT_ADMIN_PERMISSIONS: CorePermissionT[] = [
  CorePermission.ADMINISTRATOR,
  CorePermission.MANAGE_SERVER,
  CorePermission.MANAGE_CHANNELS,
  CorePermission.MANAGE_ROLES,
  CorePermission.MANAGE_MESSAGES,
  CorePermission.KICK_MEMBERS,
  CorePermission.BAN_MEMBERS,
  CorePermission.MUTE_MEMBERS,
  CorePermission.DEAFEN_MEMBERS,
  CorePermission.VIEW_AUDIT_LOG,
  CorePermission.START_ACTIVITY,
];

function normalizePermissions(input: string[]): string[] {
  // Deduplicate + drop unknown entries; this lets the caller ship
  // a wider set than CorePermission without poisoning the column.
  const known = new Set<string>(Object.values(CorePermission));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    if (!known.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Seed the two default roles for a freshly created server and assign
 * `@admin` to the owner. Idempotent: the unique `(serverId, name)` lookup
 * is what makes the "already-seeded" case a no-op.
 *
 * Returns the (possibly pre-existing) ids of the two roles.
 */
export interface SeedDefaultRolesResult {
  everyoneRoleId: string;
  adminRoleId: string;
}

export async function seedDefaultRoles(
  db: DbClient,
  serverId: string,
  ownerUserId: string
): Promise<SeedDefaultRolesResult> {
  const existing = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.serverId, serverId));
  let everyoneRoleId = existing.find((r) => r.name === EVERYONE_ROLE_NAME)?.id;
  let adminRoleId = existing.find((r) => r.name === ADMIN_ROLE_NAME)?.id;

  if (!everyoneRoleId) {
    const [row] = await db
      .insert(roles)
      .values({
        serverId,
        name: EVERYONE_ROLE_NAME,
        position: 0,
        permissions: DEFAULT_EVERYONE_PERMISSIONS,
      })
      .returning({ id: roles.id });
    if (!row) throw new Error('seedDefaultRoles: @everyone insert returned no rows');
    everyoneRoleId = row.id;
  }
  if (!adminRoleId) {
    const [row] = await db
      .insert(roles)
      .values({
        serverId,
        name: ADMIN_ROLE_NAME,
        displaySeparately: false,
        position: 100,
        permissions: DEFAULT_ADMIN_PERMISSIONS,
      })
      .returning({ id: roles.id });
    if (!row) throw new Error('seedDefaultRoles: @admin insert returned no rows');
    adminRoleId = row.id;
  }

  // Assign @admin to the owner if they don't already have a role on the server.
  const ownerMembership = await db
    .select({ id: memberships.id, roleId: memberships.roleId })
    .from(memberships)
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, ownerUserId)))
    .limit(1);
  if (ownerMembership[0] && !ownerMembership[0].roleId && adminRoleId) {
    await db
      .update(memberships)
      .set({ roleId: adminRoleId })
      .where(eq(memberships.id, ownerMembership[0].id));
    // Mirror the role assignment in the membership_roles join table (M15.5)
    await db
      .insert(membershipRoles)
      .values({ membershipId: ownerMembership[0].id, roleId: adminRoleId });
  }

  return { everyoneRoleId, adminRoleId };
}

export async function createRole(db: DbClient, input: CreateRoleInput): Promise<RoleRow> {
  // Verify the server exists (not soft-deleted) before we insert.
  const server = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, input.serverId)))
    .limit(1);
  if (server.length === 0) {
    throw new Error(`createRole: server ${input.serverId} does not exist`);
  }

  const [row] = await db
    .insert(roles)
    .values({
      serverId: input.serverId,
      name: input.name,
      color: input.color ?? null,
      icon: input.icon ?? null,
      displaySeparately: input.displaySeparately ?? false,
      position: input.position ?? 0,
      permissions: normalizePermissions(input.permissions),
    })
    .returning();
  if (!row) throw new Error('createRole: insert returned no rows');
  return row as RoleRow;
}

export async function listRolesForServer(db: DbClient, serverId: string): Promise<RoleRow[]> {
  // Joins servers so a soft-deleted server returns no roles.
  const rows = await db
    .select({
      id: roles.id,
      serverId: roles.serverId,
      name: roles.name,
      color: roles.color,
      icon: roles.icon,
      displaySeparately: roles.displaySeparately,
      position: roles.position,
      permissions: roles.permissions,
      createdAt: roles.createdAt,
    })
    .from(roles)
    .innerJoin(servers, eq(servers.id, roles.serverId))
    .where(and(eq(roles.serverId, serverId), isNull(servers.deletedAt)))
    .orderBy(asc(roles.position), asc(roles.createdAt));
  return rows.map((r) => ({ ...r, permissions: r.permissions as string[] })) as RoleRow[];
}

export async function getRoleById(db: DbClient, roleId: string): Promise<RoleRow | null> {
  const rows = await db
    .select({
      id: roles.id,
      serverId: roles.serverId,
      name: roles.name,
      color: roles.color,
      icon: roles.icon,
      displaySeparately: roles.displaySeparately,
      position: roles.position,
      permissions: roles.permissions,
      createdAt: roles.createdAt,
    })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return { ...r, permissions: r.permissions as string[] };
}

export interface UpdateRoleInput {
  name?: string;
  color?: string | null;
  icon?: string | null;
  displaySeparately?: boolean;
  position?: number;
  permissions?: string[];
}

export async function updateRole(
  db: DbClient,
  roleId: string,
  input: UpdateRoleInput
): Promise<RoleRow> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.displaySeparately !== undefined) patch.displaySeparately = input.displaySeparately;
  if (input.position !== undefined) patch.position = input.position;
  if (input.permissions !== undefined) patch.permissions = normalizePermissions(input.permissions);

  if (Object.keys(patch).length === 0) {
    const existing = await getRoleById(db, roleId);
    if (!existing) throw new Error(`updateRole: role ${roleId} not found`);
    return existing;
  }

  return db.transaction(async (tx) => {
    if (input.position !== undefined) {
      const [current] = await tx
        .select({ serverId: roles.serverId, position: roles.position })
        .from(roles)
        .where(eq(roles.id, roleId));
      if (!current) throw new Error(`updateRole: role ${roleId} not found`);
      
      const oldPos = current.position;
      const newPos = input.position;

      if (oldPos !== newPos) {
        if (newPos > oldPos) {
          // Shift roles between oldPos+1 and newPos down by 1
          await tx
            .update(roles)
            .set({ position: sql`${roles.position} - 1` })
            .where(
              and(
                eq(roles.serverId, current.serverId),
                gt(roles.position, oldPos),
                lte(roles.position, newPos)
              )
            );
        } else {
          // Shift roles between newPos and oldPos-1 up by 1
          await tx
            .update(roles)
            .set({ position: sql`${roles.position} + 1` })
            .where(
              and(
                eq(roles.serverId, current.serverId),
                gte(roles.position, newPos),
                lt(roles.position, oldPos)
              )
            );
        }
      }
    }

    const [row] = await tx.update(roles).set(patch).where(eq(roles.id, roleId)).returning();
    if (!row) throw new Error(`updateRole: role ${roleId} not found`);
    return row as RoleRow;
  });
}

/**
 * Delete a role. The route layer is responsible for rejecting the
 * deletion of `@everyone` (it's structural, not a real role assignment).
 */
export async function deleteRole(db: DbClient, roleId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
    if (existing.length === 0) {
      throw new Error(`deleteRole: role ${roleId} not found`);
    }
    await tx.update(memberships).set({ roleId: null }).where(eq(memberships.roleId, roleId));
    await tx.delete(roles).where(eq(roles.id, roleId));
  });
}

/**
 * Compute the union of permissions a user has on a server, by joining
 * memberships → roles and reading the role's `permissions` JSONB. If the
 * user is the server owner, we return the `ADMINISTRATOR` permission
 * even before any role is assigned (so the owner is never blocked by a
 * missing seed-data path).
 *
 * As of M15.5 a member can hold multiple roles via the `membership_roles`
 * join table. The single `memberships.roleId` column is kept as the
 * "primary / display role" for the UI; the permission union reads from
 * both columns.
 */
export async function getUserPermissions(
  db: DbClient,
  userId: string,
  serverId: string
): Promise<string[]> {
  const server = await db
    .select({ ownerUserId: servers.ownerUserId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (server.length === 0) return [];
  if (server[0]!.ownerUserId === userId) {
    // Owner has implicit ADMINISTRATOR; skip the join.
    return [CorePermission.ADMINISTRATOR];
  }

  const membership = await db
    .select({ id: memberships.id, roleId: memberships.roleId })
    .from(memberships)
    .where(
      and(eq(memberships.userId, userId), eq(memberships.serverId, serverId))
    )
    .limit(1);
  if (membership.length === 0) return [];
  const m = membership[0]!;

  // Union: the primary role + every role in the join table. Dedupe
  // because @everyone is usually present in both.
  const allRoleIds = new Set<string>();
  if (m.roleId) allRoleIds.add(m.roleId);
  const joinedRows = await db
    .select({ roleId: membershipRoles.roleId })
    .from(membershipRoles)
    .where(eq(membershipRoles.membershipId, m.id));
  for (const r of joinedRows) allRoleIds.add(r.roleId);

  if (allRoleIds.size === 0) return [];

  const roleRows = await db
    .select({ permissions: roles.permissions })
    .from(roles)
    .where(inArray(roles.id, Array.from(allRoleIds)));

  const merged = new Set<string>();
  for (const r of roleRows) {
    for (const p of (r.permissions as string[] | null) ?? []) merged.add(p);
  }
  return Array.from(merged);
}

/**
 * Used by tests / introspection: list the members of a server with their
 * joined role(s). Returns a list of `MemberRoleInfo` tuples. As of
 * M15.5 the union of `memberships.roleId` + `membership_roles` is
 * returned as `roleIds`, and the role with the highest position wins
 * as `roleName` / `rolePosition` for UI display purposes.
 */
export interface MemberRoleInfo {
  userId: string;
  roleId: string | null;
  roleIds: string[];
  roleName: string | null;
  rolePosition: number | null;
  permissions: string[];
}

export async function listMembersForServer(
  db: DbClient,
  serverId: string
): Promise<MemberRoleInfo[]> {
  // First fetch the (membership, primary role) pairs.
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      roleId: memberships.roleId,
      roleName: roles.name,
      rolePosition: roles.position,
      permissions: roles.permissions,
    })
    .from(memberships)
    .leftJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.serverId, serverId))
    .orderBy(asc(memberships.createdAt));

  if (rows.length === 0) return [];

  // Then load the full role set per member from the join table.
  const { listRoleIdsForMemberships } = await import('./memberships.js');
  const roleIdsByMembership = await listRoleIdsForMemberships(
    db,
    rows.map((r) => r.membershipId)
  );

  return rows.map((r) => {
    const allRoleIds = new Set<string>();
    if (r.roleId) allRoleIds.add(r.roleId);
    for (const id of roleIdsByMembership.get(r.membershipId) ?? []) {
      allRoleIds.add(id);
    }
    return {
      userId: r.userId,
      roleId: r.roleId,
      roleIds: Array.from(allRoleIds),
      roleName: r.roleName,
      rolePosition: r.rolePosition,
      permissions: (r.permissions as string[] | null) ?? [],
    };
  });
}

/**
 * Discord-style role hierarchy: a member's effective rank is the HIGHEST
 * position among their roles. The server OWNER outranks every role
 * (Infinity). Members with no roles rank lowest (below every role).
 *
 * Mutation rule enforced by the routes: you may only assign/edit/delete
 * roles STRICTLY BELOW your own highest role. ADMINISTRATOR does NOT
 * bypass this (matching Discord) — only ownership does.
 */
export async function getHighestRolePosition(
  db: DbClient,
  serverId: string,
  userId: string,
  ownerUserId?: string | null
): Promise<number> {
  if (ownerUserId != null && ownerUserId === userId) return Number.POSITIVE_INFINITY;
  const rows = await db
    .select({ position: roles.position })
    .from(membershipRoles)
    .innerJoin(memberships, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)));
  // Memberships.roleId is the legacy single-role column — count it too.
  const legacy = await db
    .select({ position: roles.position })
    .from(memberships)
    .innerJoin(roles, eq(memberships.roleId, roles.id))
    .where(and(eq(memberships.serverId, serverId), eq(memberships.userId, userId)));
  const positions = [...rows, ...legacy].map((r) => r.position);
  return positions.length > 0 ? Math.max(...positions) : -1;
}
