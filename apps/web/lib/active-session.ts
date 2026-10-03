/**
 * The session cookie, read the way server-rendered pages must read it.
 *
 * security-review AUTH-002: revocation (`isSessionRevoked`) used to be
 * enforced only at the API boundary (`withApiSecurity`), the ws-gateway
 * and the SSE stream. Pages and layouts read the cookie with plain
 * `readGuestSession`, so a stolen-then-revoked cookie kept rendering the
 * lobby (channels, members, recent messages) and, for the owner, the
 * admin pages until it expired. Server components read the session
 * through here instead.
 *
 * Mirrors `revokedSessionResponse` in security-headers: a session with a
 * `uid` is checked against the revocation set; when that check itself
 * fails, production fails closed (signed out) and dev/test fail open.
 * Guest cookies without a `uid` are never tracked and pass unchanged.
 */
import { readGuestSession, type GuestPayload } from '@/lib/guest-session';
import { isSessionRevoked } from '@/lib/session-tracker';

/** Whether an already-verified session is still live (not revoked). */
export async function isSessionActive(session: GuestPayload): Promise<boolean> {
  if (!session.uid) return true;
  try {
    return !(await isSessionRevoked(session.uid, session.gid));
  } catch (error) {
    console.error('[session] revocation check unavailable', (error as Error).message);
    return process.env.NODE_ENV !== 'production';
  }
}

/** `readGuestSession` plus the revocation check: null when absent, invalid or revoked. */
export async function getActiveSession(
  cookieHeader: string | null,
  secret: string
): Promise<GuestPayload | null> {
  const session = readGuestSession(cookieHeader, secret);
  if (!session) return null;
  return (await isSessionActive(session)) ? session : null;
}
