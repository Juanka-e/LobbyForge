import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

// Bot protection CSP (docs/CAPTCHA.md §9): the middleware reads the CAPTCHA
// settings through lib/captcha/settings — faked here (no database).
const captcha = vi.hoisted(() => ({
  provider: 'altcha' as string,
  keys: true,
  lookups: 0,
}));
vi.mock('@/lib/captcha/settings', () => {
  const settings = () => ({ provider: captcha.provider, keys: captcha.keys });
  return {
    resolveCaptchaSettings: async () => {
      captcha.lookups += 1;
      return settings();
    },
    captchaSettingsSnapshot: () => ({ lastGood: null, fresh: false }),
    readCaptchaEnvOverrides: () => ({ provider: null, invalidProvider: null, siteKey: null, secretKey: null }),
    externalProviderConfigured: (s: { provider: string; keys: boolean }) =>
      (s.provider === 'turnstile' || s.provider === 'recaptcha') && s.keys,
  };
});

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

  it('frames itself (sandboxed plugin UI) and exactly one third-party origin: YouTube’s privacy-enhanced embed', async () => {
    // Pinned: no wildcard, no youtube.com, no second third-party origin. The
    // plugin builds its iframe from the same constant, so the two cannot drift.
    // 'self' is the marketplace plugin frame (ADR-007).
    const { YOUTUBE_EMBED_ORIGIN } = await import('@lobbyforge/watch-party');
    const frameSources = [...middleware.matchAll(/"frame-src ([^"]*)"/g)].map((m) => m[1]);
    expect(frameSources).toEqual(["'self' https://www.youtube-nocookie.com"]);
    expect(frameSources[0]!.split(' ')).toEqual(["'self'", YOUTUBE_EMBED_ORIGIN]);
    expect(middleware).not.toMatch(/child-src/);
  });

  it('leaves the plugin UI route to its own headers, and only that route', async () => {
    const { NextRequest } = await import('next/server');
    const { middleware: run } = await import('../../middleware');
    // The route sets a sandbox CSP with frame-ancestors 'self'; Next appends
    // route headers to middleware ones, so the app's 'none' must not be there.
    const asset = await run(new NextRequest('http://localhost:3000/api/plugin-ui/buzzer/1.0.0/index.html'));
    expect(asset.headers.get('Content-Security-Policy')).toBeNull();
    expect(asset.headers.get('X-Frame-Options')).toBeNull();
    for (const path of ['/api/plugin-ui/', '/api/plugin-ui/buzzer', '/api/plugin-ui/buzzer/1.0.0/', '/api/plugin-uix/a/b/c']) {
      const other = await run(new NextRequest(`http://localhost:3000${path}`));
      expect(other.headers.get('Content-Security-Policy'), path).toContain("frame-ancestors 'none'");
      expect(other.headers.get('X-Frame-Options'), path).toBe('DENY');
    }
    expect(config).toContain("source: '/:path((?!api/plugin-ui/).*)'");
  });

  it('sends that frame-src on real responses, next to the anti-framing rules', async () => {
    const { NextRequest } = await import('next/server');
    const { middleware: run } = await import('../../middleware');
    const response = await run(new NextRequest('http://localhost:3000/lobby'));
    const directives = (response.headers.get('Content-Security-Policy') ?? '').split(';').map((d) => d.trim());
    expect(directives).toContain("frame-src 'self' https://www.youtube-nocookie.com");
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("object-src 'none'");
    expect(directives.find((d) => d.startsWith('script-src'))).not.toMatch(/youtube/);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
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

  it('runs the middleware in the Node.js runtime (it reads the CAPTCHA settings cache)', async () => {
    const { config: middlewareConfig } = await import('../../middleware');
    expect(middlewareConfig.runtime).toBe('nodejs');
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

describe('bot protection CSP (docs/CAPTCHA.md §9)', () => {
  afterEach(() => {
    captcha.provider = 'altcha';
    captcha.keys = true;
    captcha.lookups = 0;
  });

  async function directives(path: string): Promise<Map<string, string>> {
    const { NextRequest } = await import('next/server');
    const { middleware: run } = await import('../../middleware');
    const response = await run(new NextRequest(`http://localhost:3000${path}`));
    const policy = response.headers.get('Content-Security-Policy') ?? '';
    return new Map(
      policy
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.split(' ')[0]!, d] as [string, string])
    );
  }

  const CLOUDFLARE = 'https://challenges.cloudflare.com';
  const BASE_FRAME = "frame-src 'self' https://www.youtube-nocookie.com";
  // Not only the widget pages: a client-side navigation (next/link) keeps the
  // CSP of the document it started on, so /home → /login must already allow
  // the provider on /home.
  const PAGES = ['/', '/home', '/login', '/register', '/join/ABCDEFGHJKMN', '/connect/demo', '/lobby', '/room/abc', '/settings', '/admin/settings/authentication', '/discover'];

  it('adds no origin anywhere for the built-in ALTCHA or for none', async () => {
    for (const provider of ['altcha', 'none']) {
      captcha.provider = provider;
      for (const path of PAGES) {
        const csp = await directives(path);
        expect(csp.get('script-src'), `${provider} ${path}`).not.toMatch(/https:/);
        expect(csp.get('frame-src'), `${provider} ${path}`).toBe(BASE_FRAME);
        expect(csp.get('connect-src'), `${provider} ${path}`).not.toMatch(/google|cloudflare/);
      }
    }
  });

  it('adds Turnstile to script-src and frame-src on every page while it is configured', async () => {
    captcha.provider = 'turnstile';
    for (const path of PAGES) {
      const csp = await directives(path);
      expect(csp.get('script-src'), path).toContain(CLOUDFLARE);
      expect(csp.get('frame-src'), path).toBe(`${BASE_FRAME} ${CLOUDFLARE}`);
      expect(csp.get('connect-src'), path).not.toContain(CLOUDFLARE);
    }
  });

  it('adds Google’s reCAPTCHA origins (script, frame, connect) on every page', async () => {
    captcha.provider = 'recaptcha';
    for (const path of ['/home', '/register', '/lobby']) {
      const csp = await directives(path);
      expect(csp.get('script-src'), path).toContain('https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/');
      expect(csp.get('frame-src'), path).toBe(`${BASE_FRAME} https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/`);
      expect(csp.get('connect-src'), path).toContain('https://www.google.com/recaptcha/');
      expect(csp.get('script-src'), path).not.toContain('cloudflare');
    }
  });

  it('leaves API routes and static files alone — they do not even look the provider up', async () => {
    captcha.provider = 'turnstile';
    for (const path of ['/api/auth/login', '/api/auth/captcha', '/api', '/manifest.webmanifest', '/icons/logo.svg', '/_next/data/x.json']) {
      const csp = await directives(path);
      expect(csp.get('script-src'), path).not.toContain(CLOUDFLARE);
      expect(csp.get('frame-src'), path).toBe(BASE_FRAME);
    }
    expect(captcha.lookups).toBe(0);
  });

  it('adds nothing while the external provider is misconfigured (it serves ALTCHA then)', async () => {
    captcha.provider = 'turnstile';
    captcha.keys = false;
    const csp = await directives('/login');
    expect(csp.get('script-src')).not.toContain(CLOUDFLARE);
    expect(csp.get('frame-src')).toBe(BASE_FRAME);
  });
});
