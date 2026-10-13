import { NextResponse } from 'next/server';
import {
  DEFAULT_USER_PRIVACY_SETTINGS,
  getActiveMemberTimeout,
  getHighestRolePosition,
  getMemberProfileRecord,
  getServerById,
  getUserPermissions,
  getUserSettings,
  isServerMember,
  isUserBlocked,
  listMutualServers,
  listRolesForServer,
  type MemberProfileRecord,
} from '@lobbyforge/db';
import { requireMaterializedSession } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { canViewProfile, projectMemberProfile } from '@/lib/profile-privacy';
import { userImageUrl } from '@/lib/user-image-url';
import { applyPresencePrivacy } from '@/lib/presence-privacy';
import { getUserPresenceInServerForUser, type UserPresenceSnapshot } from '@/lib/redis';
import { toPresenceStatus, type PresenceStatus } from '@/lib/presence-status';
import {
  computeViewerCapabilities,
  EVERYONE_ROLE_NAME,
  mayModerate,
  type ModerationFacts,
} from '@/lib/member-capabilities';
import type { MemberProfileResponse, MemberProfileView } from '@/lib/member-profile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A heartbeat older than this is offline (the presence keys' own TTL). */
const PRESENCE_STALE_MS = 90_000;
/** Mutual communities named in one answer; the count covers all of them. */
const MUTUAL_SERVER_LIMIT = 50;

