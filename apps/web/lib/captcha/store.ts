/**
 * The small key-value store the bot protection keeps its short-lived state
 * in: ALTCHA replay markers, the external-provider breaker, the cached
 * reachability probe, and the sign-in failure counters behind adaptive
 * sign-in and attack mode.
 *
 * Storage follows the rate limiter (`lib/security-headers.ts`,
 * `lib/auth-throttle.ts`): Redis in production (or with
 * LOBBYFORGE_RATE_LIMIT_STORE=redis), an in-process map otherwise. The map
 * lives on `globalThis` — Next splits a module across chunks, so a
 * module-level map would not be shared between routes.
 *
 * Every Redis call throws on failure; each caller decides whether to fail
 * closed (ALTCHA replay protection in production) or fall back to memory
 * (the breaker, the counters).
 */

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

const MEMORY_KEY = '__lobbyforgeCaptchaMemory__';

function memory(): Map<string, MemoryEntry> {
  const g = globalThis as unknown as Record<string, Map<string, MemoryEntry> | undefined>;
  let map = g[MEMORY_KEY];
  if (!map) {
    map = new Map();
    g[MEMORY_KEY] = map;
  }
  return map;
}

function liveEntry(key: string, now = Date.now()): MemoryEntry | null {
  const map = memory();
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    map.delete(key);
    return null;
  }
  return entry;
}

function sweep(now: number): void {
  const map = memory();
  if (map.size <= 10_000) return;
  for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
}

export function captchaStoreUsesRedis(): boolean {
  const configured = process.env.LOBBYFORGE_RATE_LIMIT_STORE;
  if (configured) return configured === 'redis';
  return process.env.NODE_ENV === 'production';
}

/** `lf:<env>:captcha:<name>` — the bot protection's own state. */
export function captchaKey(name: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:captcha:${name}`;
}

/**
 * `lf:<env>:rate-limit:captcha-<name>` — counters that behave like rate
 * limits, so the documented e2e reset (delete `*rate-limit*`) clears them.
 */
export function captchaCounterKey(name: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:rate-limit:captcha-${name}`;
}

async function redisClient() {
  const { redis } = await import('@/lib/redis');
  return redis;
}

// ---- memory implementations (also the fallback copies) ---------------------

export function memorySetNx(key: string, value: string, ttlMs: number): boolean {
  const now = Date.now();
  sweep(now);
  if (liveEntry(key, now)) return false;
  memory().set(key, { value, expiresAt: now + ttlMs });
  return true;
}

export function memorySet(key: string, value: string, ttlMs: number): void {
  const now = Date.now();
  sweep(now);
  memory().set(key, { value, expiresAt: now + ttlMs });
}

export function memoryGet(key: string): string | null {
  return liveEntry(key)?.value ?? null;
}

export function memoryDel(key: string): void {
  memory().delete(key);
}

/** Fixed window: the first increment starts it. Returns the new count. */
export function memoryIncr(key: string, windowMs: number): number {
  const now = Date.now();
  sweep(now);
  const entry = liveEntry(key, now);
  if (!entry) {
    memory().set(key, { value: '1', expiresAt: now + windowMs });
    return 1;
  }
  const next = (Number(entry.value) || 0) + 1;
  entry.value = String(next);
  return next;
}

// ---- store API -------------------------------------------------------------

/** SET NX with a TTL. True when this call set it. Throws when Redis fails. */
export async function storeSetNx(key: string, value: string, ttlMs: number): Promise<boolean> {
  if (!captchaStoreUsesRedis()) return memorySetNx(key, value, ttlMs);
  const redis = await redisClient();
  const result = await redis.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)), 'NX');
  return result === 'OK';
}

export async function storeSet(key: string, value: string, ttlMs: number): Promise<void> {
  if (!captchaStoreUsesRedis()) return memorySet(key, value, ttlMs);
  const redis = await redisClient();
  await redis.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
}

export async function storeGet(key: string): Promise<string | null> {
  if (!captchaStoreUsesRedis()) return memoryGet(key);
  const redis = await redisClient();
  return redis.get(key);
}

export async function storeDel(key: string): Promise<void> {
  if (!captchaStoreUsesRedis()) return memoryDel(key);
  const redis = await redisClient();
  await redis.del(key);
}

// INCR, and start the window on the first increment (also repairs a key that
// lost its expiry, so a counter can never stick forever).
const INCR_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/** Fixed-window counter: increments and returns the count in the current window. Throws when Redis fails. */
export async function storeIncr(key: string, windowMs: number): Promise<number> {
  if (!captchaStoreUsesRedis()) return memoryIncr(key, windowMs);
  const redis = await redisClient();
  return Number(await redis.eval(INCR_WINDOW_SCRIPT, 1, key, String(windowMs)));
}

export interface CounterState {
  count: number;
  /** Time left in the window (ms); 0 when the counter does not exist. */
  ttlMs: number;
}

export function memoryCounter(key: string): CounterState {
  const entry = liveEntry(key);
  return entry ? { count: Number(entry.value) || 0, ttlMs: Math.max(0, entry.expiresAt - Date.now()) } : { count: 0, ttlMs: 0 };
}

export function memoryIncrWithTtl(key: string, windowMs: number): CounterState {
  const count = memoryIncr(key, windowMs);
  return { count, ttlMs: memoryCounter(key).ttlMs || windowMs };
}

const INCR_WINDOW_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/** Read a fixed-window counter without counting. Throws when Redis fails. */
export async function storeCounter(key: string): Promise<CounterState> {
  if (!captchaStoreUsesRedis()) return memoryCounter(key);
  const redis = await redisClient();
  const [raw, ttl] = await Promise.all([redis.get(key), redis.pttl(key)]);
  return { count: Number(raw) || 0, ttlMs: Math.max(0, Number(ttl) || 0) };
}

/** Count one hit in a fixed window; the new count and the time left. Throws when Redis fails. */
export async function storeIncrWithTtl(key: string, windowMs: number): Promise<CounterState> {
  if (!captchaStoreUsesRedis()) return memoryIncrWithTtl(key, windowMs);
  const redis = await redisClient();
  const [count, ttl] = (await redis.eval(INCR_WINDOW_TTL_SCRIPT, 1, key, String(windowMs))) as [number, number];
  return { count: Number(count), ttlMs: Math.max(1, Number(ttl)) };
}

/** Test-only: forget every in-process entry. */
export function resetCaptchaMemoryForTests(): void {
  memory().clear();
}
