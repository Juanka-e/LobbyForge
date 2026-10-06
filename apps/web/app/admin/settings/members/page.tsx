import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import {
  getInstanceSetupStatus,
  listMembersForServer,
  listMemberSummariesForServer,
  listRolesForServer,
  listServersForUser,
  listUserEmailVerification,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { getActiveSession } from '@/lib/active-session';
import { getTranslator } from '@/lib/i18n/server';
import SettingsShell from '@/app/SettingsShell';
import MembersClient, { type MemberView } from './MembersClient';
import { projectMemberProfile } from '@/lib/profile-privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('adminSettings.members.metaTitle') };
}

export default async function MembersSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    const t = await getTranslator();
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.members.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }

  const setup = await getInstanceSetupStatus(getDb());
  const db = getDb();
  const session = await getActiveSession(cookieStore.toString(), getSessionSecret());
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
        // EMAIL.md §5: each member's verification state (never the address).
        // Optional: a database without migration 0046 still lists members.
        const emailStates = new Map(
          (await listUserEmailVerification(db, rows.map((row) => row.userId)).catch(() => [])).map((state) => [
            state.userId,
            state.isGuest || !state.hasEmail ? 'none' : state.emailVerifiedAt ? 'verified' : 'unverified',
          ] as const)
        );
        members = rows.map((row) => ({
          userId: row.userId,
          displayName: row.displayName,
          globalDisplayName: row.globalDisplayName,
          nickname: row.nickname,
          // security-review FILE-001 / AUTHZ-005: short image URL, and only
          // when the member's profile visibility allows it — admins get no
          // bypass (same as presence privacy); the name always shows.
          avatarUrl: projectMemberProfile(row, userId).avatarUrl,
          isGuest: row.isGuest,
          roleName: row.roleName,
          roleColor: row.roleColor,
          roleIds: roleIdsByUser.get(row.userId) ?? [],
          joinedAt: row.joinedAt.toISOString(),
          emailState: emailStates.get(row.userId),
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
