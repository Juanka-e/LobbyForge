import type { UserPrivacySettings } from '@lobbyforge/db';
import type { UserPresenceSnapshot } from '@/lib/redis';

export type ViewerRelation = {
  isSelf: boolean;
  isServerMember: boolean;
  isFriend?: boolean;
};

export type PublicPresenceSnapshot = Omit<UserPresenceSnapshot, 'status' | 'activity'> & {
  status: UserPresenceSnapshot['status'] | 'hidden';
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

  const next: PublicPresenceSnapshot = {
    userId: presence.userId,
    channelId: presence.channelId,
    lastSeen: presence.lastSeen,
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
