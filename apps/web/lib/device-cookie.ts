/**
 * Device cookies for the sign-in limit (security follow-up 2026-10; OWASP
 * "Slow Down Online Guessing Attacks with Device Cookies").
 *
 * The per-account sign-in limit (`lib/auth-throttle.ts`) let anyone who
 * knows an address keep that account locked in 15-minute stretches. A
 * browser that has signed in to an account before now carries proof of it:
 * the `lf_device` cookie. Its attempts for THAT account are counted in a
 * bucket of their own (keyed by the account and the cookie's nonce) and are
 * not refused by the account-wide lock, so a lockout aimed at an address no
 * longer locks its owner out of the devices they already use.
 *
 * Design: ONE cookie holding up to `DEVICE_COOKIE_MAX_SUBJECTS` accounts
 * (a shared computer), newest first, under one MAC. One cookie per account
 * would need a cookie name per account; a browser holds a bounded number
 * of cookies per site and evicts the oldest past it — which could be the
 * session cookie — and every one of them rides on every request. One
 * bounded cookie cannot crowd anything out, and re-signing it is one
 * operation.
 *
 * Payload (`<base64url(json)>.<base64url(mac)>`, the `signSessionCookie`
 * format):
 *
 *   { "v": 2, "subjects": [{ "sub": "<b64url>", "cred": "<b64url>", "nonce": "<b64url>", "iat": 1790000000 }] }
 *
 *   - `sub`: HMAC-SHA256 of the normalised email under a key derived from
 *     `LOBBYFORGE_SESSION_SECRET` — never the email. Only an account that
 *     signed in successfully gets an entry, so unknown emails never have one.
 *   - `cred`: HMAC-SHA256 of the normalised email AND the account's password
 *     hash at issue time, under another derived key — the keyed counterpart
 *     of `credentialFingerprint` (desktop handoff codes). The cookie is
 *     readable by the browser, so no unkeyed digest of the hash goes in it.
 *     A password change replaces the hash (new salt, every time), so it
 *     voids every device entry of that account, everywhere — it is also
 *     the app's "sign out everywhere" (`revokeOtherSessions`).
 *   - `nonce`: 16 random bytes, new on every successful sign-in; names the
 *     device's own failure bucket.
 *   - `iat`: when that entry was issued. Each entry is trusted for
 *     `DEVICE_COOKIE_MAX_AGE_SECONDS` from its own `iat`.
 *   - The MAC key is derived from the session secret with its own label, so
 *     a device cookie can never pass as a session cookie, or the other way
 *     round, and the `sub` and `cred` keys differ from the MAC key, from
 *     each other and from the rate limiter's key-name key.
 *
 * Two steps, because the sign-in routes count an attempt BEFORE they look
 * the account up (`readDeviceClaim`, then `beginSignInAttempt`) and the
 * credential is only known after the lookup (`deviceClaimHolds`, then
 * `confirmSignInDevice`, still before the password is checked). An entry
 * whose `cred` no longer matches is worth nothing: the attempt is charged to
 * the account-wide counter like a browser without a device cookie.
 *
 * A device cookie grants nothing on its own: it only changes WHICH failure
 * counter a password guess is charged to. It survives sign-out on purpose
 * (it identifies the browser, not a session), but not a password change.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readCookie, signSessionCookie, verifySessionCookie } from '@/lib/cookies';

export const DEVICE_COOKIE_NAME = 'lf_device';
/** 180 days, for the cookie and for each entry (from its own `iat`). */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** Accounts remembered per browser; signing in to a sixth drops the oldest. */
export const DEVICE_COOKIE_MAX_SUBJECTS = 5;

/** The payload version; v1 entries (no `cred`) are refused. */
const PAYLOAD_VERSION = 2;
/** Five entries are ~1,100 characters; anything far longer is not ours. */
const MAX_RAW_LENGTH = 2048;
/** An entry issued "in the future" by more than this is refused. */
const CLOCK_SKEW_SECONDS = 300;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/; // base64url of 16 bytes
/**
 * What `deviceClaimHolds` digests when the account has no usable password
 * (unknown email, deleted account, sign-in by Google only), so that case
 * does the same work as a real one. It never matches: no entry is ever
 * issued without a real password hash.
 */
const NO_CREDENTIAL = 'lobbyforge:device-cookie:no-credential';

interface DeviceEntry {
  sub: string;
  cred: string;
  nonce: string;
  iat: number;
}

/**
 * The request's device cookie entry for one email, read BEFORE the account
 * is looked up. Its MAC is valid, but it is only a claim until
 * `deviceClaimHolds` has checked it against the account's current password.
 */
export interface DeviceClaim {
  /** Names the device's own failure bucket (`SignInSubject.deviceNonce`). */
  nonce: string;
  /** The credential binding, for `deviceClaimHolds`. */
  cred: string;
}

export interface DeviceCookieOptions {
  /** Seconds since the epoch; defaults to now. */
  now?: number;
  /** Defaults to `NODE_ENV === 'production'`. */
  secure?: boolean;
}

