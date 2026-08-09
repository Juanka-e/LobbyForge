/**
 * Lightweight security helpers for Next.js App Router API routes.
 *
 * This is a self-hosted, no-Supabase variant of the secure-nextjs-api-routes
 * skill. We intentionally keep the surface small:
 *   - securityHeaders() applies the standard headers on every response
 *   - methodAllowlist() returns 405 for anything not in the list
 *   - distributedRateLimit() uses Redis in production and an in-process store
 *     in tests/development.
 *
 * CSRF protection and audit logging are added in focused route layers; this
 * wrapper keeps method, header, and coarse rate-limit concerns central.
 */
import { NextResponse } from 'next/server';
import { clearCookieHeader } from '@lobbyforge/core';
import { maintenanceResponseForRequest } from '@/lib/maintenance-guard';

const SECURITY_HEADER_NAMES = [
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Permissions-Policy',
] as const;

/**
 * Apply the standard security headers to an outgoing response.
 * Mutates and returns the same NextResponse.
 */
export function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
}

/**
 * Build a 405 Method Not Allowed response if the request method is not in the list.
 * Returns null when the method is allowed, in which case the handler should continue.
 */
export function methodAllowlist(req: Request, allowed: string[]): NextResponse | null {
  if (allowed.includes(req.method)) return null;
  return NextResponse.json(
    { error: 'Method not allowed', allowed },
    {
      status: 405,
      headers: { Allow: allowed.join(', ') },
    }
  );
}

export function originGuard(req: Request): NextResponse | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: 'Cross-site request rejected' }, { status: 403 });
  }
  const origin = req.headers.get('origin');
  if (!origin) {
    return process.env.NODE_ENV === 'production'
      ? NextResponse.json({ error: 'Missing request origin' }, { status: 403 })
      : null;
  }
  const normalizedOrigin = normalizeOrigin(origin);
  const expectedOrigins = new Set(
    [new URL(req.url).origin, process.env.LOBBYFORGE_APP_ORIGIN, process.env.NEXT_PUBLIC_BASE_URL]
      .map((value) => normalizeOrigin(value))
      .filter((value): value is string => Boolean(value))
  );
  if (!normalizedOrigin || !expectedOrigins.has(normalizedOrigin)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }
  return null;
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export function requestSizeGuard(req: Request, maxBodyBytes = DEFAULT_MAX_BODY_BYTES): NextResponse | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  const value = req.headers.get('content-length');
  if (!value) return null;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    return NextResponse.json({ error: 'Invalid Content-Length' }, { status: 400 });
  }
  if (length > maxBodyBytes) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  return null;
}

async function revokedSessionResponse(req: Request): Promise<NextResponse | null> {
  const cookie = req.headers.get('cookie');
  if (!cookie?.includes('lf_guest=')) return null;

  const secret = process.env.LOBBYFORGE_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const { readGuestSession } = await import('@/lib/guest-session');
  const session = readGuestSession(cookie, secret);
  if (!session?.uid) return null;

  try {
    const { isSessionRevoked } = await import('@/lib/session-tracker');
    if (!(await isSessionRevoked(session.uid, session.gid))) return null;
  } catch (error) {
    console.error('[session] revocation check unavailable', error);
    return process.env.NODE_ENV === 'production'
      ? NextResponse.json({ error: 'Session verification unavailable' }, { status: 503 })
      : null;
  }

  return NextResponse.json(
    { error: 'Session has been revoked' },
    { status: 401, headers: { 'Set-Cookie': clearCookieHeader('lf_guest') } }
  );
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Minimal in-process token bucket. The store is keyed by the supplied identifier
 * (e.g. "doctor:1.2.3.4"). Buckets are GC'd lazily when touched.
 *
 * This is NOT a distributed limiter — for a multi-instance deployment we need
 * a Redis-backed implementation (see infra/docker/docker-compose.dev.yml).
 */
class InMemoryRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  hit(key: string, config: RateLimitConfig): RateLimitResult {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + config.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: config.maxRequests - 1, resetAt };
    }
    if (existing.count >= config.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt };
    }
    existing.count += 1;
    return {
      allowed: true,
      remaining: config.maxRequests - existing.count,
      resetAt: existing.resetAt,
    };
  }

  /** Test-only — wipes the bucket store. */
  reset(): void {
    this.buckets.clear();
  }
}

const limiter = new InMemoryRateLimiter();

export function inMemoryRateLimit(
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  return limiter.hit(identifier, config);
}

export type TrustedProxyMode = 'none' | 'x-forwarded-for' | 'cloudflare';

/**
 * Resolve the caller address only from a proxy header the operator explicitly
 * trusts. Public clients can set these headers themselves when no trusted
 * reverse proxy strips/replaces them, so trusting them implicitly defeats the
 * limiter.
 */
