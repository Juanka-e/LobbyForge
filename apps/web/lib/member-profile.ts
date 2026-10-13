/**
 * The profile card's data: the shape of
 * `GET /api/servers/{serverId}/members/{userId}/profile` and a small
 * per-session cache in front of it (docs/PROFILES.md).
 *
 * Client-safe: no Node or database imports. The route builds this shape on
 * the server, with every field already projected for the viewer — the
 * client never decides what it may see or do.
 */
import type { PresenceStatus } from '@/lib/presence-status';

export interface ProfileRoleView {
  id: string;
  name: string;
  /** Strict six-digit hex, or null. */
  color: string | null;
  /** A Material Symbols name from the role-icon allowlist, or null. */
  icon: string | null;
  position: number;
}

export interface MutualServerView {
  id: string;
  name: string;
  /** A legacy https icon, or null (never a data URL). */
  iconUrl: string | null;
}

export interface MemberProfileView {
  userId: string;
  /** What the community sees: the nickname, else the account's name. */
  displayName: string;
  globalDisplayName: string;
  nickname: string | null;
  /** Short same-origin URL (or legacy https URL); null when hidden or unset. */
  avatarUrl: string | null;
  bannerUrl: string | null;
  isGuest: boolean;
  statusText: string | null;
  bio: string | null;
  /**
   * The status the member chose, as this viewer may see it: `offline` for
   * a hidden online status (or nobody there); null when not shown at all
   * (a blocked relation).
   */
  presence: PresenceStatus | null;
  /** Roles in this server, highest first, without `@everyone`. */
  roles: ProfileRoleView[];
  /** ISO instant the member joined this community; null when hidden. */
  memberSince: string | null;
  /** ISO instant the account was created; null when hidden. */
  accountCreatedAt: string | null;
  mutualServers: MutualServerView[];
  mutualServerCount: number;
  /** The viewer blocked this member. */
  blockedByMe: boolean;
  /**
   * Profile details are withheld from this viewer: a hidden profile or a
   * block (either way — which one is not said). Only names, roles and the
   * avatar the privacy setting allows are left.
   */
  limited: boolean;
  /** The member owns this community. */
  isOwner: boolean;
  /** An active timeout's end — only for viewers who may time this member out. */
  timedOutUntil: string | null;
}

/** What the VIEWER may do to this member — worked out on the server. */
export interface ViewerCapabilities {
  isSelf: boolean;
  /** "Message @name" is offered (not yourself, no block either way). */
  message: boolean;
  kick: boolean;
  ban: boolean;
  timeout: boolean;
  serverMute: boolean;
  manageRoles: boolean;
  /** Roles the viewer may add (not held yet), highest first. */
  assignableRoles: ProfileRoleView[];
  /** Held role ids the viewer may remove. */
  removableRoleIds: string[];
  /**
   * Every role id the member holds, `@everyone` included — the role PUT
   * replaces the whole set. Empty unless `manageRoles`.
   */
  currentRoleIds: string[];
}

export interface MemberProfileResponse {
  profile: MemberProfileView;
  viewerCan: ViewerCapabilities;
}

/** What the lobby already knows about someone, so a card can open at once. */
export interface ProfileSeed {
  userId: string;
  displayName: string;
  globalDisplayName?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  isGuest?: boolean;
  statusText?: string | null;
  bio?: string | null;
  roles?: ProfileRoleView[];
  presence?: PresenceStatus | null;
  /** In a voice channel right now (shown apart from the presence dot). */
  inVoice?: boolean;
}

export function profileCacheKey(serverId: string, userId: string): string {
  return `${serverId}:${userId}`;
}

const cache = new Map<string, MemberProfileResponse>();
const inFlight = new Map<string, Promise<MemberProfileResponse | null>>();

/** The cached answer for (server, user), if this session has one. */
export function readCachedMemberProfile(serverId: string, userId: string): MemberProfileResponse | null {
  return cache.get(profileCacheKey(serverId, userId)) ?? null;
}

/** Forget one profile (after a change made through the card) or all of them. */
export function invalidateMemberProfile(serverId?: string, userId?: string): void {
  if (serverId === undefined) {
    cache.clear();
    return;
  }
  if (userId === undefined) {
    for (const key of [...cache.keys()]) if (key.startsWith(`${serverId}:`)) cache.delete(key);
    return;
  }
  cache.delete(profileCacheKey(serverId, userId));
}

export class MemberProfileError extends Error {
  constructor(readonly status: number) {
    super(`profile request failed: ${status}`);
  }
}

/**
 * Load a profile, from the cache unless `force`. Concurrent calls for the
 * same (server, user) share one request. A 404 (not a member any more, or
 * never visible) resolves to null and is not cached.
 */
export function fetchMemberProfile(
  serverId: string,
  userId: string,
  options: { force?: boolean; fetcher?: typeof fetch } = {}
): Promise<MemberProfileResponse | null> {
  const key = profileCacheKey(serverId, userId);
  if (!options.force) {
    const hit = cache.get(key);
    if (hit) return Promise.resolve(hit);
  }
  const pending = inFlight.get(key);
  if (pending && !options.force) return pending;
  const doFetch = options.fetcher ?? fetch;
  const request = doFetch(
    `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/profile`,
    { credentials: 'same-origin', cache: 'no-store' }
  )
    .then(async (res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new MemberProfileError(res.status);
      const body = (await res.json()) as MemberProfileResponse;
      cache.set(key, body);
      return body;
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Test hook: an empty cache between cases. */
export function __clearMemberProfileCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
