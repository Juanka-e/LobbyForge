import Redis from 'ioredis';

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL || 'redis://:lobbyforge_dev@localhost:6379');

// V4-012: without an 'error' listener every connection blip (e.g. Redis
// not running during `next build` page collection) surfaces as an
// UNHANDLED 'error' event, flooding build/test logs. Rate-limit the
// noise to one line per minute; real outages still surface through the
// depending features (presence, rate limits, SSE bus) failing loudly.
let lastRedisErrorLog = 0;
redis.on('error', (err: Error) => {
  const now = Date.now();
  if (now - lastRedisErrorLog > 60_000) {
    lastRedisErrorLog = now;
    console.warn('[redis] connection error (repeat errors suppressed for 60s):', err.message);
  }
});

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export type PresenceActivityKind = 'game' | 'music' | 'watch_party' | 'custom';

export interface PresenceActivitySnapshot {
  kind: PresenceActivityKind;
  label: string;
  pluginId?: string;
  serverName?: string;
}

export interface UserPresenceSnapshot {
  userId: string;
  status: PresenceStatus;
  channelId: string;
  lastSeen: number;
  activity?: PresenceActivitySnapshot;
}

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

export async function setUserPresence(
  userId: string,
  serverId: string,
  channelId: string,
  status: PresenceStatus = 'online',
  ttlSeconds: number = 90,
  activity?: PresenceActivitySnapshot
) {
  const presenceData = JSON.stringify({
    userId,
    status,
    channelId,
    lastSeen: Date.now(),
    ...(activity ? { activity } : {}),
  });

  const pipeline = redis.pipeline();
  pipeline.set(`lf:${process.env.NODE_ENV || 'dev'}:presence:server:${serverId}:${userId}`, presenceData, 'EX', ttlSeconds);
  pipeline.set(`lf:${process.env.NODE_ENV || 'dev'}:presence:channel:${channelId}:${userId}`, presenceData, 'EX', ttlSeconds);
  
  await pipeline.exec();
}

export async function getUserPresenceInServer(serverId: string) {
  const keys = await scanKeys(`lf:${process.env.NODE_ENV || 'dev'}:presence:server:${serverId}:*`);
  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  return values.filter(Boolean).map(v => JSON.parse(v!) as UserPresenceSnapshot);
}

export async function getUserPresenceInChannel(channelId: string) {
  const keys = await scanKeys(`lf:${process.env.NODE_ENV || 'dev'}:presence:channel:${channelId}:*`);
  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  return values.filter(Boolean).map(v => JSON.parse(v!) as UserPresenceSnapshot);
}

// ---- Bandwidth accumulator (M21.5-bandwidth) ----
//
// Per-server, per-day, per-hour byte counters in Redis. The lobby
// voice client periodically reports RTC stats (`bytesSent` /
// `bytesReceived` deltas) through the presence heartbeat; the
// presence route calls `incrServerBandwidth` so every Next.js worker
// contributes to the same counters. Admins read via
// `getServerBandwidthTotals` from the `/api/admin/bandwidth` route.
//
// Key shape:
//   lf:{env}:bw:{serverId}:total         → cumulative float bytes
//   lf:{env}:bw:{serverId}:{YYYY-MM-DD}  → daily float bytes (TTL 35d)
//   lf:{env}:bw:{serverId}:{YYYY-MM-DDTHH} → hourly float bytes (TTL 8d)
//   lf:{env}:bw:alert:{serverId}         → '1' when threshold exceeded

const BW_DAILY_TTL_SEC = 35 * 24 * 3600; // 35 days
const BW_HOURLY_TTL_SEC = 8 * 24 * 3600; // 8 days

