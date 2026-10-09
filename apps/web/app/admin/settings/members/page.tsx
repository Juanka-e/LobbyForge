import type { Metadata } from 'next';
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  listMembersForServer,
  listMemberSummariesForServer,
  listRolesForServer,
  listUserEmailVerification,
} from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection, type AdminAccess } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import { canReviewJoinRequests } from '@/lib/join-requests';
import SettingsShell from '@/app/SettingsShell';
import MembersClient, { type MemberCapabilities, type MemberView } from './MembersClient';
import { projectMemberProfile } from '@/lib/profile-privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('members', 'adminSettings.members.metaTitle');
}

/**
 * What this viewer may do here — the same rules the routes behind each
 * action apply, so no control is drawn that would only be refused.
 * Marking an email verified is an instance-admin route.
 */
function capabilitiesFor(access: AdminAccess): MemberCapabilities {
  if (access.instanceAdmin) {
    return { setRoles: true, kick: true, ban: true, reviewJoinRequests: true, verifyEmail: true };
  }
  const can = (permission: CorePermission) => hasPermission(access.permissions, permission);
  return {
    setRoles: can(CorePermission.MANAGE_ROLES),
    kick: can(CorePermission.KICK_MEMBERS),
    ban: can(CorePermission.BAN_MEMBERS),
    reviewJoinRequests: canReviewJoinRequests(access.permissions),
    verifyEmail: false,
  };
}

export default async function MembersSettingsPage() {
  const access = await requireAdminSection('members');
  const capabilities = capabilitiesFor(access);
  const db = getDb();
  const userId = access.userId;

  let members: MemberView[] = [];
  let roles: Array<{ id: string; name: string; color: string | null; position: number; permissions: string[] }> = [];
  let serverId: string | null = null;
  let ownerUserId: string | null = null;
  let loadError: string | null = null;
  if (userId) {
    try {
      const firstServer = access.server;
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
        // EMAIL.md §5: each member's verification state (never the address),
        // for the instance admin who can act on it — the members API gives
        // moderators no such field. Optional: a database without migration
        // 0046 still lists members.
        const emailStates = new Map(
          (capabilities.verifyEmail
            ? await listUserEmailVerification(db, rows.map((row) => row.userId)).catch(() => [])
            : []
          ).map((state) => [
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
    <SettingsShell scope="community" sections={access.sections}>
      <MembersClient
        serverId={serverId}
        currentUserId={userId}
        ownerUserId={ownerUserId}
        members={members}
        roles={roles}
        loadError={loadError}
        capabilities={capabilities}
      />
    </SettingsShell>
  );
}
