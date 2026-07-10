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
 *     iat:     1718049600,     // issued at (seconds)
 *     exp:     1718053200      // expires at (seconds)
 *   }
 *
 * The TTL defaults to 1 hour, matching the LiveKit access token TTL so the
 * two systems age out together.
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
export const GUEST_SESSION_TTL_SECONDS = 60 * 60; // 1 hour

export interface GuestPayload {
  gid: string;
  /** UUID of the materialized users row. null for pre-M10 cookies. */
  uid: string | null;
  name: string;
  iat: number;
  exp: number;
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

/**
 * Wrap a guest identity in the cookie payload (with `iat` / `exp`) and sign it.
 */
export function buildGuestSessionCookie(
  identity: GuestIdentity,
  secret: string,
  options: { now?: number; ttlSeconds?: number; secure?: boolean } = {}
): SignResult {
  const ttl = options.ttlSeconds ?? GUEST_SESSION_TTL_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const payload: GuestPayload = {
    gid: identity.gid,
    uid: identity.uid,
    name: identity.name,
    iat: now,
    exp: now + ttl,
  };
  const signOptions: SignOptions = {
    name: GUEST_COOKIE_NAME,
    secret,
    maxAgeSeconds: ttl,
    httpOnly: true,
    sameSite: 'Lax',
    secure: options.secure,
    path: '/',
  };
  return signSessionCookie(payload as unknown as Record<string, unknown>, signOptions);
}

/**
 * Read + verify the guest session from a `Cookie` header.
 */
export function readGuestSession(
  cookieHeader: string | null,
  secret: string,
  options: { now?: number; clockSkewSeconds?: number } = {}
): GuestPayload | null {
  const raw = readCookie(cookieHeader, GUEST_COOKIE_NAME);
  if (!raw) return null;
  const payload = verifySessionCookie(raw, {
    secret,
    now: options.now,
    clockSkewSeconds: options.clockSkewSeconds,
  });
  if (!payload) return null;
  return parseGuestPayload(payload);
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
    return { gid: payload.gid, uid, name: payload.name, iat: payload.iat, exp: payload.exp };
  }
  return null;
}
