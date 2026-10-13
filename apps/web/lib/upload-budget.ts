/**
 * security-review FILE-001: a DAILY upload byte budget per client address.
 *
 * The per-user image quota (`lib/upload-quota.ts`, 24 MiB stored) bounds
 * what one account keeps, not how many accounts one client fills: guests
 * cost nothing to create (10 / hour / address behind ALTCHA). This budget
 * counts the bytes of every accepted image upload (avatar, profile banner,
 * server banner) against the caller's address for 24 hours — generous for a
 * person (64 MiB ≈ a dozen full-size banners a day), a wall for a script.
 *
 * When the app cannot tell clients apart (no `LOBBYFORGE_TRUSTED_PROXY`,
 * every visitor is "unknown") one much larger instance-wide backstop
 * applies instead, like the bot protection limits (`lib/captcha/limits.ts`):
 * a 64 MiB budget shared by everyone would be a one-client denial of
 * service.
 *
 * Counters live in Redis in production (or with
 * LOBBYFORGE_RATE_LIMIT_STORE=redis), in memory otherwise, under
 * `lf:<env>:rate-limit:upload-bytes:*` (the documented e2e reset clears
 * them). When Redis fails in production the upload is refused (fail
 * closed), like every other limit. A refused upload consumes nothing.
 */
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { resolveClientAddress } from '@/lib/security-headers';

export const UPLOAD_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Per client address, per 24 hours. */
export const UPLOAD_BYTES_PER_ADDRESS = 64 * 1024 * 1024;
/** For everyone together when client addresses are unknown (no trusted proxy). */
export const UPLOAD_BYTES_UNKNOWN_BACKSTOP = 512 * 1024 * 1024;

const UNAVAILABLE_RETRY_SECONDS = 5;

export type UploadBudgetDecision =
  | { ok: true; usedBytes: number; budgetBytes: number }
  | { ok: false; reason: 'exhausted'; usedBytes: number; budgetBytes: number; retryAfterSeconds: number }
  | { ok: false; reason: 'unavailable'; retryAfterSeconds: number };

function storeUsesRedis(): boolean {
  const configured = process.env.LOBBYFORGE_RATE_LIMIT_STORE;
  if (configured) return configured === 'redis';
  return process.env.NODE_ENV === 'production';
}

function counterKey(name: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:rate-limit:upload-bytes:${name}`;
}

function bucket(req: Request): { key: string; budget: number } {
  const address = resolveClientAddress(req);
  if (!address || address === 'unknown') {
    return { key: counterKey('unknown-backstop'), budget: UPLOAD_BYTES_UNKNOWN_BACKSTOP };
  }
  const hashed = createHash('sha256').update(`lobbyforge:${address}`).digest('hex').slice(0, 32);
  return { key: counterKey(hashed), budget: UPLOAD_BYTES_PER_ADDRESS };
}

// Add ARGV[1] bytes unless that would pass ARGV[2]; the first byte of a
// window starts its expiry (ARGV[3] ms; also repairs a key that lost it).
// Returns { accepted (1/0), bytes used after the call, ttl ms }.
const RESERVE_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local add = tonumber(ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
if used + add > tonumber(ARGV[2]) then
  return { 0, used, ttl }
end
used = redis.call('INCRBY', KEYS[1], add)
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  ttl = tonumber(ARGV[3])
end
return { 1, used, ttl }
`;

interface MemoryEntry {
  used: number;
  expiresAt: number;
}

const MEMORY_KEY = '__lobbyforgeUploadBudget__';

function memory(): Map<string, MemoryEntry> {
  const g = globalThis as unknown as Record<string, Map<string, MemoryEntry> | undefined>;
  let map = g[MEMORY_KEY];
  if (!map) {
    map = new Map();
    g[MEMORY_KEY] = map;
  }
  return map;
}

function memoryReserve(key: string, bytes: number, budget: number, now = Date.now()): [boolean, number, number] {
  const map = memory();
  let entry = map.get(key);
  if (entry && entry.expiresAt <= now) {
    map.delete(key);
    entry = undefined;
  }
  const used = entry?.used ?? 0;
  const ttl = entry ? entry.expiresAt - now : UPLOAD_BUDGET_WINDOW_MS;
  if (used + bytes > budget) return [false, used, ttl];
  map.set(key, { used: used + bytes, expiresAt: entry?.expiresAt ?? now + UPLOAD_BUDGET_WINDOW_MS });
  return [true, used + bytes, ttl];
}

/** Test-only — empties the in-memory store. */
export function __resetUploadBudgetMemory(): void {
  memory().clear();
}

/**
 * Reserve `bytes` (the stored data URL length) from the caller's daily
 * budget. Call it after every other check passed, right before persisting.
 */
export async function reserveUploadBytes(req: Request, bytes: number): Promise<UploadBudgetDecision> {
  const { key, budget } = bucket(req);
  let accepted: boolean;
  let used: number;
  let ttlMs: number;
  if (storeUsesRedis()) {
    try {
      const { redis } = await import('@/lib/redis');
      const result = (await redis.eval(RESERVE_SCRIPT, 1, key, String(bytes), String(budget), String(UPLOAD_BUDGET_WINDOW_MS))) as [
        number,
        number,
        number,
      ];
      accepted = Number(result[0]) === 1;
      used = Number(result[1]);
      ttlMs = Number(result[2]);
    } catch (error) {
      console.error('[upload-budget] Redis unavailable', JSON.stringify((error as Error).message));
      // Production fails closed, like the rate limiter: an outage must not
      // turn the disk-fill protection off.
      if (process.env.NODE_ENV === 'production') {
        return { ok: false, reason: 'unavailable', retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
      }
      [accepted, used, ttlMs] = memoryReserve(key, bytes, budget);
    }
  } else {
    [accepted, used, ttlMs] = memoryReserve(key, bytes, budget);
  }
  if (accepted) return { ok: true, usedBytes: used, budgetBytes: budget };
  console.warn('[security] daily upload byte budget exhausted');
  return {
    ok: false,
    reason: 'exhausted',
    usedBytes: used,
    budgetBytes: budget,
    retryAfterSeconds: Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : UPLOAD_BUDGET_WINDOW_MS) / 1000)),
  };
}

/**
 * 429 for a refused reservation. `code` is what the settings UI translates
 * (`upload_budget_exceeded`); an unavailable store answers like the shared
 * rate limiter (`rate_limited`).
 */
export function uploadBudgetResponse(decision: Exclude<UploadBudgetDecision, { ok: true }>): NextResponse {
  const retryAfter = decision.retryAfterSeconds;
  const resetAt = new Date(Date.now() + retryAfter * 1000).toISOString();
  const headers = { 'Retry-After': String(retryAfter), 'X-RateLimit-Reset': resetAt, 'Cache-Control': 'no-store' };
  if (decision.reason === 'unavailable') {
    return NextResponse.json({ error: 'Rate limit exceeded', code: 'rate_limited', retryAfter, resetAt }, { status: 429, headers });
  }
  return NextResponse.json(
    {
      error: 'Daily image upload limit reached for your network. Try again later.',
      code: 'upload_budget_exceeded',
      retryAfter,
      resetAt,
      budgetBytes: decision.budgetBytes,
    },
    { status: 429, headers }
  );
}

/** Reserve, or the 429 to return. Null when the upload may be stored. */
export async function consumeUploadBudget(req: Request, bytes: number): Promise<NextResponse | null> {
  const decision = await reserveUploadBytes(req, bytes);
  return decision.ok ? null : uploadBudgetResponse(decision);
}
