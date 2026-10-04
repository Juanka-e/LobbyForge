import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security follow-up: device cookies for the sign-in limit (OWASP "Slow
 * Down Online Guessing Attacks with Device Cookies"), each entry bound to
 * the password hash it was issued under.
 */

import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  DEVICE_COOKIE_MAX_SUBJECTS,
  DEVICE_COOKIE_NAME,
  buildDeviceCookie,
  deviceClaimHolds,
  readDeviceClaim,
} from '../device-cookie.js';
import { signSessionCookie } from '../cookies.js';
import { buildGuestSessionCookie } from '../guest-session.js';

const SECRET = 'k'.repeat(48);
const NOW = 1_790_000_000;
const DAY = 24 * 60 * 60;
const HASH = 'scrypt$16384$8$1$c2FsdA==$b2xk';
const NEW_HASH = 'scrypt$16384$8$1$bmV3c2FsdA==$bmV3';

type Entry = { sub: string; cred: string; nonce: string; iat: number };

/** `name=value` of a Set-Cookie header — what the browser sends back. */
function pair(setCookie: string | null): string {
  if (!setCookie) throw new Error('expected a Set-Cookie header');
  return setCookie.split(';', 1)[0];
}

function decodePayload(setCookie: string): { v: number; subjects: Entry[] } {
  const raw = pair(setCookie).slice(`${DEVICE_COOKIE_NAME}=`.length);
  return JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString('utf8'));
}

/** A cookie built from a payload with the same shape, MAC'd with `key`. */
function forged(payload: Record<string, unknown>, key: string): string {
  return signSessionCookie(payload, { name: DEVICE_COOKIE_NAME, secret: key, maxAgeSeconds: 60 }).setCookieHeader;
}

