import type { Metadata } from 'next';
import { countRoleHolders, listRolesForServer, type RoleRow } from '@lobbyforge/db';
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
        // Each holder once (the display role sits in both role columns).
        const counts = await countRoleHolders(db, firstServer.id);
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