function bwKey(serverId: string, suffix: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:bw:${serverId}:${suffix}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Add `bytesDelta` (a positive float) to the per-server / per-day /
 * per-hour counters. Callers should pass the *delta* since their last
 * report, not the cumulative `bytesSent` value — LiveKit's RTC stats
 * are monotonic per connection, so the lobby client diffs against the
 * previous sample and reports the increase.
 *
 * Also bumps the alert key when the configured threshold (defaults to
 * infinity) is exceeded. The admin UI reads the alert key to render
 * a "Bandwidth over budget" badge without having to compute totals on
 * every render.
 */
export async function incrServerBandwidth(
  serverId: string,
  bytesDelta: number,
  options: { alertThresholdBytes?: number; now?: Date } = {}
): Promise<void> {
  if (!Number.isFinite(bytesDelta) || bytesDelta <= 0) return;
  const now = options.now ?? new Date();
  const day = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  const hour = `${day}T${pad2(now.getUTCHours())}`;
  const threshold = options.alertThresholdBytes ?? Number.POSITIVE_INFINITY;

  const pipeline = redis.pipeline();
  pipeline.incrbyfloat(bwKey(serverId, 'total'), bytesDelta);
  pipeline.incrbyfloat(bwKey(serverId, day), bytesDelta);
  pipeline.expire(bwKey(serverId, day), BW_DAILY_TTL_SEC);
  pipeline.incrbyfloat(bwKey(serverId, hour), bytesDelta);
  pipeline.expire(bwKey(serverId, hour), BW_HOURLY_TTL_SEC);
  await pipeline.exec();

  if (Number.isFinite(threshold)) {
    const totalStr = await redis.get(bwKey(serverId, 'total'));
    const total = totalStr ? Number(totalStr) : 0;
    if (total >= threshold) {
      await redis.set(bwKey('alert', serverId), '1');
    }
  }
}

export interface BandwidthSnapshot {
  totalBytes: number;
  todayBytes: number;
  hourly: Array<{ hour: string; bytes: number }>;
  alertTriggered: boolean;
}

/**
 * Read the bandwidth counters for the admin UI. `hours` controls how
 * many trailing hours of the hourly breakdown we return (default 24).
 * Missing keys are reported as 0 — a fresh server has never reported.
 */
export async function getServerBandwidthTotals(
  serverId: string,
  options: { hours?: number; now?: Date } = {}
): Promise<BandwidthSnapshot> {
  const now = options.now ?? new Date();
  const hours = Math.min(Math.max(options.hours ?? 24, 1), 168);
  const day = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;

  const hourLabels: string[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600_000);
    hourLabels.push(
      `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}`
    );
  }

  const keys = [
    bwKey(serverId, 'total'),
    bwKey(serverId, day),
    bwKey('alert', serverId),
    ...hourLabels.map((h) => bwKey(serverId, h)),
  ];
  const values = await redis.mget(...keys);
  const totalBytes = values[0] ? Number(values[0]) : 0;
  const todayBytes = values[1] ? Number(values[1]) : 0;
  const alertTriggered = values[2] === '1';
  const hourly = hourLabels.map((hour, idx) => ({
    hour,
    bytes: values[3 + idx] ? Number(values[3 + idx]) : 0,
  }));

  return { totalBytes, todayBytes, hourly, alertTriggered };
}

/**
 * Clear the alert flag once the admin acknowledges it. The threshold
 * logic will re-trigger if traffic keeps exceeding the limit.
 */
export async function clearBandwidthAlert(serverId: string): Promise<void> {
  await redis.del(bwKey('alert', serverId));
}

// ---- Typing indicator ----
// Short-lived key per channel per user. The Composer sets it on each
// keystroke; the message list polls for active typers every 3s.
// TTL is 5s so the indicator disappears quickly when the user stops.

const TYPING_TTL_SEC = 5;

function typingKey(serverId: string, channelId: string, userId: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:typing:${serverId}:${channelId}:${userId}`;
}

function typingPattern(serverId: string, channelId: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:typing:${serverId}:${channelId}:*`;
}

export async function setTyping(serverId: string, channelId: string, userId: string, displayName: string): Promise<void> {
  await redis.set(typingKey(serverId, channelId, userId), displayName, 'EX', TYPING_TTL_SEC);
}

export async function getTypingUsers(serverId: string, channelId: string, excludeUserId?: string): Promise<string[]> {
  const keys = await scanKeys(typingPattern(serverId, channelId));
  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  const names = values.filter(Boolean).map(v => v as string);
  // Extract userId from key to filter self
  if (excludeUserId) {
    const selfKey = typingKey(serverId, channelId, excludeUserId);
    const selfIdx = keys.indexOf(selfKey);
    if (selfIdx >= 0) names.splice(selfIdx, 1);
  }
  return [...new Set(names)];
}
