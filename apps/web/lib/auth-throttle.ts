/**
 * Per-account sign-in failure limit (security follow-up 2026-10).
 *
 * `/api/auth/login` and `/api/auth/desktop-session` each had their own
 * per-IP bucket and no per-account limit, so an attacker with many
 * addresses had unlimited password guesses against one account. This adds
 * a counter keyed by the ACCOUNT, shared by both sign-in routes (and a
 * separate one, keyed by user id, for the current-password check of
 * `POST /api/auth/password`):
 *
 *   - Every attempt is counted BEFORE the password is checked — atomically,
 *     so parallel requests cannot squeeze in extra guesses — and a
 *     successful check clears the counter. In effect: after `maxAttempts`
 *     failures inside `windowMs`, every further attempt is refused with
 *     the generic 429 until the window (fixed from the first failure)
 *     ends, whether the password is right or not.
 *   - Unknown emails are counted and locked exactly like known ones (the
 *     key is derived from the normalised email, never from a lookup), so
 *     the limit is not an account-enumeration oracle.
 *   - Key names hold an HMAC of the normalised email (keyed with the
 *     session secret), never the email itself.
 *   - Storage follows `distributedRateLimit` in `lib/security-headers.ts`:
 *     Redis in production (or with LOBBYFORGE_RATE_LIMIT_STORE=redis),
 *     in-process otherwise; when Redis is unavailable the attempt is
 *     refused (fail closed), as that limiter does.
 *
 * Device cookies (OWASP "Slow Down Online Guessing Attacks with Device
 * Cookies", `lib/device-cookie.ts`): the account-wide lock alone let
 * anyone who knows an address lock its owner out. A sign-in attempt from a
 * browser holding a valid device cookie for that account goes through
 * `beginSignInAttempt` on the DEVICE path instead:
 *
 *   - It is counted in a bucket keyed by (account, device nonce) —
 *     `SIGN_IN_DEVICE_LIMIT`, the same fixed-window counter — and is NOT
 *     refused by the account-wide lock. Its success clears only its own
 *     bucket, never the account counter (otherwise every sign-in of the
 *     owner would hand whoever is guessing a fresh batch of guesses).
 *   - A device whose bucket trips is untrusted until that window ends: its
 *     attempts are charged to the account-wide counter like a browser
 *     without a device cookie (refused while the account is locked), and
 *     even a success then does not reset the account counter.
 *   - Without a valid device cookie for the account (none, forged,
 *     expired, or another account's) nothing changes from before.
 *   - The device path is provisional until the account is looked up: a
 *     device cookie entry is bound to the password hash it was issued
 *     under, and `confirmSignInDevice` (after the lookup, BEFORE the
 *     password check) charges the attempt to the account-wide counter —
 *     refused while the account is locked — when that binding no longer
 *     holds. So a password change (which also signs out every other
 *     session) leaves no device with a bucket outside the account lock.
 *
 * Keys live under `lf:<env>:rate-limit:auth-account:*` and
 * `lf:<env>:rate-limit:auth-device:*`, so clearing `*rate-limit*` keys
 * (the documented e2e reset) clears them too.
 */
