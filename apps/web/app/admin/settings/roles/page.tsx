import type { Metadata } from 'next';
import { sql } from 'drizzle-orm';
import {
  listRolesForServer,
  membershipRoles,
  memberships,
  type RoleRow,
} from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import RolesClient, { type RoleView } from './RolesClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('roles', 'adminSettings.roles.metaTitle');
}

interface RoleWithCount extends RoleRow {
  memberCount: number;
}

export default async function RolesSettingsPage() {
  const access = await requireAdminSection('roles');
  const db = getDb();

  let serverId: string | null = null;
  let roles: RoleWithCount[] = [];
  let loadError: string | null = null;

  if (access.userId) {
    try {
      const firstServer = access.server;
      if (firstServer) {
        serverId = firstServer.id;
        const raw = await listRolesForServer(db, firstServer.id);
        const counts = await countMembersForRoles(db, firstServer.id, raw.map((role) => role.id));
        roles = raw
          .slice()
          .sort((a, b) => b.position - a.position)
          .map((role) => ({ ...role, memberCount: counts.get(role.id) ?? 0 }));
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community" sections={access.sections}>
      <RolesClient
        serverId={serverId}
        initialRoles={roles.map(toRoleView)}
        loadError={loadError}
      />
    </SettingsShell>
  );
}

async function countMembersForRoles(
  db: ReturnType<typeof getDb>,
  serverId: string,
  roleIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (roleIds.length === 0) return map;

  const fromJoin = await db
    .select({ roleId: membershipRoles.roleId, count: sql<number>`COUNT(*)::int` })
    .from(membershipRoles)
    .innerJoin(memberships, sql`${memberships.id} = ${membershipRoles.membershipId}`)
    .where(sql`${memberships.serverId} = ${serverId}`)
    .groupBy(membershipRoles.roleId);
  for (const row of fromJoin) map.set(row.roleId, Number(row.count ?? 0));

  const fromPrimary = await db
    .select({ roleId: memberships.roleId, count: sql<number>`COUNT(*)::int` })
    .from(memberships)
    .where(sql`${memberships.serverId} = ${serverId} AND ${memberships.roleId} IS NOT NULL`)
    .groupBy(memberships.roleId);
  for (const row of fromPrimary) {
    const id = row.roleId as string;
    map.set(id, (map.get(id) ?? 0) + Number(row.count ?? 0));
  }
  return map;
}

function toRoleView(role: RoleWithCount): RoleView {
  return {
    id: role.id,
    serverId: role.serverId,
    name: role.name,
    color: role.color,
    icon: role.icon,
    displaySeparately: role.displaySeparately,
    position: role.position,
    permissions: role.permissions,
    memberCount: role.memberCount,
    createdAt: role.createdAt.toISOString(),
  };
}
