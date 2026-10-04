/**
 * Address-aware rate limits for the bot protection endpoints
 * (docs/CAPTCHA.md §4.2, §7): a bucket per client address — and, when the
 * app cannot tell clients apart (no `LOBBYFORGE_TRUSTED_PROXY`, every
 * visitor is "unknown"), one much larger instance-wide backstop instead.
 * A small per-address bucket shared by everyone would let one client lock
 * the whole instance out (and break a LAN party), the way
 * `signals.ts` already refuses to treat "unknown" as one address.
 *
 * Counters live under `lf:<env>:rate-limit:captcha-*` (the e2e reset clears
 * them), in Redis in production, in memory otherwise. When Redis fails in
 * production the request is refused (fail closed), like the rate limiter.
 */
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { resolveClientAddress } from '@/lib/security-headers';
import { captchaCounterKey, captchaStoreUsesRedis, memoryCounter, memoryIncrWithTtl, storeCounter, storeIncrWithTtl, type CounterState } from './store';

export interface AddressLimit {
  /** Names the bucket (`lf:<env>:rate-limit:captcha-<identifier>:…`). */
  identifier: string;
  windowMs: number;
  /** Per client address. */
  perAddress: number;
  /** For everyone together, when client addresses are unknown. */
  unknownBackstop: number;
}

/** §7: new guest identities — 10 / hour per address; 200 / hour instance-wide without a trusted proxy. */
export const NEW_GUEST_LIMIT: AddressLimit = { identifier: 'guest-new', windowMs: 60 * 60_000, perAddress: 10, unknownBackstop: 200 };
/** §4.2: ALTCHA challenges — 30 / min per address; 600 / min instance-wide without a trusted proxy. */
export const CHALLENGE_LIMIT: AddressLimit = { identifier: 'challenge', windowMs: 60_000, perAddress: 30, unknownBackstop: 600 };
/** §4.1: the public config — 120 / min per address; 1200 / min instance-wide without a trusted proxy. */
export const CONFIG_LIMIT: AddressLimit = { identifier: 'config', windowMs: 60_000, perAddress: 120, unknownBackstop: 1200 };

const UNAVAILABLE_RETRY_SECONDS = 5;

function bucket(req: Request, limit: AddressLimit): { key: string; max: number } {
  const address = resolveClientAddress(req);
  if (!address || address === 'unknown') {
    return { key: captchaCounterKey(`${limit.identifier}:unknown-backstop`), max: limit.unknownBackstop };
  }
  const hashed = createHash('sha256').update(`lobbyforge:${address}`).digest('hex').slice(0, 32);
  return { key: captchaCounterKey(`${limit.identifier}:${hashed}`), max: limit.perAddress };
}

/** The same 429 as the shared limiter (`rateLimitResponse`). */
function limitedResponse(retryAfterSeconds: number): NextResponse {
  const resetAt = new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
  return NextResponse.json(
    { error: 'Rate limit exceeded', retryAfter: retryAfterSeconds, resetAt },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds), 'X-RateLimit-Reset': resetAt, 'Cache-Control': 'no-store' } }
  );
}

async function guarded(op: () => Promise<CounterState>, fallback: () => CounterState): Promise<CounterState | null> {
  try {
    return await op();
  } catch (error) {
    console.error('[captcha] rate limit store unavailable', JSON.stringify((error as Error).message));
    if (process.env.NODE_ENV === 'production' && captchaStoreUsesRedis()) return null;
    return fallback();
  }
}

/** Would one more hit be refused? Reads without counting. Null when the request may go on. */
export async function peekAddressLimit(req: Request, limit: AddressLimit): Promise<NextResponse | null> {
  const { key, max } = bucket(req, limit);
  const state = await guarded(() => storeCounter(key), () => memoryCounter(key));
  if (!state) return limitedResponse(UNAVAILABLE_RETRY_SECONDS);
  if (state.count < max) return null;
  return limitedResponse(Math.max(1, Math.ceil(state.ttlMs / 1000)));
}

/** Count one hit; refused once the bucket is over its limit. Null when the request may go on. */
export async function hitAddressLimit(req: Request, limit: AddressLimit): Promise<NextResponse | null> {
  const { key, max } = bucket(req, limit);
  const state = await guarded(() => storeIncrWithTtl(key, limit.windowMs), () => memoryIncrWithTtl(key, limit.windowMs));
  if (!state) return limitedResponse(UNAVAILABLE_RETRY_SECONDS);
  if (state.count <= max) return null;
  console.warn(`[security] rate limit hit: captcha-${limit.identifier}`);
  return limitedResponse(Math.max(1, Math.ceil(state.ttlMs / 1000)));
}