export function resolveClientAddress(
  req: Request,
  mode: TrustedProxyMode = (process.env.LOBBYFORGE_TRUSTED_PROXY as TrustedProxyMode) || 'none'
): string {
  if (mode === 'cloudflare') {
    return req.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  }
  if (mode === 'x-forwarded-for') {
    return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  }
  // In production behind a reverse proxy (Nginx), warn loudly if the trusted
  // proxy is not configured — without it, ALL clients share one rate-limit bucket.
  if (process.env.NODE_ENV === 'production') {
    console.warn('[security] LOBBYFORGE_TRUSTED_PROXY is not set — rate limiting is ineffective (all clients share one bucket). Set to "x-forwarded-for" behind Nginx.');
  }
  return 'unknown';
}

export function rateLimitKey(req: Request, identifier: string): string {
  return `${identifier}:${resolveClientAddress(req)}`;
}

const REDIS_RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

function shouldUseRedisRateLimit(): boolean {
  const configured = process.env.LOBBYFORGE_RATE_LIMIT_STORE;
  if (configured) return configured === 'redis';
  return process.env.NODE_ENV === 'production';
}

export async function distributedRateLimit(
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  if (!shouldUseRedisRateLimit()) return inMemoryRateLimit(identifier, config);

  try {
    const { redis } = await import('@/lib/redis');
    const result = (await redis.eval(
      REDIS_RATE_LIMIT_SCRIPT,
      1,
      `lf:${process.env.NODE_ENV || 'dev'}:rate-limit:${identifier}`,
      String(config.windowMs)
    )) as [number, number];
    const count = Number(result[0]);
    const ttl = Math.max(1, Number(result[1]));
    return {
      allowed: count <= config.maxRequests,
      remaining: Math.max(0, config.maxRequests - count),
      resetAt: Date.now() + ttl,
    };
  } catch (error) {
    console.error('[rate-limit] Redis limiter unavailable', error);
    // Production fails closed: silently dropping protection during a Redis
    // outage would expose public auth and invite endpoints to brute force.
    return { allowed: false, remaining: 0, resetAt: Date.now() + 5_000 };
  }
}

/**
 * Build a NextResponse from a RateLimitResult, including 429 + Retry-After when blocked.
 * Returns null when the request is allowed, leaving the handler free to continue.
 */
export function rateLimitResponse(result: RateLimitResult, identifier?: string): NextResponse | null {
  if (result.allowed) return null;
  console.warn(`[security] rate limit hit: ${identifier ?? 'unknown'}`);
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: 'Rate limit exceeded', retryAfter, resetAt: new Date(result.resetAt).toISOString() },
    {
      status: 429,
      headers: {
        'Retry-After': retryAfter.toString(),
        'X-RateLimit-Reset': new Date(result.resetAt).toISOString(),
      },
    }
  );
}

/**
 * Wrap a handler in the standard security middleware.
 * The handler returns a NextResponse; this wrapper adds headers and method checks.
 *
 * Accepts handlers with one or two parameters. The two-arg form is used by
 * dynamic route segments (e.g. `[id]`) where Next.js 15 requires a second
 * `ctx` argument that resolves to `{ params: Promise<{ id: string }> }`.
 */
export function withApiSecurity<TContext = unknown>(
  handler: (req: Request, ctx: TContext) => Promise<NextResponse> | NextResponse,
  options: {
    allowedMethods: string[];
    rateLimit?: { identifier: string; config: RateLimitConfig };
    maintenanceMode?: 'enforce' | 'bypass';
    sessionRevocation?: 'enforce' | 'bypass';
    maxBodyBytes?: number;
  }
) {
  return async (req: Request, ctx: TContext): Promise<NextResponse> => {
    const notAllowed = methodAllowlist(req, options.allowedMethods);
    if (notAllowed) return applySecurityHeaders(notAllowed);
    const badOrigin = originGuard(req);
    if (badOrigin) return applySecurityHeaders(badOrigin);
    const oversized = requestSizeGuard(req, options.maxBodyBytes);
    if (oversized) return applySecurityHeaders(oversized);
    if (options.sessionRevocation !== 'bypass') {
      const revoked = await revokedSessionResponse(req);
      if (revoked) return applySecurityHeaders(revoked);
    }
    if (options.maintenanceMode !== 'bypass') {
      const maintenance = await maintenanceResponseForRequest(req);
      if (maintenance) return applySecurityHeaders(maintenance);
    }

    if (options.rateLimit) {
      const result = await distributedRateLimit(
        rateLimitKey(req, options.rateLimit.identifier),
        options.rateLimit.config
      );
      const blocked = rateLimitResponse(result, options.rateLimit.identifier);
      if (blocked) return applySecurityHeaders(blocked);
    }

    const response = await handler(req, ctx);
    return applySecurityHeaders(response);
  };
}

// Re-export the header-name tuple so tests can assert against it.
export const SECURITY_HEADERS = SECURITY_HEADER_NAMES;