function notFound(): NextResponse {
  // One answer for "no such server", "you are not a member" and "they are
  // not a member": the route is no oracle for who belongs where.
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The member's status as THIS viewer may see it — the same projection as
 * GET /api/presence (`applyPresencePrivacy`): a hidden online status, an
 * expired heartbeat or no heartbeat at all read as offline.
 */
function viewerPresence(
  snapshot: UserPresenceSnapshot | null,
  privacy: typeof DEFAULT_USER_PRIVACY_SETTINGS,
  isSelf: boolean,
  now: number = Date.now()
): PresenceStatus {
  if (!snapshot) return 'offline';
  const shown = applyPresencePrivacy(snapshot, privacy, { isSelf, isServerMember: true });
  if (shown.status === 'hidden' || now - shown.lastSeen > PRESENCE_STALE_MS) return 'offline';
  return toPresenceStatus(shown.status, 'online');
}

function visibleRoles(record: MemberProfileRecord): MemberProfileView['roles'] {
  return record.roles
    .filter((role) => role.name !== EVERYONE_ROLE_NAME)
    .map((role) => ({ id: role.id, name: role.name, color: role.color, icon: role.icon, position: role.position }));
}

/**
 * GET /api/servers/{id}/members/{userId}/profile — one member's profile
 * card, projected for the viewer (docs/PROFILES.md).
 *
 *   - The viewer must be the owner or a current member of the server, and
 *     the subject a current member; anything else is the same 404.
 *   - Profile visibility (`canViewProfile` / `projectMemberProfile`, the
 *     lobby's own projection): a hidden profile keeps only names, roles,
 *     the Guest tag and the presence its own privacy allows.
 *   - A block in either direction keeps the payload just as small, and
 *     drops presence too (the presence feed drops users you blocked).
 *   - `viewerCan` is what the moderation routes would accept from this
 *     viewer (lib/member-capabilities.ts); they still check again.
 */
async function handleGet(
  req: Request,
  ctx: { params: Promise<{ id: string; userId: string }> }
): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const viewerId = sessionResult.session.uid;
  const { id: serverId, userId } = await ctx.params;
  if (!ID_PATTERN.test(serverId ?? '') || !ID_PATTERN.test(userId ?? '')) return notFound();

  try {
    const db = getDb();
    const server = await getServerById(db, serverId);
    if (!server) return notFound();
    const viewerIsOwner = server.ownerUserId === viewerId;
    const viewerIsMember = await isServerMember(db, viewerId, serverId);
    if (!viewerIsOwner && !viewerIsMember) return notFound();

    const record = await getMemberProfileRecord(db, serverId, userId);
    if (!record) return notFound();

    const isSelf = userId === viewerId;
    const [blockedByMe, blockedMe, settings, actorPermissions, actorTimeout, actorHighest, targetHighest] =
      await Promise.all([
        isSelf ? false : isUserBlocked(db, viewerId, userId),
        isSelf ? false : isUserBlocked(db, userId, viewerId),
        getUserSettings(db, userId),
        getUserPermissions(db, viewerId, serverId),
        viewerIsOwner ? null : getActiveMemberTimeout(db, serverId, viewerId),
        getHighestRolePosition(db, serverId, viewerId, server.ownerUserId),
        getHighestRolePosition(db, serverId, userId, server.ownerUserId),
      ]);

    const facts: ModerationFacts = {
      actorIsOwner: viewerIsOwner,
      actorIsMember: viewerIsMember,
      actorPermissions,
      actorTimedOut: actorTimeout !== null,
      actorHighest,
      isSelf,
      targetIsOwner: userId === server.ownerUserId,
      targetIsMember: true,
      targetHighest,
    };
    const blocked = blockedByMe || blockedMe;
    const serverRoles = mayModerate('set_roles', facts) ? await listRolesForServer(db, serverId) : [];
    const viewerCan = computeViewerCapabilities({
      facts,
      targetRoles: record.roles,
      serverRoles,
      canMessage: !isSelf && !blocked,
    });

    // The lobby's projection, unchanged: avatar / banner / bio / status
    // only when the member's profile visibility allows this viewer. The
    // viewer shares this server with the member, so "server members" passes.
    const profileVisible = canViewProfile(record.profileVisibility, { isSelf, sharesServer: true });
    const projected = projectMemberProfile(record, viewerId);
    const limited = !profileVisible || blocked;

    let presence: PresenceStatus | null = null;
    if (!blocked) {
      const snapshot = await getUserPresenceInServerForUser(serverId, userId).catch(() => null);
      presence = viewerPresence(snapshot, settings?.privacy ?? DEFAULT_USER_PRIVACY_SETTINGS, isSelf);
    }

    const mutual =
      limited || isSelf
        ? { servers: [], total: 0 }
        : await listMutualServers(db, viewerId, userId, { limit: MUTUAL_SERVER_LIMIT });

    const profile: MemberProfileView = {
      userId: record.userId,
      displayName: record.nickname ?? record.globalDisplayName,
      globalDisplayName: record.globalDisplayName,
      nickname: record.nickname,
      // A block keeps the avatar the privacy setting allows — the same
      // rule as the block list (`projectBlockedUser`).
      avatarUrl: projected.avatarUrl,
      bannerUrl: limited ? null : userImageUrl(record.userId, 'banner', projected.bannerRef),
      isGuest: record.isGuest,
      statusText: limited ? null : projected.statusText,
      bio: limited ? null : projected.bio,
      presence,
      roles: visibleRoles(record),
      memberSince: limited ? null : record.joinedAt.toISOString(),
      accountCreatedAt: limited ? null : record.accountCreatedAt.toISOString(),
      mutualServers: mutual.servers,
      mutualServerCount: mutual.total,
      blockedByMe,
      limited,
      isOwner: facts.targetIsOwner,
      timedOutUntil:
        viewerCan.timeout && record.timedOutUntil && record.timedOutUntil.getTime() > Date.now()
          ? record.timedOutUntil.toISOString()
          : null,
    };

    const body: MemberProfileResponse = { profile, viewerCan };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[member-profile] failed:', (error as Error).name || 'UnknownError');
    return NextResponse.json({ error: 'Failed to load the profile' }, { status: 500 });
  }
}

export const GET = withApiSecurity(handleGet, {
  allowedMethods: ['GET'],
  rateLimit: { identifier: 'member-profile', config: { windowMs: 60_000, maxRequests: 120 } },
});