/** The nonce of the claim for `email`, or null. */
function nonceOf(cookieHeader: string | null, email: string, now?: number): string | null {
  return readDeviceClaim(cookieHeader, email, now === undefined ? {} : { now })?.nonce ?? null;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildDeviceCookie', () => {
  it('sets lf_device HttpOnly, SameSite=Lax, Path=/, 180 days; Secure only in production', () => {
    expect(DEVICE_COOKIE_MAX_AGE_SECONDS).toBe(180 * DAY);
    const dev = buildDeviceCookie(null, 'owner@example.com', HASH)!;
    expect(dev.startsWith('lf_device=')).toBe(true);
    const flags = dev.split('; ').slice(1);
    expect(flags).toEqual(['Path=/', `Max-Age=${180 * DAY}`, 'HttpOnly', 'SameSite=Lax']);

    vi.stubEnv('NODE_ENV', 'production');
    expect(buildDeviceCookie(null, 'owner@example.com', HASH)!.split('; ')).toContain('Secure');
  });

  it('holds { v:2, subjects:[{ sub, cred, nonce, iat }] } and never the email or the password hash', () => {
    const header = buildDeviceCookie(null, 'Owner@Example.com', HASH, { now: NOW })!;
    const payload = decodePayload(header);
    expect(payload.v).toBe(2);
    expect(payload.subjects).toHaveLength(1);
    const [entry] = payload.subjects;
    expect(Object.keys(entry).sort()).toEqual(['cred', 'iat', 'nonce', 'sub']);
    expect(entry.iat).toBe(NOW);
    expect(entry.sub).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(entry.cred).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(entry.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(entry.cred).not.toBe(entry.sub);
    const decoded = JSON.stringify(payload);
    expect(header.toLowerCase()).not.toContain('owner');
    expect(decoded).not.toContain('scrypt');
    expect(decoded).not.toContain('c2FsdA');
    // Keyed with keys derived from the session secret: another secret gives another sub and cred.
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'z'.repeat(48));
    const other = decodePayload(buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW })!).subjects[0];
    expect(other.sub).not.toBe(entry.sub);
    expect(other.cred).not.toBe(entry.cred);
  });

  it('the same account under another password hash gets the same sub but another cred', () => {
    const before = decodePayload(buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW })!).subjects[0];
    const after = decodePayload(buildDeviceCookie(null, 'owner@example.com', NEW_HASH, { now: NOW })!).subjects[0];
    expect(after.sub).toBe(before.sub);
    expect(after.cred).not.toBe(before.cred);
  });

  it('is null (no device trust) without a usable session secret or without a password hash', () => {
    expect(buildDeviceCookie(null, 'owner@example.com', '')).toBeNull();
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'short');
    expect(buildDeviceCookie(null, 'owner@example.com', HASH)).toBeNull();
  });

  it('keeps up to 5 accounts, newest first, and drops the oldest past that', () => {
    expect(DEVICE_COOKIE_MAX_SUBJECTS).toBe(5);
    let cookie: string | null = null;
    for (let i = 1; i <= 6; i += 1) {
      cookie = pair(buildDeviceCookie(cookie, `user${i}@example.com`, `${HASH}${i}`, { now: NOW + i }));
    }
    expect(decodePayload(cookie!).subjects).toHaveLength(5);
    // Five full entries stay well inside the length the reader accepts.
    expect(cookie!.length).toBeLessThan(1400);
    expect(readDeviceClaim(cookie, 'user1@example.com', { now: NOW + 10 })).toBeNull();
    for (let i = 2; i <= 6; i += 1) {
      const claim = readDeviceClaim(cookie, `user${i}@example.com`, { now: NOW + 10 });
      expect(claim).not.toBeNull();
      expect(deviceClaimHolds(claim, `user${i}@example.com`, `${HASH}${i}`)).toBe(true);
    }
  });

  it('signing in again moves the account first with a fresh nonce and iat, without duplicates', () => {
    const first = pair(buildDeviceCookie(null, 'a@example.com', HASH, { now: NOW }));
    const both = pair(buildDeviceCookie(first, 'b@example.com', HASH, { now: NOW + 1 }));
    const oldNonce = nonceOf(both, 'a@example.com', NOW + 2);
    const again = pair(buildDeviceCookie(both, 'A@Example.com', HASH, { now: NOW + 2 }));
    const subjects = decodePayload(again).subjects;
    expect(subjects).toHaveLength(2);
    expect(subjects[0].iat).toBe(NOW + 2);
    const newNonce = nonceOf(again, 'a@example.com', NOW + 3);
    expect(newNonce).not.toBeNull();
    expect(newNonce).not.toBe(oldNonce);
    expect(nonceOf(again, 'b@example.com', NOW + 3)).not.toBeNull();
  });

  it('a sign-in after a password change replaces the stale entry (one entry, bound to the new hash)', () => {
    const stale = pair(buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW }));
    const withOther = pair(buildDeviceCookie(stale, 'other@example.com', HASH, { now: NOW + 1 }));
    expect(deviceClaimHolds(readDeviceClaim(withOther, 'owner@example.com', { now: NOW + 2 }), 'owner@example.com', NEW_HASH)).toBe(false);

    const fresh = pair(buildDeviceCookie(withOther, 'owner@example.com', NEW_HASH, { now: NOW + 2 }));
    expect(decodePayload(fresh).subjects).toHaveLength(2);
    const claim = readDeviceClaim(fresh, 'owner@example.com', { now: NOW + 3 });
    expect(deviceClaimHolds(claim, 'owner@example.com', NEW_HASH)).toBe(true);
    expect(deviceClaimHolds(claim, 'owner@example.com', HASH)).toBe(false);
    // The other account's entry is untouched.
    expect(deviceClaimHolds(readDeviceClaim(fresh, 'other@example.com', { now: NOW + 3 }), 'other@example.com', HASH)).toBe(true);
  });

  it('starts afresh when the existing cookie is forged', () => {
    const fake = pair(forged({ v: 2, subjects: [] }, 'f'.repeat(64)));
    const header = buildDeviceCookie(fake, 'owner@example.com', HASH, { now: NOW })!;
    expect(decodePayload(header).subjects).toHaveLength(1);
  });
});

