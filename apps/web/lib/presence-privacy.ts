import type { UserPrivacySettings } from '@lobbyforge/db';
import type { UserPresenceSnapshot } from '@/lib/redis';

export type ViewerRelation = {
  isSelf: boolean;
  isServerMember: boolean;
  isFriend?: boolean;
  /**
   * beta-review (F8): channels the VIEWER may see. When provided, a
   * presence located in any other channel (e.g. a role-gated voice
   * room) is returned with `channelId: null` — who sits in a private
   * room is channel-scoped metadata. Omit (undefined) when the viewer
   * sees every channel (owner / MANAGE_CHANNELS) or the caller already
   * verified the channel's visibility.
   */
  visibleChannelIds?: ReadonlySet<string>;
};

export type PublicPresenceSnapshot = Omit<UserPresenceSnapshot, 'status' | 'activity' | 'channelId'> & {
  status: UserPresenceSnapshot['status'] | 'hidden';
  /** null when the presence's channel is not visible to the viewer. */
  channelId: string | null;
  activity?: UserPresenceSnapshot['activity'];
};

function canViewScope(
  scope: UserPrivacySettings['activityVisibility'],
  relation: ViewerRelation
): boolean {
  if (relation.isSelf) return true;
  if (scope === 'everyone') return true;
  if (scope === 'server_members') return relation.isServerMember;
  if (scope === 'friends') return relation.isFriend === true;
  return false;
}

function canViewActivityKind(
  activity: UserPresenceSnapshot['activity'],
  privacy: UserPrivacySettings
): boolean {
  if (!activity) return false;
  if (activity.kind === 'game') return privacy.showCurrentGame;
  if (activity.kind === 'music') return privacy.showMusicStatus;
  if (activity.kind === 'watch_party') return privacy.showWatchPartyStatus;
  return true;
}

export function applyPresencePrivacy(
  presence: UserPresenceSnapshot,
  privacy: UserPrivacySettings,
  relation: ViewerRelation
): PublicPresenceSnapshot {
  const canViewOnlineStatus = canViewScope(privacy.onlineStatusVisibility, relation);
  const canViewActivity =
    canViewScope(privacy.activityVisibility, relation) &&
    canViewActivityKind(presence.activity, privacy);

  const canViewChannel =
    relation.isSelf ||
    !relation.visibleChannelIds ||
    relation.visibleChannelIds.has(presence.channelId);

  const next: PublicPresenceSnapshot = {
    userId: presence.userId,
    // beta-review (F8): never reveal a channel the viewer cannot see.
    channelId: canViewChannel ? presence.channelId : null,
    // beta-review: a hidden status must not leak through the heartbeat
    // timestamp either (clients derive "online" from lastSeen).
    lastSeen: canViewOnlineStatus ? presence.lastSeen : 0,
    status: canViewOnlineStatus ? presence.status : 'hidden',
  };

  if (canViewActivity && presence.activity) {
    next.activity = {
      ...presence.activity,
      ...(privacy.showServerNameInActivity ? {} : { serverName: undefined }),
    };
  }

  return next;
}