function sessionSecret(): string | null {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function derivedKey(secret: string, label: string): Buffer {
  return createHmac('sha256', secret).update(label).digest();
}

/** Hex of a derived key: 64 characters, which `signSessionCookie` accepts. */
function macKey(secret: string): string {
  return derivedKey(secret, 'lobbyforge:device-cookie:mac:v1').toString('hex');
}

function normalisedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function subjectFor(email: string, secret: string): string {
  const key = derivedKey(secret, 'lobbyforge:device-cookie:subject:v1');
  return createHmac('sha256', key).update(`sign-in:${normalisedEmail(email)}`).digest('base64url');
}

function credentialFor(email: string, passwordHash: string, secret: string): string {
  const key = derivedKey(secret, 'lobbyforge:device-cookie:credential:v1');
  return createHmac('sha256', key)
    .update(JSON.stringify(['sign-in-credential', normalisedEmail(email), passwordHash]))
    .digest('base64url');
}

function nowSeconds(options: DeviceCookieOptions): number {
  return options.now ?? Math.floor(Date.now() / 1000);
}

function isFreshEntry(value: unknown, now: number): value is DeviceEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sub === 'string' &&
    DIGEST_PATTERN.test(entry.sub) &&
    typeof entry.cred === 'string' &&
    DIGEST_PATTERN.test(entry.cred) &&
    typeof entry.nonce === 'string' &&
    NONCE_PATTERN.test(entry.nonce) &&
    typeof entry.iat === 'number' &&
    Number.isInteger(entry.iat) &&
    entry.iat <= now + CLOCK_SKEW_SECONDS &&
    now - entry.iat <= DEVICE_COOKIE_MAX_AGE_SECONDS
  );
}

/** The verified, unexpired entries of the request's device cookie (none when forged). */
function readEntries(cookieHeader: string | null, secret: string, now: number): DeviceEntry[] {
  const raw = readCookie(cookieHeader, DEVICE_COOKIE_NAME);
  if (!raw || raw.length > MAX_RAW_LENGTH) return [];
  const payload = verifySessionCookie(raw, { secret: macKey(secret), now });
  if (!payload || payload.v !== PAYLOAD_VERSION || !Array.isArray(payload.subjects)) return [];
  return payload.subjects
    .slice(0, DEVICE_COOKIE_MAX_SUBJECTS)
    .filter((entry): entry is DeviceEntry => isFreshEntry(entry, now));
}

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The request's device cookie entry for this email — its nonce and its
 * credential binding — or null when there is no valid, unexpired entry for
 * it: no cookie, a forged or expired one, or one issued for other accounts
 * only. No lookup: the answer depends only on the cookie and the submitted
 * email, so it can pick the failure counter BEFORE anything is looked up.
 * A claim is provisional: `deviceClaimHolds` decides, after the lookup.
 */
export function readDeviceClaim(
  cookieHeader: string | null,
  email: string,
  options: DeviceCookieOptions = {}
): DeviceClaim | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const sub = subjectFor(email, secret);
  const entry = readEntries(cookieHeader, secret, nowSeconds(options)).find((e) => sameDigest(e.sub, sub));
  return entry ? { nonce: entry.nonce, cred: entry.cred } : null;
}

/**
 * Whether a claim is bound to the account's CURRENT password hash. Call it
 * after the credentials lookup and before the password check, ALWAYS — for
 * unknown emails and attempts without a claim too: it digests a fixed
 * stand-in when there is no hash and compares in constant time either way,
 * so every attempt does the same work. False without a claim, without a
 * usable password hash (unknown email, deleted account, no password), when
 * the password changed since the entry was issued, or without a secret.
 */
export function deviceClaimHolds(
  claim: DeviceClaim | null,
  email: string,
  passwordHash: string | null | undefined
): boolean {
  const secret = sessionSecret();
  if (!secret) return false;
  const hasCredential = typeof passwordHash === 'string' && passwordHash.length > 0;
  const expected = credentialFor(email, hasCredential ? passwordHash : NO_CREDENTIAL, secret);
  // Compare against something of the same shape when there is no claim, so
  // the comparison runs either way.
  const matches = sameDigest(claim?.cred ?? expected, expected);
  return claim !== null && hasCredential && matches;
}

/**
 * The `Set-Cookie` header after a SUCCESSFUL sign-in to `email` with the
 * account's current `passwordHash`: this account's entry first with a fresh
 * nonce, `iat` and credential binding (replacing any older entry for the
 * same email, stale or not), then the request's other still-valid entries,
 * at most `DEVICE_COOKIE_MAX_SUBJECTS`. Null when no usable session secret
 * is configured (no device trust at all).
 */
export function buildDeviceCookie(
  cookieHeader: string | null,
  email: string,
  passwordHash: string,
  options: DeviceCookieOptions = {}
): string | null {
  const secret = sessionSecret();
  if (!secret || !passwordHash) return null;
  const now = nowSeconds(options);
  const sub = subjectFor(email, secret);
  const others = readEntries(cookieHeader, secret, now).filter((e) => !sameDigest(e.sub, sub));
  const subjects: DeviceEntry[] = [
    { sub, cred: credentialFor(email, passwordHash, secret), nonce: randomBytes(16).toString('base64url'), iat: now },
    ...others,
  ].slice(0, DEVICE_COOKIE_MAX_SUBJECTS);
  return signSessionCookie(
    { v: PAYLOAD_VERSION, subjects },
    {
      name: DEVICE_COOKIE_NAME,
      secret: macKey(secret),
      maxAgeSeconds: DEVICE_COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: options.secure ?? process.env.NODE_ENV === 'production',
    }
  ).setCookieHeader;
}
