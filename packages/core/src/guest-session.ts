/**
 * Guest session primitives.
 *
 * A guest is an unauthenticated visitor who can speak in voice rooms and play
 * activities. We give them a stable, opaque identity for the lifetime of the
 * session cookie; nothing in the DB is created until Phase 2 (when the
 * `users` table gets a `isGuest = true` row plus a `user_sessions` row).
 *
 * Wire format:
 *   {
 *     gid:     'g_<32-hex>',   // stable per session, used as LiveKit identity
 *     uid:     '<uuid>' | null,// users.id once the auth flow has materialized
 *                              //  the row (Phase 2 / M10). null for pre-M10 cookies.
 *     name:    'Guest 4f2c',   // display name, regenerable client-side
 *     iat:     1718049600,     // issued at (seconds) — this cookie
 *     exp:     1718053200,     // expires at (seconds)
 *     auth_time: 1717444800    // when the SESSION was first issued (seconds)
 *   }
 *
 * The TTL is 7 days and slides: every API request and page load re-signs a
 * cookie whose remaining lifetime has dropped below half the TTL
 * (`guestSessionNeedsRefresh`; the web app does it in `withApiSecurity` and
 * the request proxy). Until 2026-10-13 the TTL was 1 hour and nothing
 * refreshed a still-valid cookie, so a signed-in user was signed out after
 * an hour. Revocation (sign out everywhere, password change) is checked
 * server-side on every request, so a long cookie does not outlive it.
 *
 * Absolute lifetime (security follow-up 2026-10): a refresh re-signs the
 * cookie with a fresh `iat`/`exp` but copies `auth_time` unchanged, and
 * `exp` is never set past `auth_time + maxAgeSeconds`. A stolen session can
 * therefore be kept alive by refreshing only until that absolute limit —
 * and every reader that checks `exp` (the ws-gateway included) enforces it
 * without knowing the configured limit. Cookies minted before the field
 * existed have no `auth_time`; their clock starts at their next refresh.
 */
import {
  signSessionCookie,
  verifySessionCookie,
  readCookie,
  type SignOptions,
  type SignResult,
} from './cookies.js';
import { randomBytes } from 'node:crypto';

export const GUEST_COOKIE_NAME = 'lf_guest';
/** How long a cookie stays valid without a request: 7 days (sliding). */
export const GUEST_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Default absolute session lifetime: 30 days from `auth_time`. */
export const GUEST_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface GuestPayload {
  gid: string;
  /** UUID of the materialized users row. null for pre-M10 cookies. */
  uid: string | null;
  name: string;
  iat: number;
  exp: number;
  /**
   * When the session was first issued (seconds) — sign-in or guest
   * creation. Carried unchanged across refreshes. Absent on cookies minted
   * before the absolute lifetime existed.
   */
  auth_time?: number;
}

export interface GuestIdentity {
  gid: string;
  uid: string | null;
  name: string;
}

const MAX_GUEST_NAME_LENGTH = 32;

/**
 * Generate a new guest identity. `displayNameSeed` is appended to "Guest "
 * to make the name human-readable. The caller picks a stable per-device
 * seed (e.g. localStorage value) so the name is reproducible across reloads
 * of the same browser.
 */
export function createGuestIdentity(displayNameSeed?: string): GuestIdentity {
  const gid = `g_${randomBytes(16).toString('hex')}`;

  const seed = sanitizeNameSeed(displayNameSeed);
  const name = seed ? `Guest ${seed}` : `Guest ${gid.slice(2, 6)}`;
  return { gid, uid: null, name };
}

function sanitizeNameSeed(seed: string | undefined): string {
  if (!seed) return '';
  const cleaned = seed.replace(/[^A-Za-z0-9_\- ]/g, '').trim();
  if (!cleaned) return '';
  return cleaned.slice(0, MAX_GUEST_NAME_LENGTH - 'Guest '.length);
}

export interface GuestSessionCookieOptions {
  now?: number;
  ttlSeconds?: number;
  secure?: boolean;
  /**
   * `auth_time` of the session being refreshed. Omit for a new session
   * (and for a legacy cookie without one): the clock starts now.
   */
  authTime?: number;
  /** Absolute lifetime from `authTime`. Defaults to 30 days. */
  maxAgeSeconds?: number;
}

