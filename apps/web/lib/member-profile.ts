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
  /**
   * In one of this community's voice channels the viewer can see — false
   * whenever presence is not shown (hidden status, a block).
   */
  inVoice: boolean;
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
  /**
   * The member's status — only from an opener that knows it LIVE (the
   * member list). Leave it out otherwise: the page render's status goes
   * stale, and the API's is fresher.
   */
  presence?: PresenceStatus | null;
  /** In a voice channel right now — live facts only, like `presence`. */
  inVoice?: boolean;
}

/** What a profile shows: the API's answer once it is in, the lobby's seed until then. */
export interface MergedProfile {
  userId: string;
  displayName: string;
  globalDisplayName: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  isGuest: boolean;
  statusText: string | null;
  bio: string | null;
  presence: PresenceStatus | null;
  inVoice: boolean;
  roles: ProfileRoleView[];
  limited: boolean;
  isOwner: boolean;
  /** The API has answered (dates, mutual communities and `viewerCan` are known). */
  loaded: boolean;
}

const EVERYONE = '@everyone';

/**
 * Seed + API, field by field. The API wins for everything it projects
 * (images, about, roles), so a hidden or blocked profile never keeps a
 * seed value the server withheld. Presence and "in voice" are the
 * exception: a seed carries them only when its opener knows them live (the
 * member list, the voice room), which beats the API's snapshot — but when
 * the API withholds presence (a block), so does the card. Your own card
 * shows the status you picked.
 */
export function mergeProfileView(
  seed: ProfileSeed,
  data: MemberProfileResponse | null,
  selfStatus?: PresenceStatus | null
): MergedProfile {
  const p = data?.profile ?? null;
  const presence = selfStatus
    ? selfStatus
    : p && p.presence === null
      ? null
      : (seed.presence ?? p?.presence ?? null);
  return {
    userId: seed.userId,
    displayName: p?.displayName ?? seed.displayName,
    globalDisplayName: p ? p.globalDisplayName : (seed.globalDisplayName ?? null),
    nickname: p ? p.nickname : (seed.nickname ?? null),
    avatarUrl: p ? p.avatarUrl : (seed.avatarUrl ?? null),
    bannerUrl: p ? p.bannerUrl : (seed.bannerUrl ?? null),
    isGuest: p?.isGuest ?? seed.isGuest ?? false,
    statusText: p ? p.statusText : (seed.statusText ?? null),
    bio: p ? p.bio : (seed.bio ?? null),
    presence,
    inVoice: p && p.presence === null ? false : (seed.inVoice ?? p?.inVoice ?? false),
    roles: p ? p.roles : (seed.roles ?? []).filter((role) => role.name !== EVERYONE),
    limited: p?.limited ?? false,
    isOwner: p?.isOwner ?? false,
    loaded: p !== null,
  };
}

export function profileCacheKey(serverId: string, userId: string): string {
  return `${serverId}:${userId}`;
}

/** How long a cached answer is shown without asking again in the background. */
export const PROFILE_FRESH_MS = 30_000;

interface CacheEntry {
  data: MemberProfileResponse;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MemberProfileResponse | null>>();
/**
 * Whose answers the cache holds. Every answer is projected for ONE viewer,
 * and signing out and in again is a client-side navigation that keeps this
 * module: a different viewer empties the cache instead of reading the last
 * account's projection.
 */
let cacheViewer: string | null | undefined;

function scopeToViewer(viewerId: string | null | undefined): void {
  if (viewerId === undefined) return;
  if (cacheViewer !== viewerId) {
    cache.clear();
    inFlight.clear();
    cacheViewer = viewerId;
  }
}

/** The cached answer for (server, user), if this session has one for this viewer. */
export function readCachedMemberProfile(serverId: string, userId: string, viewerId?: string | null): MemberProfileResponse | null {
  scopeToViewer(viewerId);
  return cache.get(profileCacheKey(serverId, userId))?.data ?? null;
}

/** The cached answer is younger than `maxAgeMs` (no background refetch needed). */
export function isMemberProfileFresh(serverId: string, userId: string, maxAgeMs: number = PROFILE_FRESH_MS): boolean {
  const entry = cache.get(profileCacheKey(serverId, userId));
  return entry !== undefined && Date.now() - entry.fetchedAt < maxAgeMs;
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
  options: { force?: boolean; fetcher?: typeof fetch; viewerId?: string | null } = {}
): Promise<MemberProfileResponse | null> {
  scopeToViewer(options.viewerId);
  const key = profileCacheKey(serverId, userId);
  if (!options.force) {
    const hit = cache.get(key);
    if (hit) return Promise.resolve(hit.data);
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
      const body = (await res.json().catch(() => null)) as MemberProfileResponse | null;
      // Anything but the route's shape is no answer (and is not cached).
      if (!body || typeof body.profile !== 'object' || !body.profile || typeof body.viewerCan !== 'object' || !body.viewerCan) {
        throw new MemberProfileError(res.status);
      }
      cache.set(key, { data: body, fetchedAt: Date.now() });
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
  cacheViewer = undefined;
}
