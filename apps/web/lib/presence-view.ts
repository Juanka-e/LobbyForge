/**
 * The ONE presence projection every surface uses (REST GET /api/presence,
 * the server-rendered lobby): drop users the viewer blocked, apply each
 * user's privacy settings (online status / activity / server name) and
 * hide channels the viewer cannot see (F8).
 *
 * beta-review: the lobby page used to render the raw Redis snapshot, so
 * "online status: nobody" and role-gated voice rooms leaked on first paint.
 */
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getBlockedUserIds,
  getUserPermissions,
  getUserSettings,
  listVisibleChannelsForMember,
  DEFAULT_USER_PRIVACY_SETTINGS,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import type { UserPresenceSnapshot } from '@/lib/redis';
import { applyPresencePrivacy, type PublicPresenceSnapshot } from '@/lib/presence-privacy';

/**
 * Channel ids this viewer may see, or `null` when they see every channel
 * (owner / MANAGE_CHANNELS — the same bypass as the channel list route).
 */
export async function resolveVisibleChannelIds(
  serverId: string,
  viewerUserId: string,
  ownerUserId: string | null
): Promise<Set<string> | null> {
  if (ownerUserId && ownerUserId === viewerUserId) return null;
  const permissions = await getUserPermissions(getDb(), viewerUserId, serverId);
  if (hasPermission(permissions, CorePermission.MANAGE_CHANNELS)) return null;
  const channels = await listVisibleChannelsForMember(getDb(), serverId, viewerUserId);
  return new Set(channels.map((channel) => channel.id));
}

export async function projectServerPresenceForViewer(input: {
  serverId: string;
  viewerUserId: string;
  ownerUserId: string | null;
  presences: UserPresenceSnapshot[];
}): Promise<PublicPresenceSnapshot[]> {
  const { serverId, viewerUserId, ownerUserId, presences } = input;
  const [blockedIds, visibleChannelIds] = await Promise.all([
    getBlockedUserIds(getDb(), viewerUserId),
    resolveVisibleChannelIds(serverId, viewerUserId, ownerUserId),
  ]);
  return Promise.all(
    presences
      .filter((presence) => !blockedIds.has(presence.userId))
      .map(async (presence) => {
        const settings = await getUserSettings(getDb(), presence.userId);
        return applyPresencePrivacy(presence, settings?.privacy ?? DEFAULT_USER_PRIVACY_SETTINGS, {
          isSelf: presence.userId === viewerUserId,
          isServerMember: true,
          ...(visibleChannelIds ? { visibleChannelIds } : {}),
        });
      })
  );
}
