import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('global web security policy', () => {
  const config = readFileSync(join(__dirname, '..', '..', 'next.config.mjs'), 'utf8');
  const middleware = readFileSync(join(__dirname, '..', '..', 'middleware.ts'), 'utf8');

  it('defines CSP anti-XSS and anti-framing boundaries in middleware', () => {
    expect(middleware).toContain("default-src 'self'");
    expect(middleware).toContain("object-src 'none'");
    expect(middleware).toContain("frame-ancestors 'none'");
    expect(middleware).toContain("base-uri 'self'");
    expect(middleware).toContain("form-action 'self'");
  });

  it('uses nonce-based script-src (no unsafe-inline for scripts)', () => {
    expect(middleware).toContain("'nonce-");
    // script-src must not have 'unsafe-inline' — it uses nonce instead.
    // style-src may keep 'unsafe-inline' (CSS injection is low-risk vs JS).
    expect(middleware).toMatch(/script-src[^;]*'nonce-/);
  });

  it('keeps unsafe-eval development-only and enables production HSTS', () => {
    expect(middleware).toContain("isProduction ? '' : \" 'unsafe-eval'\"");
    expect(middleware).toContain('Strict-Transport-Security');
    expect(middleware).toContain('max-age=63072000; includeSubDomains; preload');
  });

  it('adds security headers in next.config as fallback', () => {
    expect(config).toContain('X-Content-Type-Options');
    expect(config).toContain('X-Frame-Options');
    expect(config).toContain('Referrer-Policy');
    expect(config).toContain('Permissions-Policy');
  });

  it('adds only parsed public realtime origins to connect-src in middleware', () => {
    expect(middleware).toContain('NEXT_PUBLIC_LIVEKIT_URL');
    expect(middleware).toContain('NEXT_PUBLIC_WS_URL');
    expect(middleware).toContain("url.protocol === 'https:'");
  });
});
