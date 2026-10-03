import { describe, expect, it } from 'vitest';
import {
  GUEST_SESSION_MAX_AGE_SECONDS,
  GUEST_SESSION_TTL_SECONDS,
  buildGuestSessionCookie,
  isGuestSessionOverAge,
  readGuestSession,
} from '../guest-session.js';
import { signSessionCookie } from '../cookies.js';

/**
 * Security follow-up (absolute session lifetime): a refresh copies the
 * session's `auth_time` and never signs an `exp` past auth_time + max age.
 */

const SECRET = 'x'.repeat(32);
const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;
const IDENTITY = { gid: `g_${'a'.repeat(32)}`, uid: '00000000-0000-0000-0000-000000000001', name: 'Owner' };

function cookieOf(raw: string): string {
  return `lf_guest=${raw}`;
}

describe('buildGuestSessionCookie — auth_time', () => {
  it('stamps a new session with auth_time = now and a normal TTL', () => {
    const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now: NOW });
    expect(signed.payload).toMatchObject({ iat: NOW, exp: NOW + GUEST_SESSION_TTL_SECONDS, auth_time: NOW });
    expect(signed.setCookieHeader).toContain(`Max-Age=${GUEST_SESSION_TTL_SECONDS}`);
    expect(readGuestSession(cookieOf(signed.raw), SECRET, { now: NOW })?.auth_time).toBe(NOW);
  });

  it('a refresh keeps the original auth_time', () => {
    const later = NOW + 10 * DAY;
    const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now: later, authTime: NOW });
    expect(signed.payload).toMatchObject({ iat: later, exp: later + GUEST_SESSION_TTL_SECONDS, auth_time: NOW });
  });

  it('never signs an exp past auth_time + the absolute lifetime (default 30 days)', () => {
    expect(GUEST_SESSION_MAX_AGE_SECONDS).toBe(30 * DAY);
    const nearEnd = NOW + 30 * DAY - 600; // ten minutes left
    const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now: nearEnd, authTime: NOW });
    expect(signed.payload.exp).toBe(NOW + 30 * DAY);
    expect(signed.setCookieHeader).toContain('Max-Age=600');
    // Every exp-only reader (the ws-gateway) stops accepting it on time.
    expect(readGuestSession(cookieOf(signed.raw), SECRET, { now: NOW + 30 * DAY + 1 })).toBeNull();
  });

  it('honours a custom absolute lifetime', () => {
    const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now: NOW + 1800, authTime: NOW, maxAgeSeconds: 3600 });
    expect(signed.payload.exp).toBe(NOW + 3600);
  });

  it('a refresh past the limit yields an already-expired cookie (never an extension)', () => {
    const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now: NOW + 31 * DAY, authTime: NOW });
    expect(signed.payload.exp).toBe(NOW + 30 * DAY);
    expect(signed.setCookieHeader).toContain('Max-Age=0');
    expect(readGuestSession(cookieOf(signed.raw), SECRET, { now: NOW + 31 * DAY })).toBeNull();
  });
});

describe('readGuestSession — maxAgeSeconds', () => {
  it('reads a session older than maxAgeSeconds as absent, even with a live exp', () => {
    // Minted under a 90-day limit, read under a 30-day one (the operator lowered it).
    const now = NOW + 40 * DAY;
    const signed = buildGuestSessionCookie(IDENTITY, SECRET, { now, authTime: NOW, maxAgeSeconds: 90 * DAY });
    expect(readGuestSession(cookieOf(signed.raw), SECRET, { now })).not.toBeNull();
    expect(readGuestSession(cookieOf(signed.raw), SECRET, { now, maxAgeSeconds: 30 * DAY })).toBeNull();
    expect(readGuestSession(cookieOf(signed.raw), SECRET, { now, maxAgeSeconds: 60 * DAY })).not.toBeNull();
  });

  it('accepts a legacy cookie without auth_time (its exp bounds it until the next refresh)', () => {
    const legacy = signSessionCookie(
      { gid: IDENTITY.gid, uid: IDENTITY.uid, name: 'Owner', iat: NOW, exp: NOW + 3600 },
      { name: 'lf_guest', secret: SECRET, maxAgeSeconds: 3600 }
    );
    const session = readGuestSession(cookieOf(legacy.raw), SECRET, { now: NOW + 60, maxAgeSeconds: 1 });
    expect(session).not.toBeNull();
    expect(session).not.toHaveProperty('auth_time');
  });

  it('ignores a non-numeric auth_time', () => {
    const odd = signSessionCookie(
      { gid: IDENTITY.gid, uid: null, name: 'Guest', iat: NOW, exp: NOW + 3600, auth_time: 'yesterday' },
      { name: 'lf_guest', secret: SECRET, maxAgeSeconds: 3600 }
    );
    const session = readGuestSession(cookieOf(odd.raw), SECRET, { now: NOW, maxAgeSeconds: 60 });
    expect(session).not.toBeNull();
    expect(session).not.toHaveProperty('auth_time');
  });
});

describe('isGuestSessionOverAge', () => {
  it('uses the same boundary as exp (valid up to and including the last second)', () => {
    expect(isGuestSessionOverAge({ auth_time: NOW }, 100, NOW + 100)).toBe(false);
    expect(isGuestSessionOverAge({ auth_time: NOW }, 100, NOW + 101)).toBe(true);
    expect(isGuestSessionOverAge({}, 100, NOW + 10_000)).toBe(false);
  });
});
