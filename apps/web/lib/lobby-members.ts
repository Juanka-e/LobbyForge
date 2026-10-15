/**
 * A lobby member row — what the lobby's member list, profile cards, mention
 * picker and voice roster know about each member, already projected for the
 * viewer. The page render builds the first list; `GET
 * /api/servers/{id}/lobby-members` builds the same rows again when a live
 * event says some changed (docs/PROFILES.md "Live updates").
 *
 * Client-safe: the builder only uses the privacy projection, no database.
 */
import type { MemberSummary } from '@lobbyforge/db';
import { projectMemberProfile } from '@/lib/profile-privacy';
import type { PresenceStatus } from '@/lib/presence-status';

export interface LobbyMemberRole {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  position: number;
  displaySeparately: boolean;
}

export interface LobbyMember {
  id: string;
  name: string;
  status: 'in-voice' | 'online' | 'offline';
  /** The status the member chose (drives the dot color). */
  presence?: PresenceStatus;
  muted?: boolean;
  grayscale?: boolean;
  roleName?: string | null;
  roleColor?: string | null;
  roleIcon?: string | null;
  /** The account's own name, and the nickname that replaces it here (names are never hidden). */
  globalDisplayName?: string;
  nickname?: string | null;
  /** The handle (0050) — an identity field like the name, never hidden. */
  username?: string | null;
  statusText?: string | null;
  bio?: string | null;
  /** 0050: withheld with the rest of the profile when its visibility says so. */
  pronouns?: string | null;
  accentColor?: string | null;
  roles?: LobbyMemberRole[];
  isGuest?: boolean;
  /** Short image URL (security-review FILE-001) — never a data URL. */
  avatarUrl?: string | null;
  /** Banner reference; the profile card builds the URL when it opens. */
  bannerRef?: string | null;
}

/** Status and presence come from the presence feed; this row starts offline. */
export function toLobbyMember(
  summary: MemberSummary,
  viewerUserId: string | null,
  presence: { status: LobbyMember['status']; presence: PresenceStatus } = { status: 'offline', presence: 'offline' }
): LobbyMember {
  return {
    id: summary.userId,
    name: summary.displayName,
    status: presence.status,
    presence: presence.presence,
    grayscale: presence.status === 'offline' || undefined,
    // The display role (`pickDisplayRole`): the highest one other than
    // @everyone, worked out by the query from every role held — the
    // same one the Members page shows.
    roleName: summary.roleName,
    roleColor: summary.roleColor,
    roleIcon: summary.roleIcon,
    roles: summary.roles,
    isGuest: summary.isGuest,
    globalDisplayName: summary.globalDisplayName,
    nickname: summary.nickname,
    username: summary.username ?? null,
    // security-review FILE-001 / AUTHZ-005: short avatar URL + banner
    // reference (never data URLs), and avatar / banner / bio / status /
    // pronouns / colour only when the member's profile visibility allows
    // this viewer.
    ...projectMemberProfile(summary, viewerUserId),
  };
}

const STATUS_ORDER: Record<LobbyMember['status'], number> = { 'in-voice': 0, online: 1, offline: 2 };

/** In voice, then online, then offline; by name inside each. */
export function compareLobbyMembers(a: Pick<LobbyMember, 'status' | 'name'>, b: Pick<LobbyMember, 'status' | 'name'>): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name);
}