describe('readDeviceClaim', () => {
  it('returns the nonce and binding for the account the cookie was issued to (email normalised)', () => {
    const header = buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW })!;
    const entry = decodePayload(header).subjects[0];
    expect(readDeviceClaim(pair(header), ' OWNER@example.com ', { now: NOW + 60 })).toEqual({
      nonce: entry.nonce,
      cred: entry.cred,
    });
    // Among other cookies in the header too.
    expect(nonceOf(`theme=dark; ${pair(header)}; x=1`, 'owner@example.com', NOW)).toBe(entry.nonce);
  });

  it('is null for no cookie, or a cookie issued to another account', () => {
    const header = pair(buildDeviceCookie(null, 'someone-else@example.com', HASH, { now: NOW }));
    expect(readDeviceClaim(null, 'owner@example.com')).toBeNull();
    expect(readDeviceClaim('theme=dark', 'owner@example.com')).toBeNull();
    expect(readDeviceClaim(header, 'owner@example.com', { now: NOW })).toBeNull();
  });

  it('is null for an expired entry (180 days from its own iat) or one from the future', () => {
    const header = pair(buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW }));
    expect(nonceOf(header, 'owner@example.com', NOW + 180 * DAY)).not.toBeNull();
    expect(nonceOf(header, 'owner@example.com', NOW + 180 * DAY + 1)).toBeNull();
    expect(nonceOf(header, 'owner@example.com', NOW - 3600)).toBeNull();
  });

  it('an expired entry does not take a newer one down with it', () => {
    const old = pair(buildDeviceCookie(null, 'old@example.com', HASH, { now: NOW }));
    const both = pair(buildDeviceCookie(old, 'new@example.com', HASH, { now: NOW + 100 * DAY }));
    const later = NOW + 181 * DAY;
    expect(nonceOf(both, 'old@example.com', later)).toBeNull();
    expect(nonceOf(both, 'new@example.com', later)).not.toBeNull();
    // ...and re-issuing drops it.
    const reissued = buildDeviceCookie(both, 'new@example.com', HASH, { now: later })!;
    expect(decodePayload(reissued).subjects).toHaveLength(1);
  });

  it('refuses a tampered payload (the MAC covers it)', () => {
    const victim = decodePayload(buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW })!).subjects[0];
    const attacker = pair(buildDeviceCookie(null, 'attacker@example.com', HASH, { now: NOW }));
    const [, mac] = attacker.slice(`${DEVICE_COOKIE_NAME}=`.length).split('.');
    const body = Buffer.from(JSON.stringify({ v: 2, subjects: [victim] })).toString('base64url');
    expect(readDeviceClaim(`${DEVICE_COOKIE_NAME}=${body}.${mac}`, 'owner@example.com', { now: NOW })).toBeNull();
  });

  it('refuses a cookie MAC’d with the raw session secret, another derivation, or another secret', () => {
    const victim = decodePayload(buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW })!).subjects[0];
    const payload = { v: 2, subjects: [victim] };
    const otherLabel = createHmac('sha256', SECRET).update('lobbyforge:auth-throttle:v1').digest('hex');
    for (const key of [SECRET, otherLabel, 'z'.repeat(48)]) {
      expect(readDeviceClaim(pair(forged(payload, key)), 'owner@example.com', { now: NOW })).toBeNull();
    }
  });

  it('a session cookie value is not a device cookie', () => {
    const session = buildGuestSessionCookie({ gid: `g_${'a'.repeat(32)}`, uid: 'u-1', name: 'Owner' }, SECRET);
    expect(readDeviceClaim(`${DEVICE_COOKIE_NAME}=${session.raw}`, 'owner@example.com')).toBeNull();
  });

  it('refuses a wrong version (v1 entries carry no binding), malformed entries, garbage and oversized values', () => {
    const header = buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW })!;
    const entry = decodePayload(header).subjects[0];
    const macKey = createHmac('sha256', SECRET).update('lobbyforge:device-cookie:mac:v1').digest('hex');
    // Sanity: a correctly derived key with the right payload IS accepted...
    expect(nonceOf(pair(forged({ v: 2, subjects: [entry] }, macKey)), 'owner@example.com', NOW)).toBe(entry.nonce);
    // ...and anything malformed under that same key is not.
    const { cred: _cred, ...withoutCred } = entry;
    for (const payload of [
      { v: 1, subjects: [entry] },
      { v: 1, subjects: [withoutCred] },
      { v: 2, subjects: [withoutCred] },
      { v: 3, subjects: [entry] },
      { v: 2, subjects: entry },
      { v: 2, subjects: [{ ...entry, nonce: 'short' }] },
      { v: 2, subjects: [{ ...entry, cred: 'short' }] },
      { v: 2, subjects: [{ ...entry, cred: 42 }] },
      { v: 2, subjects: [{ ...entry, iat: String(NOW) }] },
      { v: 2, subjects: [{ ...entry, sub: `${entry.sub}x` }] },
    ]) {
      expect(readDeviceClaim(pair(forged(payload, macKey)), 'owner@example.com', { now: NOW })).toBeNull();
    }
    for (const value of ['', 'garbage', '.', 'a.b', `${'a'.repeat(3000)}.${'b'.repeat(43)}`]) {
      expect(readDeviceClaim(`${DEVICE_COOKIE_NAME}=${value}`, 'owner@example.com', { now: NOW })).toBeNull();
    }
  });

  it('is null without a usable session secret', () => {
    const header = pair(buildDeviceCookie(null, 'owner@example.com', HASH, { now: NOW }));
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', '');
    expect(readDeviceClaim(header, 'owner@example.com', { now: NOW })).toBeNull();
  });
});

