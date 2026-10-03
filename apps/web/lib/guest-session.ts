/**
 * The web app's view of the @lobbyforge/core guest-session helpers. The
 * canonical code lives in `@lobbyforge/core` so the ws-gateway can share it
 * without depending on `apps/web`.
 *
 * `buildGuestSessionCookie` and `readGuestSession` are wrapped to apply the
 * configured absolute session lifetime (`lib/session-lifetime.ts`): new and
 * refreshed cookies never expire past `auth_time + max age`, and an
 * over-age session reads as absent everywhere in the app — API routes
 * (`withApiSecurity`, `requireMaterializedSession`), pages
 * (`getActiveSession`) and the refresh route alike.
 */
import {
  buildGuestSessionCookie as buildCoreGuestSessionCookie,
  readGuestSession as readCoreGuestSession,
  type GuestIdentity,
  type GuestPayload,
  type GuestSessionCookieOptions,
} from '@lobbyforge/core';
import { sessionMaxAgeSeconds } from '@/lib/session-lifetime';

export {
  GUEST_COOKIE_NAME,
  GUEST_SESSION_TTL_SECONDS,
  createGuestIdentity,
  isGuestSessionOverAge,
  type GuestPayload,
  type GuestIdentity,
  type GuestSessionCookieOptions,
} from '@lobbyforge/core';

export function buildGuestSessionCookie(
  identity: GuestIdentity,
  secret: string,
  options: GuestSessionCookieOptions = {}
): ReturnType<typeof buildCoreGuestSessionCookie> {
  return buildCoreGuestSessionCookie(identity, secret, {
    ...options,
    maxAgeSeconds: options.maxAgeSeconds ?? sessionMaxAgeSeconds(),
  });
}

export function readGuestSession(
  cookieHeader: string | null,
  secret: string,
  options: { now?: number; clockSkewSeconds?: number; maxAgeSeconds?: number } = {}
): GuestPayload | null {
  return readCoreGuestSession(cookieHeader, secret, {
    ...options,
    maxAgeSeconds: options.maxAgeSeconds ?? sessionMaxAgeSeconds(),
  });
}
