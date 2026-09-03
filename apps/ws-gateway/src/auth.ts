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

/**
 * SEC-003: a revoked session must not keep an OPEN WebSocket. The web
 * app's revocation set lives in Redis under
 * `lf:{env}:session-revoked:{userId}` (member = gid) — check it at the
 * handshake (and periodically on live sockets) so "log out everywhere"
 * disconnects gateway subscribers too, not just REST callers.
 */
export async function isGuestSessionRevoked(uid: string, gid: string): Promise<boolean> {
  // Lazy import keeps unit tests Redis-free; production always has it.
  try {
    const RedisMod = await import('ioredis');
    const Redis = ('default' in RedisMod ? RedisMod.default : RedisMod) as unknown as new (url: string) => { sismember: (key: string, member: string) => Promise<number>; disconnect: () => void };
    const key = `lf:${process.env.NODE_ENV || 'dev'}:session-revoked:${uid}`;
    const client = new Redis(process.env.REDIS_URL || 'redis://:lobbyforge_dev@localhost:6379');
    try {
      const member = await client.sismember(key, gid);
      return member === 1;
    } finally {
      client.disconnect();
    }
  } catch {
    // Redis unavailable: fail OPEN on the realtime path (the REST layer
    // is the strict fail-closed gate); the handshake HMAC still applies.
    return false;
  }
}