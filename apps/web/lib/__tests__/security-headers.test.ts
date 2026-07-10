import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  applySecurityHeaders,
  inMemoryRateLimit,
  methodAllowlist,
  originGuard,
  rateLimitResponse,
  requestSizeGuard,
  resolveClientAddress,
  withApiSecurity,
} from '../security-headers.js';

const envSnapshot = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

describe('applySecurityHeaders', () => {
  it('sets the standard security headers on the response', () => {
    const res = NextResponse.json({ ok: true });
    applySecurityHeaders(res);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
  });
});

describe('resolveClientAddress', () => {
  const request = new Request('https://example.test/', {
    headers: {
      'x-forwarded-for': '203.0.113.10, 10.0.0.2',
      'cf-connecting-ip': '198.51.100.20',
    },
  });

  it('ignores spoofable proxy headers by default', () => {
    expect(resolveClientAddress(request, 'none')).toBe('unknown');
  });

  it('uses only the explicitly configured proxy header', () => {
    expect(resolveClientAddress(request, 'x-forwarded-for')).toBe('203.0.113.10');
    expect(resolveClientAddress(request, 'cloudflare')).toBe('198.51.100.20');
  });
});

describe('methodAllowlist', () => {
  it('returns null when the method is allowed', () => {
    const req = new Request('https://example.test/', { method: 'GET' });
    expect(methodAllowlist(req, ['GET'])).toBeNull();
  });

  it('returns 405 with an Allow header when the method is not allowed', () => {
    const req = new Request('https://example.test/', { method: 'POST' });
    const res = methodAllowlist(req, ['GET']);
    expect(res?.status).toBe(405);
    expect(res?.headers.get('Allow')).toBe('GET');
  });
});

describe('inMemoryRateLimit', () => {
  beforeEach(() => {
    // We don't have a handle to the limiter from the test, so use a unique key per test.
  });

  it('allows up to maxRequests inside the window, then blocks', () => {
    const cfg = { windowMs: 60_000, maxRequests: 3 };
    const results = [
      inMemoryRateLimit('k1', cfg),
      inMemoryRateLimit('k1', cfg),
      inMemoryRateLimit('k1', cfg),
      inMemoryRateLimit('k1', cfg),
    ];
    expect(results.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(results[3].allowed).toBe(false);
  });

  it('uses independent buckets per key', () => {
    const cfg = { windowMs: 60_000, maxRequests: 1 };
    inMemoryRateLimit('k2', cfg);
    const other = inMemoryRateLimit('k3', cfg);
    expect(other.allowed).toBe(true);
  });
});

describe('request boundary guards', () => {
  it('rejects cross-site mutation requests even without Origin', () => {
    const req = new Request('https://example.test/api/settings', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(originGuard(req)?.status).toBe(403);
  });

  it('requires an Origin on production mutation requests', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('https://example.test/api/settings', { method: 'POST' });
    expect(originGuard(req)?.status).toBe(403);
  });

  it('accepts configured same-site origins for mutation requests', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOBBYFORGE_APP_ORIGIN', 'https://hub.example');
    const req = new Request('https://internal.example/api/settings', {
      method: 'POST',
      headers: { origin: 'https://hub.example/lobby' },
    });
    expect(originGuard(req)).toBeNull();
  });

  it('rejects oversized and malformed Content-Length values', () => {
    const oversized = new Request('https://example.test/api/settings', {
      method: 'POST',
      headers: { 'content-length': '2048' },
    });
    const malformed = new Request('https://example.test/api/settings', {
      method: 'POST',
      headers: { 'content-length': '-1' },
    });
    expect(requestSizeGuard(oversized, 1024)?.status).toBe(413);
    expect(requestSizeGuard(malformed, 1024)?.status).toBe(400);
  });
});

describe('rateLimitResponse', () => {
  it('returns null when the request is allowed', () => {
    expect(rateLimitResponse({ allowed: true, remaining: 5, resetAt: Date.now() + 1000 })).toBeNull();
  });

  it('returns 429 with Retry-After when blocked', () => {
    const resetAt = Date.now() + 5000;
    const res = rateLimitResponse({ allowed: false, remaining: 0, resetAt });
    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toBe('5');
  });
});

describe('withApiSecurity', () => {
  it('adds security headers to the handler response', async () => {
    const handler = withApiSecurity(async () => NextResponse.json({ hello: 'world' }), {
      allowedMethods: ['GET'],
    });
    const res = await handler(new Request('https://example.test/', { method: 'GET' }), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('short-circuits with 405 for disallowed methods', async () => {
    const handler = withApiSecurity(async () => NextResponse.json({}), {
      allowedMethods: ['GET'],
    });
    const res = await handler(new Request('https://example.test/', { method: 'POST' }), undefined);
    expect(res.status).toBe(405);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('applies the rate limit when configured', async () => {
    const handler = withApiSecurity(async () => NextResponse.json({ ok: true }), {
      allowedMethods: ['GET'],
      rateLimit: { identifier: 'withApiSecurity:1', config: { windowMs: 60_000, maxRequests: 1 } },
    });
    const first = await handler(new Request('https://example.test/', { method: 'GET' }), undefined);
    const second = await handler(new Request('https://example.test/', { method: 'GET' }), undefined);
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