import { createHash, createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';

export interface AccountLimit {
  maxAttempts: number;
  windowMs: number;
}

/** Sign-in by email (login + desktop handoff start): 10 failures / 15 min. */
export const SIGN_IN_ACCOUNT_LIMIT: AccountLimit = { maxAttempts: 10, windowMs: 15 * 60_000 };
/** Sign-in from a trusted device (valid device cookie): 10 failures / 15 min per (account, device). */
export const SIGN_IN_DEVICE_LIMIT: AccountLimit = { maxAttempts: 10, windowMs: 15 * 60_000 };
/** Current-password check when changing it: 5 failures / 15 min per user. */
export const PASSWORD_CHANGE_ACCOUNT_LIMIT: AccountLimit = { maxAttempts: 5, windowMs: 15 * 60_000 };

export type AccountSubject =
  | { scope: 'sign-in'; email: string }
  | { scope: 'reauth'; userId: string };

export type AccountAttempt = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** A sign-in attempt: the email, and the nonce of a VALID device cookie entry for it, if any. */
export interface SignInSubject {
  email: string;
  /** From `readDeviceClaim` (MAC verified) — never an unverified value from the request. */
  deviceNonce?: string | null;
}

/**
 * Which counter an allowed sign-in attempt was charged to:
 * `account` — no valid device cookie, or one whose credential binding no
 * longer holds; `device` — the device's own bucket; `untrusted-device` — a
 * device cookie whose bucket tripped, charged to the account counter.
 */
export type SignInPath = 'account' | 'device' | 'untrusted-device';

export type SignInAttempt =
  | { allowed: true; path: SignInPath }
  | { allowed: false; retryAfterSeconds: number };

/** When Redis is down the attempt is refused for this long (as distributedRateLimit). */
const UNAVAILABLE_RETRY_SECONDS = 5;

function limitFor(subject: AccountSubject): AccountLimit {
  return subject.scope === 'sign-in' ? SIGN_IN_ACCOUNT_LIMIT : PASSWORD_CHANGE_ACCOUNT_LIMIT;
}

/** HMAC of the material — the only form of an email that reaches a key name. */
function keyDigest(material: string): string {
  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  // Keyed so a Redis dump does not reveal which addresses were tried
  // (a plain hash of an email is a dictionary lookup away). The key is
  // DERIVED from the session secret, never the secret itself, so this
  // digest can never be confused with (or help forge) a session MAC.
  if (secret && secret.length >= 32) {
    const key = createHmac('sha256', secret).update('lobbyforge:auth-throttle:v1').digest();
    return createHmac('sha256', key).update(material).digest('hex');
  }
  return createHash('sha256').update(`lobbyforge:${material}`).digest('hex');
}

function normalisedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function keyPrefix(): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:rate-limit`;
}

export function accountAttemptKey(subject: AccountSubject): string {
  const value = subject.scope === 'sign-in' ? normalisedEmail(subject.email) : subject.userId;
  return `${keyPrefix()}:auth-account:${subject.scope}:${keyDigest(`${subject.scope}:${value}`)}`;
}

/** The failure bucket of one trusted device for one account. */
export function deviceAttemptKey(email: string, deviceNonce: string): string {
  const material = JSON.stringify(['sign-in-device', normalisedEmail(email), deviceNonce]);
  return `${keyPrefix()}:auth-device:sign-in:${keyDigest(material)}`;
}

function useRedis(): boolean {
  const configured = process.env.LOBBYFORGE_RATE_LIMIT_STORE;
  if (configured) return configured === 'redis';
  return process.env.NODE_ENV === 'production';
}

// INCR, and start the window on the first attempt. Also repairs a key that
// somehow lost its expiry, so a counter can never lock an account forever.
const REDIS_ATTEMPT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

const memory = new Map<string, { count: number; resetAt: number }>();

function memoryAttempt(key: string, limit: AccountLimit): { count: number; ttlMs: number } {
  const now = Date.now();
  // Arbitrary emails can each create an entry; drop expired ones lazily.
  if (memory.size > 10_000) {
    for (const [k, entry] of memory) if (entry.resetAt <= now) memory.delete(k);
  }
  const existing = memory.get(key);
  if (!existing || existing.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { count: 1, ttlMs: limit.windowMs };
  }
  existing.count += 1;
  return { count: existing.count, ttlMs: existing.resetAt - now };
}

/** One atomic increment of a counter; null when the store is unavailable. */
async function countAttempt(key: string, limit: AccountLimit): Promise<{ count: number; ttlMs: number } | null> {
  if (!useRedis()) return memoryAttempt(key, limit);
  try {
    const { redis } = await import('@/lib/redis');
    const result = (await redis.eval(REDIS_ATTEMPT_SCRIPT, 1, key, String(limit.windowMs))) as [number, number];
    return { count: Number(result[0]), ttlMs: Math.max(1, Number(result[1])) };
  } catch (error) {
    console.error('[auth] account attempt limiter unavailable', (error as Error).message);
    return null;
  }
}

function verdict(counted: { count: number; ttlMs: number } | null, limit: AccountLimit): AccountAttempt {
  if (!counted) return { allowed: false, retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
  if (counted.count <= limit.maxAttempts) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(counted.ttlMs / 1000)) };
}

async function clearKey(key: string): Promise<void> {
  if (!useRedis()) {
    memory.delete(key);
    return;
  }
  try {
    const { redis } = await import('@/lib/redis');
    await redis.del(key);
  } catch (error) {
    // The sign-in already succeeded; a stale counter only expires later.
    console.error('[auth] failed to clear the account attempt counter', (error as Error).message);
  }
}

/**
 * Count one attempt for this account. Call it BEFORE checking the
 * password; when it is refused, answer with `accountLockedResponse`
 * without checking anything.
 */
export async function beginAccountAttempt(subject: AccountSubject): Promise<AccountAttempt> {
  const limit = limitFor(subject);
  return verdict(await countAttempt(accountAttemptKey(subject), limit), limit);
}

/** A successful password check clears the account's counter. */
export async function clearAccountAttempts(subject: AccountSubject): Promise<void> {
  await clearKey(accountAttemptKey(subject));
}

/**
 * Count one sign-in attempt (login form or desktop handoff start), on the
 * device path when `deviceNonce` is set. Call it BEFORE looking anything
 * up; when it is refused, answer with `accountLockedResponse`. An allowed
 * attempt then goes through `confirmSignInDevice` after the lookup.
 */
export async function beginSignInAttempt(subject: SignInSubject): Promise<SignInAttempt> {
  const account = { scope: 'sign-in', email: subject.email } as const;
  let path: SignInPath = 'account';
  if (subject.deviceNonce) {
    const device = await countAttempt(deviceAttemptKey(subject.email, subject.deviceNonce), SIGN_IN_DEVICE_LIMIT);
    // Store down: fail closed, as the account counter does.
    if (!device) return { allowed: false, retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
    if (device.count <= SIGN_IN_DEVICE_LIMIT.maxAttempts) return { allowed: true, path: 'device' };
    // The device's own bucket tripped: untrusted until that window ends,
    // so this attempt is charged to the account-wide counter.
    path = 'untrusted-device';
  }
  const attempt = await beginAccountAttempt(account);
  return attempt.allowed ? { allowed: true, path } : attempt;
}

/**
 * The second half of the device check: call it after the credentials
 * lookup and BEFORE the password check, with `deviceHolds` from
 * `deviceClaimHolds` (is the device cookie entry bound to the account's
 * CURRENT password hash?). `beginSignInAttempt` could only check the
 * cookie's MAC. When an attempt on the device path turns out to carry an
 * entry issued under an older password (or for an account that is gone),
 * the device path is withdrawn: the attempt is charged to the account-wide
 * counter, exactly as for a browser without a device cookie, and refused
 * while the account is locked. Any other attempt is returned unchanged —
 * it was charged to the account counter already, and is never charged
 * twice.
 */
export async function confirmSignInDevice(
  subject: SignInSubject,
  attempt: { allowed: true; path: SignInPath },
  deviceHolds: boolean
): Promise<SignInAttempt> {
  if (attempt.path !== 'device' || deviceHolds) return attempt;
  const account = await beginAccountAttempt({ scope: 'sign-in', email: subject.email });
  return account.allowed ? { allowed: true, path: 'account' } : account;
}

/**
 * After a successful password check: clear the counter the attempt was
 * charged to. A device success clears only its own bucket; a success from
 * a device whose bucket tripped clears nothing.
 */
export async function finishSignInAttempt(subject: SignInSubject, path: SignInPath): Promise<void> {
  if (path === 'account') {
    await clearAccountAttempts({ scope: 'sign-in', email: subject.email });
  } else if (path === 'device' && subject.deviceNonce) {
    await clearKey(deviceAttemptKey(subject.email, subject.deviceNonce));
  }
}

/**
 * The refusal — the same body and headers as the per-IP limiter's 429
 * (`rateLimitResponse`), identical for known and unknown accounts.
 */
export function accountLockedResponse(retryAfterSeconds: number): NextResponse {
  const resetAt = new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
  return NextResponse.json(
    { error: 'Rate limit exceeded', retryAfter: retryAfterSeconds, resetAt },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Reset': resetAt,
        'Cache-Control': 'no-store',
      },
    }
  );
}

/** Test-only: forget every in-process counter. */
export function resetAccountAttemptsForTests(): void {
  memory.clear();
}
