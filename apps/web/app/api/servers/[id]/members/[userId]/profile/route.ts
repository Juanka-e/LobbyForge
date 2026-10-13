import { NextResponse } from 'next/server';
import {
  DEFAULT_USER_PRIVACY_SETTINGS,
  getActiveMemberTimeout,
  getChannelById,
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
import { resolveVisibleChannelIds } from '@/lib/presence-view';
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
 * expired heartbeat or no heartbeat at all read as offline, and the
 * channel is kept only when the viewer may see it.
 */
function viewerPresence(
  snapshot: UserPresenceSnapshot | null,
  privacy: typeof DEFAULT_USER_PRIVACY_SETTINGS,
  relation: { isSelf: boolean; visibleChannelIds: ReadonlySet<string> | null },
  now: number = Date.now()
): { presence: PresenceStatus; channelId: string | null } {
  if (!snapshot) return { presence: 'offline', channelId: null };
  const shown = applyPresencePrivacy(snapshot, privacy, {
    isSelf: relation.isSelf,
    isServerMember: true,
    ...(relation.visibleChannelIds ? { visibleChannelIds: relation.visibleChannelIds } : {}),
  });
  if (shown.status === 'hidden' || now - shown.lastSeen > PRESENCE_STALE_MS) return { presence: 'offline', channelId: null };
  const presence = toPresenceStatus(shown.status, 'online');
  // "Invisible" is offline in every list, voice included.
  return { presence, channelId: presence === 'offline' ? null : shown.channelId };
}

/** In a voice room of this server — the member list's "in voice" rule. */
async function isVoiceChannelOf(db: ReturnType<typeof getDb>, serverId: string, channelId: string | null): Promise<boolean> {
  if (!channelId) return false;
  const channel = await getChannelById(db, channelId).catch(() => null);
  return Boolean(channel && channel.serverId === serverId && (channel.type === 'voice' || channel.type === 'stage'));
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
 *   - A block in either direction keeps the payload just as small. Like
 *     the presence feed, someone the viewer blocked shows no status at
 *     all; a member who blocked the viewer looks like any hidden profile.
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
      // Only the viewer's OWN block hides the box. Someone who blocked the
      // viewer still gets it, and the DM route refuses the message — the
      // card must not be the way to find out you were blocked.
      canMessage: !isSelf && !blockedByMe,
    });

    // The lobby's projection, unchanged: avatar / banner / bio / status
    // only when the member's profile visibility allows this viewer. The
    // viewer shares this server with the member, so "server members" passes.
    const profileVisible = canViewProfile(record.profileVisibility, { isSelf, sharesServer: true });
    const projected = projectMemberProfile(record, viewerId);
    const limited = !profileVisible || blocked;

    // Presence follows GET /api/presence: dropped for someone the viewer
    // blocked, and otherwise projected by the member's own privacy — a
    // member who blocked the viewer shows the same status as in the member
    // list (and the same as any hidden profile), so nothing gives the block away.
    let presence: PresenceStatus | null = null;
    let inVoice = false;
    if (!blockedByMe) {
      const snapshot = await getUserPresenceInServerForUser(serverId, userId).catch(() => null);
      const visibleChannelIds =
        snapshot?.channelId && !isSelf ? await resolveVisibleChannelIds(serverId, viewerId, server.ownerUserId) : null;
      const shown = viewerPresence(snapshot, settings?.privacy ?? DEFAULT_USER_PRIVACY_SETTINGS, { isSelf, visibleChannelIds });
      presence = shown.presence;
      inVoice = await isVoiceChannelOf(db, serverId, shown.channelId);
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
      // Your own block keeps the avatar the privacy setting allows — the
      // block list's rule (`projectBlockedUser`). A member who blocked you
      // looks exactly like a hidden profile: no avatar either.
      avatarUrl: blockedMe ? null : projected.avatarUrl,
      bannerUrl: limited ? null : userImageUrl(record.userId, 'banner', projected.bannerRef),
      isGuest: record.isGuest,
      statusText: limited ? null : projected.statusText,
      bio: limited ? null : projected.bio,
      presence,
      inVoice,
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
