/**
 * Guest-session validation for the WS upgrade handshake.
 *
 * The browser sends the `lf_guest` cookie in the `Cookie` header on the
 * HTTP upgrade request. We validate it the same way the Next.js routes
 * do (`@lobbyforge/core`'s `readGuestSession`) — the cookie's HMAC must
 * verify and the payload's `uid` must be present (the user record has
 * been materialized via `POST /api/auth/guest`).
 *
 * On any failure we return `{ ok: false }` so the server can close the
 * socket with the appropriate WS close code without leaking the
 * underlying reason to the client.
 */
import { readGuestSession } from '@lobbyforge/core';

export interface ResolvedGuest {
  uid: string;
  gid: string;
  name: string;
}

export type AuthResult =
  | { ok: true; guest: ResolvedGuest }
  | { ok: false; reason: 'no_cookie' | 'no_uid' | 'bad_secret' };

function getSessionSecret(): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOBBYFORGE_SESSION_SECRET must be set to at least 32 characters');
  }
  return secret;
}

/**
 * Validate the cookie sent on the WS upgrade request. The cookie header
 * is read from `req.headers.cookie` exactly like Next.js routes do.
 */
export function validateGuestFromHeaders(cookieHeader: string | undefined | null): AuthResult {
  const secret = getSessionSecret();
  const session = readGuestSession(cookieHeader ?? null, secret);
  if (!session) return { ok: false, reason: 'no_cookie' };
  if (!session.uid) return { ok: false, reason: 'no_uid' };
  return {
    ok: true,
    guest: { uid: session.uid, gid: session.gid, name: session.name },
  };
}