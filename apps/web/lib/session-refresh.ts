/**
 * The sliding session (docs/GUEST_AUTH.md "Lifetime").
 *
 * A session cookie is valid for `GUEST_SESSION_TTL_SECONDS` (7 days) and
 * slides: an API request (`withApiSecurity`) or a page load (the request
 * proxy) that carries a valid cookie with less than half of that left gets a
 * re-signed one — same session id (`gid`), same `auth_time`, so revocation,
 * the active-sessions list and the absolute lifetime all keep working.
 *
 * Until 2026-10-13 the cookie lived one hour and nothing re-signed a cookie
 * that was still valid (`POST /api/auth/guest` was only called once the
 * cookie was gone), so a signed-in user was signed out after an hour and a
 * guest lost their identity.
 *
 * A refresh never resurrects anything: the cookie must still verify, must not
 * be past its absolute lifetime (`readGuestSession`), and in the API path the
 * request has already passed the revocation check. The proxy does not ask
 * Redis on every page load; refreshing a revoked session there is harmless,
 * because the revocation entry outlives the cookie's absolute lifetime and
 * every reader checks it.
 */
import { GUEST_COOKIE_NAME, guestSessionNeedsRefresh, requireSessionSecret } from '@lobbyforge/core';
import { buildGuestSessionCookie, readGuestSession } from './guest-session';
import { sessionMaxAgeSeconds } from './session-lifetime';

/** A `Set-Cookie` value re-signing the request's session when it is due, else null. */
export function refreshedSessionCookie(cookieHeader: string | null, now?: number): string | null {
  if (!cookieHeader || !cookieHeader.includes(`${GUEST_COOKIE_NAME}=`)) return null;
  // From core (not api-auth, which pulls the database into the request
  // proxy's bundle): the same rule as getSessionSecret, placeholders refused.
  let secret: string;
  try {
    secret = requireSessionSecret();
  } catch {
    return null;
  }
  const session = readGuestSession(cookieHeader, secret, now === undefined ? {} : { now });
  if (!session) return null;
  const maxAgeSeconds = sessionMaxAgeSeconds();
  if (!guestSessionNeedsRefresh(session, { now, maxAgeSeconds })) return null;
  return buildGuestSessionCookie({ gid: session.gid, uid: session.uid, name: session.name }, secret, {
    now,
    authTime: session.auth_time,
    maxAgeSeconds,
    secure: process.env.NODE_ENV === 'production',
  }).setCookieHeader;
}

/** The response sets or clears the session cookie itself (sign-in, sign-out, refresh): leave it alone. */
export function setsSessionCookie(headers: Headers): boolean {
  const prefix = `${GUEST_COOKIE_NAME}=`;
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
  return values.some((value) => value.trimStart().startsWith(prefix));
}

/**
 * Append the refreshed cookie to `response` when the request's session is
 * due and the response does not handle the cookie itself. Only on answers
 * below 400: a refused request gets nothing new.
 */
export function withRefreshedSession<T extends { status: number; headers: Headers }>(req: Request, response: T): T {
  if (response.status >= 400 || setsSessionCookie(response.headers)) return response;
  const cookie = refreshedSessionCookie(req.headers.get('cookie'));
  if (cookie) response.headers.append('Set-Cookie', cookie);
  return response;
}
