/**
 * Rate limits for the email routes (docs/EMAIL.md §4.4), in the
 * auth-throttle pattern: fixed windows in the bot-protection store (Redis
 * in production, memory otherwise), under `lf:<env>:rate-limit:email-*` so
 * the documented e2e reset (delete `*rate-limit*`) clears them.
 *
 *   | What                                         | Limit                          |
 *   | verification email, per account              | 60 s cooldown; 5/hour; 10/day  |
 *   | change email, per account (own buckets)      | 60 s cooldown; 5/hour; 10/day  |
 *   | same target address, across accounts + kinds | 3/hour                         |
 *   | sends per client address                     | 10 / 15 min                    |
 *   | code attempts                                | 5 per code (DB); 10/account/15 min |
 *   | reset-code attempts, per address typed       | 10 / 15 min (own budget)       |
 *   | token / code POSTs per client address        | 10/min                         |
 *   | forgot-password per target email             | 3/hour (silent: same 202)      |
 *
 * The send buckets (cooldown, hour, day, target) are taken with
 * `reserveWindows`: one atomic step that counts a hit in every bucket or in
 * none, so a burst of concurrent requests cannot all pass a check before
 * any of them counts.
 *
 * Behind an unknown client address (no LOBBYFORGE_TRUSTED_PROXY) the
 * per-address buckets become ONE instance-wide backstop with a much larger
 * limit, as in `lib/captcha/limits.ts`: a 10-per-window bucket shared by
 * every visitor would be a one-client denial of service.
 *
 * Accounts and addresses are hashed into the key; a raw address never
 * lands in Redis. When the store fails in production the request is
 * refused (fail closed), like the shared limiter.
 */
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { captchaStoreUsesRedis, memoryCounter, memoryIncrWithTtl, storeCounter, storeIncrWithTtl, type CounterState } from '@/lib/captcha/store';
import { resolveClientAddress } from '@/lib/security-headers';

export interface WindowLimit {
  name: string;
  windowMs: number;
  max: number;
}

