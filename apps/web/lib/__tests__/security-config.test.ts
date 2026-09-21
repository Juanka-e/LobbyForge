import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

describe('dev stack origin wiring', () => {
  const compose = readFileSync(join(REPO_ROOT, 'infra', 'docker', 'docker-compose.dev.yml'), 'utf8');

  // beta-review: the CSRF origin guard compares the browser Origin against
  // the app's own origin, and the container always listens on 3000 — so a
  // published host port MUST be declared, or every POST from the browser
  // fails with "Invalid request origin" (hit when the ports moved).
  const publishedWebPort = () => /- "(\d+):3000"/.exec(compose)?.[1];
  // Every LOBBYFORGE_APP_ORIGIN default in the file (web + ws-gateway).
  const declaredOrigins = () =>
    [...compose.matchAll(/LOBBYFORGE_APP_ORIGIN:[^\n]*localhost:(\d+)/g)].map((m) => m[1]);

  it('declares the published web origin for the origin guard', () => {
    const port = publishedWebPort();
    expect(port).toBeTruthy();
    expect(declaredOrigins()).toContain(port);
  });

  it('points web and the realtime gateway at the same origin', () => {
    const origins = declaredOrigins();
    expect(origins.length).toBeGreaterThanOrEqual(2);
    expect(new Set(origins).size).toBe(1);
    expect(origins[0]).toBe(publishedWebPort());
  });
});

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
    // beta-review: the names are assembled at runtime (a computed key is not
    // inlined at build time), so assert on the parts + the parsing guard.
    expect(middleware).toContain('LIVEKIT_URL');
    expect(middleware).toContain('WS_URL');
    expect(middleware).toContain('LOBBYFORGE_PUBLIC_LIVEKIT_URL');
    expect(middleware).toContain('LOBBYFORGE_PUBLIC_WS_URL');
    expect(middleware).toContain("url.protocol === 'https:'");
  });
});
