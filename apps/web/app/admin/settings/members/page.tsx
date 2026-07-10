import { cookies } from 'next/headers';
import {
  getInstanceSetupStatus,
  listMembersForServer,
  listMemberSummariesForServer,
  listRolesForServer,
  listServersForUser,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';
import MembersClient, { type MemberView } from './MembersClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Members - Community Settings',
};

export default async function MembersSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Members</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const setup = await getInstanceSetupStatus(getDb());
  const db = getDb();
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? setup.ownerUserId ?? null;

  let members: MemberView[] = [];
  let roles: Array<{ id: string; name: string; color: string | null; position: number; permissions: string[] }> = [];
  let serverId: string | null = null;
  let ownerUserId: string | null = null;
  let loadError: string | null = null;
  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const firstServer = servers[0];
      if (firstServer) {
        serverId = firstServer.id;
        ownerUserId = firstServer.ownerUserId;
        const rows = await listMemberSummariesForServer(db, firstServer.id);
        const roleRows = await listRolesForServer(db, firstServer.id);
        const memberRoles = await listMembersForServer(db, firstServer.id);
        const roleIdsByUser = new Map(memberRoles.map((row) => [row.userId, row.roleIds]));
        roles = roleRows
          .slice()
          .sort((a, b) => b.position - a.position)
          .map((role) => ({
            id: role.id,
            name: role.name,
            color: role.color,
            position: role.position,
            permissions: role.permissions,
          }));
        members = rows.map((row) => ({
          userId: row.userId,
          displayName: row.displayName,
          globalDisplayName: row.globalDisplayName,
          nickname: row.nickname,
          avatarUrl: row.avatarUrl,
          isGuest: row.isGuest,
          roleName: row.roleName,
          roleColor: row.roleColor,
          roleIds: roleIdsByUser.get(row.userId) ?? [],
          joinedAt: row.joinedAt.toISOString(),
        }));
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community">
      <MembersClient
        serverId={serverId}
        currentUserId={userId}
        ownerUserId={ownerUserId}
        members={members}
        roles={roles}
        loadError={loadError}
      />
    </SettingsShell>
  );
}