/**
 * Does this valid session's cookie deserve a fresh one? When less than half
 * of the TTL is left — and only if re-signing would actually move `exp`
 * (a session at its absolute lifetime cannot be extended).
 */
export function guestSessionNeedsRefresh(
  payload: Pick<GuestPayload, 'exp' | 'auth_time'>,
  options: { now?: number; ttlSeconds?: number; maxAgeSeconds?: number } = {}
): boolean {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? GUEST_SESSION_TTL_SECONDS;
  if (payload.exp - now >= ttl / 2) return false;
  const maxAge = options.maxAgeSeconds ?? GUEST_SESSION_MAX_AGE_SECONDS;
  const authTime = payload.auth_time ?? now;
  return Math.min(now + ttl, authTime + maxAge) > payload.exp;
}

/**
 * Wrap a guest identity in the cookie payload (with `iat` / `exp` /
 * `auth_time`) and sign it. `exp` is capped at `auth_time + maxAgeSeconds`,
 * so a refresh can never carry a session past its absolute lifetime.
 */
export function buildGuestSessionCookie(
  identity: GuestIdentity,
  secret: string,
  options: GuestSessionCookieOptions = {}
): SignResult & { payload: GuestPayload } {
  const ttl = options.ttlSeconds ?? GUEST_SESSION_TTL_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const authTime = options.authTime ?? now;
  const maxAge = options.maxAgeSeconds ?? GUEST_SESSION_MAX_AGE_SECONDS;
  const exp = Math.min(now + ttl, authTime + maxAge);
  const payload: GuestPayload = {
    gid: identity.gid,
    uid: identity.uid,
    name: identity.name,
    iat: now,
    exp,
    auth_time: authTime,
  };
  const signOptions: SignOptions = {
    name: GUEST_COOKIE_NAME,
    secret,
    maxAgeSeconds: Math.max(0, exp - now),
    httpOnly: true,
    sameSite: 'Lax',
    secure: options.secure,
    path: '/',
  };
  return {
    ...signSessionCookie(payload as unknown as Record<string, unknown>, signOptions),
    payload,
  };
}

/**
 * True when the session is older than `maxAgeSeconds` (measured from
 * `auth_time`). A legacy cookie without `auth_time` is never over age —
 * its own `exp` (at most one TTL away) bounds it until the next refresh
 * stamps the field.
 */
export function isGuestSessionOverAge(
  payload: Pick<GuestPayload, 'auth_time'>,
  maxAgeSeconds: number,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  if (typeof payload.auth_time !== 'number') return false;
  // Same boundary as `exp` in verifySessionCookie (valid while exp >= now).
  return now > payload.auth_time + maxAgeSeconds;
}

/**
 * Read + verify the guest session from a `Cookie` header. With
 * `maxAgeSeconds`, a session older than that (from `auth_time`) reads as
 * absent too.
 */
export function readGuestSession(
  cookieHeader: string | null,
  secret: string,
  options: { now?: number; clockSkewSeconds?: number; maxAgeSeconds?: number } = {}
): GuestPayload | null {
  const raw = readCookie(cookieHeader, GUEST_COOKIE_NAME);
  if (!raw) return null;
  const payload = verifySessionCookie(raw, {
    secret,
    now: options.now,
    clockSkewSeconds: options.clockSkewSeconds,
  });
  if (!payload) return null;
  const session = parseGuestPayload(payload);
  if (!session) return null;
  if (options.maxAgeSeconds !== undefined && isGuestSessionOverAge(session, options.maxAgeSeconds, options.now)) {
    return null;
  }
  return session;
}

function parseGuestPayload(payload: Record<string, unknown>): GuestPayload | null {
  if (
    typeof payload.gid === 'string' &&
    typeof payload.name === 'string' &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number'
  ) {
    if (!payload.gid.startsWith('g_')) return null;
    if (payload.gid.length !== 34) return null;
    const uid = typeof payload.uid === 'string' ? payload.uid : null;
    const session: GuestPayload = { gid: payload.gid, uid, name: payload.name, iat: payload.iat, exp: payload.exp };
    if (typeof payload.auth_time === 'number' && Number.isFinite(payload.auth_time)) {
      session.auth_time = payload.auth_time;
    }
    return session;
  }
  return null;
}