export interface AddressWindowLimit {
  name: string;
  windowMs: number;
  perAddress: number;
  unknownBackstop: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SEND_COOLDOWN: WindowLimit = { name: 'send-cooldown', windowMs: MINUTE, max: 1 };
export const SEND_HOURLY: WindowLimit = { name: 'send-hour', windowMs: HOUR, max: 5 };
export const SEND_DAILY: WindowLimit = { name: 'send-day', windowMs: 24 * HOUR, max: 10 };
export const ACCOUNT_SEND_LIMITS: readonly WindowLimit[] = [SEND_COOLDOWN, SEND_HOURLY, SEND_DAILY];
/**
 * Email-change sends have their OWN per-account buckets (same sizes): fixing
 * a typo right after sign-up must not wait out the verification email's
 * cooldown. The per-target bucket stays shared — it protects the inbox.
 */
export const CHANGE_COOLDOWN: WindowLimit = { name: 'change-cooldown', windowMs: MINUTE, max: 1 };
export const CHANGE_HOURLY: WindowLimit = { name: 'change-hour', windowMs: HOUR, max: 5 };
export const CHANGE_DAILY: WindowLimit = { name: 'change-day', windowMs: 24 * HOUR, max: 10 };
export const CHANGE_SEND_LIMITS: readonly WindowLimit[] = [CHANGE_COOLDOWN, CHANGE_HOURLY, CHANGE_DAILY];
export const TARGET_HOURLY: WindowLimit = { name: 'target', windowMs: HOUR, max: 3 };
export const CODE_ATTEMPTS_PER_ACCOUNT: WindowLimit = { name: 'code', windowMs: 15 * MINUTE, max: 10 };
/** Reset codes have their own budget, keyed by the address typed (known or not): it never touches verify/change. */
export const RESET_CODE_ATTEMPTS: WindowLimit = { name: 'reset-code', windowMs: 15 * MINUTE, max: 10 };
export const FORGOT_PER_TARGET: WindowLimit = { name: 'forgot', windowMs: HOUR, max: 3 };
export const SENDS_PER_ADDRESS: AddressWindowLimit = { name: 'send-address', windowMs: 15 * MINUTE, perAddress: 10, unknownBackstop: 300 };
export const TOKEN_POSTS_PER_ADDRESS: AddressWindowLimit = { name: 'token-address', windowMs: MINUTE, perAddress: 10, unknownBackstop: 600 };

/** Thrown when the store is down in production: the route answers 429 with a short retry. */
export class LimitStoreUnavailable extends Error {
  constructor() {
    super('rate limit store unavailable');
    this.name = 'LimitStoreUnavailable';
  }
}

function hashed(value: string): string {
  return createHash('sha256').update(`lobbyforge:email-limit:${value}`).digest('hex').slice(0, 32);
}

function limitKey(name: string, subject: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:rate-limit:email-${name}:${hashed(subject)}`;
}

async function guarded(op: () => Promise<CounterState>, fallback: () => CounterState): Promise<CounterState> {
  try {
    return await op();
  } catch (error) {
    console.error('[mail] rate limit store unavailable', JSON.stringify((error as Error).message));
    if (process.env.NODE_ENV === 'production' && captchaStoreUsesRedis()) throw new LimitStoreUnavailable();
    return fallback();
  }
}

async function peek(key: string): Promise<CounterState> {
  return guarded(() => storeCounter(key), () => memoryCounter(key));
}

async function hit(key: string, windowMs: number): Promise<CounterState> {
  return guarded(() => storeIncrWithTtl(key, windowMs), () => memoryIncrWithTtl(key, windowMs));
}

/** Seconds until every given bucket for `subject` has room again; 0 when they all have room now. */
export async function secondsUntilAllowed(limits: readonly WindowLimit[], subject: string): Promise<number> {
  let wait = 0;
  for (const limit of limits) {
    const state = await peek(limitKey(limit.name, subject));
    if (state.count >= limit.max) wait = Math.max(wait, Math.ceil(state.ttlMs / 1000) || 1);
  }
  return wait;
}

/** Count one hit in each bucket. Returns the seconds until the NEXT hit is allowed (for `resendAvailableAt`). */
export async function countHit(limits: readonly WindowLimit[], subject: string): Promise<number> {
  let wait = 0;
  for (const limit of limits) {
    const state = await hit(limitKey(limit.name, subject), limit.windowMs);
    if (state.count >= limit.max) wait = Math.max(wait, Math.ceil(state.ttlMs / 1000) || 1);
  }
  return wait;
}

export interface LimitEntry {
  limit: WindowLimit;
  subject: string;
}

/**
 * The outcome of `reserveWindows`: either every bucket counted one hit
 * (`wait` = seconds until the NEXT hit would be allowed, 0 when it already
 * is), or none did (`retryAfter` = seconds until the fullest bucket has room).
 */
export type Reservation = { ok: true; wait: number } | { ok: false; retryAfter: number };

// All or nothing: refuse when ANY bucket is full (counting nothing),
// otherwise count one hit in every bucket. One script, so a burst of
// concurrent requests cannot all pass a check before any of them counts.
// KEYS: the counters. ARGV: windowMs, max for each key, in order.
const RESERVE_SCRIPT = `
local blocked = -1
for i = 1, #KEYS do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= tonumber(ARGV[i * 2]) then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 0 then ttl = tonumber(ARGV[i * 2 - 1]) end
    if ttl > blocked then blocked = ttl end
  end
end
if blocked >= 0 then return { 0, blocked } end
local wait = 0
for i = 1, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  local ttl = redis.call('PTTL', KEYS[i])
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[i], ARGV[i * 2 - 1])
    ttl = tonumber(ARGV[i * 2 - 1])
  end
  if count >= tonumber(ARGV[i * 2]) and ttl > wait then wait = ttl end
end
return { 1, wait }
`;

/** The memory store's copy of RESERVE_SCRIPT. Synchronous, so it is just as atomic in one process. */
function reserveInMemory(entries: Array<{ key: string; limit: WindowLimit }>): [number, number] {
  let blocked = -1;
  for (const { key, limit } of entries) {
    const state = memoryCounter(key);
    if (state.count >= limit.max) blocked = Math.max(blocked, state.ttlMs || limit.windowMs);
  }
  if (blocked >= 0) return [0, blocked];
  let wait = 0;
  for (const { key, limit } of entries) {
    const state = memoryIncrWithTtl(key, limit.windowMs);
    if (state.count >= limit.max) wait = Math.max(wait, state.ttlMs);
  }
  return [1, wait];
}

/**
 * Count one hit in every bucket at once, or in none when any is full —
 * atomically (docs/EMAIL.md §4.4). Throws LimitStoreUnavailable when Redis
 * fails in production.
 */
export async function reserveWindows(entries: readonly LimitEntry[]): Promise<Reservation> {
  const keyed = entries.map(({ limit, subject }) => ({ key: limitKey(limit.name, subject), limit }));
  let result: [number, number];
  if (captchaStoreUsesRedis()) {
    try {
      const { redis } = await import('@/lib/redis');
      const args = keyed.flatMap(({ limit }) => [String(limit.windowMs), String(limit.max)]);
      const raw = (await redis.eval(RESERVE_SCRIPT, keyed.length, ...keyed.map((k) => k.key), ...args)) as [number, number];
      result = [Number(raw[0]), Number(raw[1])];
    } catch (error) {
      console.error('[mail] rate limit store unavailable', JSON.stringify((error as Error).message));
      if (process.env.NODE_ENV === 'production') throw new LimitStoreUnavailable();
      result = reserveInMemory(keyed);
    }
  } else {
    result = reserveInMemory(keyed);
  }
  const seconds = Math.ceil(result[1] / 1000);
  return result[0] === 1 ? { ok: true, wait: seconds } : { ok: false, retryAfter: Math.max(1, seconds) };
}

/** Count one hit and say whether it was over the limit (true = refuse). */
export async function hitOver(limit: WindowLimit, subject: string): Promise<{ over: boolean; retryAfter: number }> {
  const state = await hit(limitKey(limit.name, subject), limit.windowMs);
  return { over: state.count > limit.max, retryAfter: Math.max(1, Math.ceil(state.ttlMs / 1000)) };
}

function addressSubject(req: Request, limit: AddressWindowLimit): { subject: string; max: number } {
  const address = resolveClientAddress(req);
  if (!address || address === 'unknown') return { subject: 'unknown-backstop', max: limit.unknownBackstop };
  return { subject: address, max: limit.perAddress };
}

/** Count one hit for the client address (or the unknown-address backstop). */
export async function hitAddress(req: Request, limit: AddressWindowLimit): Promise<{ over: boolean; retryAfter: number }> {
  const { subject, max } = addressSubject(req, limit);
  const state = await hit(limitKey(limit.name, subject), limit.windowMs);
  return { over: state.count > max, retryAfter: Math.max(1, Math.ceil(state.ttlMs / 1000)) };
}

/** Would one more hit for the client address be refused? Reads without counting. */
export async function peekAddress(req: Request, limit: AddressWindowLimit): Promise<{ over: boolean; retryAfter: number }> {
  const { subject, max } = addressSubject(req, limit);
  const state = await peek(limitKey(limit.name, subject));
  return { over: state.count >= max, retryAfter: Math.max(1, Math.ceil(state.ttlMs / 1000)) };
}

/** The contract's 429 (§4.3): `{ error: "rate_limited", retryAfter }`. */
export function rateLimitedResponse(retryAfter: number): NextResponse {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  return NextResponse.json(
    { error: 'rate_limited', retryAfter: seconds },
    { status: 429, headers: { 'Retry-After': String(seconds), 'Cache-Control': 'no-store' } }
  );
}

/** Account subjects are user ids; target subjects are normalised addresses. Kept apart in the key. */
export const accountSubject = (userId: string) => `user:${userId}`;
export const targetSubject = (email: string) => `email:${email.trim().toLowerCase()}`;
export const resetCodeSubject = (email: string) => `reset:${email.trim().toLowerCase()}`;

/** The buckets a verification email counts against: the account's verify cooldown, hour and day, and the (shared) target hour. */
export function verificationSendEntries(userId: string, targetEmail: string): LimitEntry[] {
  return [
    ...ACCOUNT_SEND_LIMITS.map((limit) => ({ limit, subject: accountSubject(userId) })),
    { limit: TARGET_HOURLY, subject: targetSubject(targetEmail) },
  ];
}

/** The buckets an email-change confirmation counts against: the account's CHANGE cooldown, hour and day, and the (shared) target hour. */
export function changeSendEntries(userId: string, targetEmail: string): LimitEntry[] {
  return [
    ...CHANGE_SEND_LIMITS.map((limit) => ({ limit, subject: accountSubject(userId) })),
    { limit: TARGET_HOURLY, subject: targetSubject(targetEmail) },
  ];
}