describe('deviceClaimHolds — the credential binding', () => {
  const claimFor = (hash: string, email = 'owner@example.com') =>
    readDeviceClaim(pair(buildDeviceCookie(null, email, hash, { now: NOW })), email, { now: NOW });

  it('holds while the account still has the password hash the entry was issued under', () => {
    expect(deviceClaimHolds(claimFor(HASH), 'owner@example.com', HASH)).toBe(true);
    expect(deviceClaimHolds(claimFor(HASH), ' Owner@Example.com ', HASH)).toBe(true);
  });

  it('no longer holds once the password changed', () => {
    expect(deviceClaimHolds(claimFor(HASH), 'owner@example.com', NEW_HASH)).toBe(false);
  });

  it('never holds without a usable password hash (unknown email, deleted account, no password)', () => {
    const claim = claimFor(HASH);
    for (const hash of [null, undefined, '']) {
      expect(deviceClaimHolds(claim, 'owner@example.com', hash)).toBe(false);
    }
  });

  it('never holds without a claim — for any hash, known or not', () => {
    expect(deviceClaimHolds(null, 'owner@example.com', HASH)).toBe(false);
    expect(deviceClaimHolds(null, 'nobody@example.com', null)).toBe(false);
  });

  it('a binding is tied to its email: another account with the same hash does not match', () => {
    const claim = claimFor(HASH, 'owner@example.com');
    expect(deviceClaimHolds(claim, 'other@example.com', HASH)).toBe(false);
  });

  it('refuses a malformed or foreign binding without throwing', () => {
    const claim = claimFor(HASH)!;
    expect(deviceClaimHolds({ ...claim, cred: 'x' }, 'owner@example.com', HASH)).toBe(false);
    expect(deviceClaimHolds({ ...claim, cred: claimFor(HASH, 'other@example.com')!.cred }, 'owner@example.com', HASH)).toBe(false);
  });

  it('never holds without a usable session secret', () => {
    const claim = claimFor(HASH);
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', '');
    expect(deviceClaimHolds(claim, 'owner@example.com', HASH)).toBe(false);
  });
});
