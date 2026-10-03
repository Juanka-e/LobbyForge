/**
 * Per-viewer projection of the "Profile visibility" privacy setting.
 *
 * security-review AUTHZ-005: `privacy.profileVisibility` was stored but
 * never read — "Nobody" still shipped avatar, banner, bio and status text
 * in the lobby payload, the DM list and the block list. Every surface
 * that shows another user's profile now goes through this module, the
 * same way presence goes through `applyPresencePrivacy`.
 *
 * What a viewer who is NOT allowed loses: avatar, banner, bio and status
 * text. The display name always stays — members must stay identifiable
 * (moderation, mentions, chat authorship); the settings copy says so.
 *
 * Scopes:
 *   - everyone        any signed-in viewer
 *   - server_members  viewers who share at least one server with the user
 *   - friends         same as server_members: there is no friends system,
 *                     and the settings page shows a stored 'friends' as
 *                     "Server members" — enforcement matches what it shows
 *   - nobody          the user only
 * The user always sees their own full profile. Owners and moderators get
 * no bypass — mirroring `applyPresencePrivacy`, which has none either.
 */
import type {
  ActivityVisibilityScope,
  DmChannelSummary,
  MemberSummary,
  UserBlockRow,
} from '@lobbyforge/db';
import { userImageUrl } from '@/lib/user-image-url';

export interface ProfileViewerRelation {
  isSelf: boolean;
  /** Viewer and profile owner are members of at least one common server. */
  sharesServer: boolean;
}

export function canViewProfile(
  scope: ActivityVisibilityScope,
  relation: ProfileViewerRelation
): boolean {
  if (relation.isSelf) return true;
  switch (scope) {
    case 'everyone':
      return true;
    case 'server_members':
    case 'friends':
      return relation.sharesServer;
    case 'nobody':
    default:
      return false;
  }
}

/** The profile fields of a member-list row, as shipped to the client. */
export interface MemberProfileView {
  /** Short same-origin image URL (or legacy https URL), never a data URL. */
  avatarUrl: string | null;
  /**
   * Banner reference only — the popover builds the URL when it opens, so
   * the list never carries the banner (security-review FILE-001).
   */
  bannerRef: string | null;
  statusText: string | null;
  bio: string | null;
}

const HIDDEN_MEMBER_PROFILE: MemberProfileView = {
  avatarUrl: null,
  bannerRef: null,
  statusText: null,
  bio: null,
};

/**
 * Project one member-summary row for `viewerUserId`. `sharesServer`
 * defaults to true: a server's member list is only rendered for members
 * of that server.
 */
export function projectMemberProfile(
  summary: Pick<MemberSummary, 'userId' | 'avatarRef' | 'bannerRef' | 'statusText' | 'bio' | 'profileVisibility'>,
  viewerUserId: string | null,
  relation: { sharesServer: boolean } = { sharesServer: true }
): MemberProfileView {
  const visible = canViewProfile(summary.profileVisibility, {
    isSelf: viewerUserId !== null && summary.userId === viewerUserId,
    sharesServer: relation.sharesServer,
  });
  if (!visible) return { ...HIDDEN_MEMBER_PROFILE };
  return {
    avatarUrl: userImageUrl(summary.userId, 'avatar', summary.avatarRef),
    bannerRef: userImageUrl(summary.userId, 'banner', summary.bannerRef) ? summary.bannerRef : null,
    statusText: summary.statusText,
    bio: summary.bio,
  };
}

/** A DM list entry as the API and the lobby ship it (shape unchanged for clients). */
export interface DmChannelView {
  id: string;
  otherUserId: string;
  otherUserDisplayName: string;
  otherUserAvatarUrl: string | null;
  lastMessageAt: Date;
}

export function projectDmChannel(channel: DmChannelSummary, viewerUserId: string): DmChannelView {
  const visible = canViewProfile(channel.otherUserProfileVisibility, {
    isSelf: channel.otherUserId === viewerUserId,
    sharesServer: channel.sharesServerWithOtherUser,
  });
  return {
    id: channel.id,
    otherUserId: channel.otherUserId,
    otherUserDisplayName: channel.otherUserDisplayName,
    otherUserAvatarUrl: visible ? userImageUrl(channel.otherUserId, 'avatar', channel.otherUserAvatarRef) : null,
    lastMessageAt: channel.lastMessageAt,
  };
}

/** A block-list entry as GET /api/settings/me/blocks ships it (shape unchanged). */
export interface BlockedUserView {
  id: string;
  blockerUserId: string;
  blockedUserId: string;
  blockedDisplayName: string;
  blockedAvatarUrl: string | null;
  createdAt: Date;
}

export function projectBlockedUser(row: UserBlockRow): BlockedUserView {
  const visible = canViewProfile(row.blockedProfileVisibility, {
    isSelf: row.blockedUserId === row.blockerUserId,
    sharesServer: row.sharesServerWithBlocked,
  });
  return {
    id: row.id,
    blockerUserId: row.blockerUserId,
    blockedUserId: row.blockedUserId,
    blockedDisplayName: row.blockedDisplayName,
    blockedAvatarUrl: visible ? userImageUrl(row.blockedUserId, 'avatar', row.blockedAvatarRef) : null,
    createdAt: row.createdAt,
  };
}
