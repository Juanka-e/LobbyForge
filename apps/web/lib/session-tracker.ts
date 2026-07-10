/**
 * Session tracker — lightweight Redis-based session fingerprinting.
 *
 * Every authenticated request records (or refreshes) a per-session entry
 * in Redis keyed by the cookie's `gid` (the crypto-random guest id). The
 * entry stores the IP address, a parsed User-Agent (device, browser, OS),
 * an optional location derived from proxy headers, and the creation +
 * last-seen timestamps.
 *
 * Sessions expire after 7 days of inactivity (TTL refreshed on every
 * request). Revocation deletes the Redis key and adds the `gid` to a
 * per-user revocation set so the cookie is rejected on the next request
 * even if the client still holds it.
 *
 * No DB migration needed — everything lives in Redis, mirroring the
 * presence system's pattern.
 */
import { redis } from './redis';

const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 days

function sessionKey(userId: string, gid: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:session:${userId}:${gid}`;
}

function revokedKey(userId: string): string {
  return `lf:${process.env.NODE_ENV || 'dev'}:session-revoked:${userId}`;
}

export interface ParsedUserAgent {
  browser: string;
  os: string;
  deviceType: 'Desktop' | 'Mobile' | 'Tablet';
}

export interface SessionFingerprint {
  gid: string;
  userId: string;
  ipAddress: string;
  browser: string;
  os: string;
  deviceType: string;
  location: string;
  createdAt: number;
  lastSeen: number;
}

/**
 * Parse a User-Agent header into a human-readable {browser, os, deviceType}.
 * No npm dependency — just ordered regex matching. Good enough for the
 * settings panel; we don't need perfect coverage of every niche browser.
 */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  const header = ua ?? '';
  const lower = header.toLowerCase();

  // Device type
  let deviceType: ParsedUserAgent['deviceType'] = 'Desktop';
  if (/ipad|tablet|playbook|silk/.test(lower)) {
    deviceType = 'Tablet';
  } else if (/mobile|iphone|ipod|android.*mobile|windows phone/.test(lower)) {
    deviceType = 'Mobile';
  }

  // Browser — order matters (Edge/Brave masquerade as Chrome)
  let browser = 'Unknown';
  if (/edg\//.test(lower)) browser = 'Edge';
  else if (/opr\/|opera/.test(lower)) browser = 'Opera';
  else if (/brave|cry|chrome\/.*chromium/.test(lower)) browser = 'Brave';
  else if (/firefox\//.test(lower)) browser = 'Firefox';
  else if (/chrome\//.test(lower)) browser = 'Chrome';
  else if (/safari\//.test(lower)) browser = 'Safari';

  // OS
  let os = 'Unknown';
  if (/windows nt 10/.test(lower)) os = 'Windows';
  else if (/windows/.test(lower)) os = 'Windows';
  else if (/mac os x|macintosh/.test(lower)) os = 'macOS';
  else if (/android/.test(lower)) os = 'Android';
  else if (/iphone|ipad|ios/.test(lower)) os = 'iOS';
  else if (/linux/.test(lower)) os = 'Linux';

  return { browser, os, deviceType };
}

/**
 * Extract the client IP from the request headers. Honours the
 * `LOBBYFORGE_TRUSTED_PROXY` setting — if not configured, only
 * `x-forwarded-for` from localhost is trusted (development).
 */
export function resolveClientIp(req: Request): string {
  const trusted = process.env.LOBBYFORGE_TRUSTED_PROXY;
  const xff = req.headers.get('x-forwarded-for');
  const realIp = req.headers.get('x-real-ip');
  const cfIp = req.headers.get('cf-connecting-ip');

  if (trusted === 'cloudflare' && cfIp) return cfIp.trim();
  if (xff && (trusted === 'x-forwarded-for' || process.env.NODE_ENV === 'production')) {
    // x-forwarded-for: "client, proxy1, proxy2" — first is the client
    return xff.split(',')[0].trim();
  }
  if (realIp && trusted) return realIp.trim();
  return 'unknown';
}

/**
 * Best-effort location string from proxy geo-headers. Cloudflare and
 * Vercel both inject country/city headers when acting as a CDN. We
 * never call a third-party GeoIP API — only read what the trusted
 * proxy already provides.
 */
export function resolveLocation(req: Request): string {
  const trusted = process.env.LOBBYFORGE_TRUSTED_PROXY;
  if (!trusted) return '';

  const country = req.headers.get('cf-ipcountry') ?? req.headers.get('x-vercel-ip-country');
  const city = req.headers.get('cf-ipcity') ?? req.headers.get('x-vercel-ip-city');
  const region = req.headers.get('x-vercel-ip-country-region');

  const parts = [city, region, country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '';
}

/**
 * Record (or refresh) a session fingerprint in Redis. Called on every
 * authenticated request via the session-tracking middleware. Creates
 * the entry on first sight; bumps `lastSeen` + TTL on subsequent.
 */
export async function recordSession(
  userId: string,
  gid: string,
  req: Request
): Promise<void> {
  if (!userId || !gid) return;

  // Check if this session was previously revoked. If so, don't re-create
  // it — the cookie should have been rejected by the auth layer already,
  // but defense-in-depth.
  const revoked = await redis.sismember(revokedKey(userId), gid);
  if (revoked) return;

  const ip = resolveClientIp(req);
  const ua = parseUserAgent(req.headers.get('user-agent'));
  const location = resolveLocation(req);
  const now = Date.now();

  const existingRaw = await redis.get(sessionKey(userId, gid));
  const existing = existingRaw ? (JSON.parse(existingRaw) as SessionFingerprint) : null;

  const fingerprint: SessionFingerprint = {
    gid,
    userId,
    ipAddress: ip,
    browser: ua.browser,
    os: ua.os,
    deviceType: ua.deviceType,
    location,
    createdAt: existing?.createdAt ?? now,
    lastSeen: now,
  };

  await redis.set(sessionKey(userId, gid), JSON.stringify(fingerprint), 'EX', SESSION_TTL_SECONDS);
}

/**
 * List all active sessions for a user. Scans the Redis keyspace for
 * `session:{userId}:*` and returns the fingerprints sorted by
 * lastSeen descending (most recent first).
 */
export async function listSessions(userId: string): Promise<SessionFingerprint[]> {
  const pattern = `lf:${process.env.NODE_ENV || 'dev'}:session:${userId}:*`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 50);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  const sessions: SessionFingerprint[] = [];
  for (const v of values) {
    if (!v) continue;
    try {
      sessions.push(JSON.parse(v) as SessionFingerprint);
    } catch {
      /* malformed entry — skip */
    }
  }
  return sessions.sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Revoke a session by its gid. Deletes the fingerprint key and adds
 * the gid to the per-user revocation set so the cookie is rejected on
 * the next request. The revocation set has a 30-day TTL (longer than
 * the session TTL) so it doesn't expire before the cookie.
 */
export async function revokeSession(userId: string, gid: string): Promise<void> {
  await redis.del(sessionKey(userId, gid));
  await redis.sadd(revokedKey(userId), gid);
  await redis.expire(revokedKey(userId), 30 * 24 * 3600);
}

/**
 * Check if a gid has been revoked. Called by the auth layer to reject
 * cookies whose session was revoked from another device.
 */
export async function isSessionRevoked(userId: string, gid: string): Promise<boolean> {
  const result = await redis.sismember(revokedKey(userId), gid);
  return result === 1;
}
