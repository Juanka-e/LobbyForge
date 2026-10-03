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
 * Keys live under `lf:<env>:rate-limit:auth-account:*`, so clearing
 * `*rate-limit*` keys (the documented e2e reset) clears them too.
 */
import { createHash, createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';

export interface AccountLimit {
  maxAttempts: number;
  windowMs: number;
}

/** Sign-in by email (login + desktop handoff start): 10 failures / 15 min. */
export const SIGN_IN_ACCOUNT_LIMIT: AccountLimit = { maxAttempts: 10, windowMs: 15 * 60_000 };
/** Current-password check when changing it: 5 failures / 15 min per user. */
export const PASSWORD_CHANGE_ACCOUNT_LIMIT: AccountLimit = { maxAttempts: 5, windowMs: 15 * 60_000 };

export type AccountSubject =
  | { scope: 'sign-in'; email: string }
  | { scope: 'reauth'; userId: string };

export type AccountAttempt = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** When Redis is down the attempt is refused for this long (as distributedRateLimit). */
const UNAVAILABLE_RETRY_SECONDS = 5;

function limitFor(subject: AccountSubject): AccountLimit {
  return subject.scope === 'sign-in' ? SIGN_IN_ACCOUNT_LIMIT : PASSWORD_CHANGE_ACCOUNT_LIMIT;
}

/** The normalised subject, hashed — the only form that reaches a key name. */
function subjectDigest(subject: AccountSubject): string {
  const value = subject.scope === 'sign-in' ? subject.email.trim().toLowerCase() : subject.userId;
  const material = `${subject.scope}:${value}`;
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

export function accountAttemptKey(subject: AccountSubject): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:rate-limit:auth-account:${subject.scope}:${subjectDigest(subject)}`;
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

/**
 * Count one attempt for this account. Call it BEFORE checking the
 * password; when it is refused, answer with `accountLockedResponse`
 * without checking anything.
 */
export async function beginAccountAttempt(subject: AccountSubject): Promise<AccountAttempt> {
  const limit = limitFor(subject);
  const key = accountAttemptKey(subject);
  let count: number;
  let ttlMs: number;
  if (useRedis()) {
    try {
      const { redis } = await import('@/lib/redis');
      const result = (await redis.eval(REDIS_ATTEMPT_SCRIPT, 1, key, String(limit.windowMs))) as [number, number];
      count = Number(result[0]);
      ttlMs = Math.max(1, Number(result[1]));
    } catch (error) {
      console.error('[auth] account attempt limiter unavailable', (error as Error).message);
      return { allowed: false, retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
    }
  } else {
    ({ count, ttlMs } = memoryAttempt(key, limit));
  }
  if (count <= limit.maxAttempts) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
}

/** A successful password check clears the account's counter. */
export async function clearAccountAttempts(subject: AccountSubject): Promise<void> {
  const key = accountAttemptKey(subject);
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
