import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@/lib/guest-session';

/**
 * The request proxy slides the session on page loads (lib/session-refresh.ts),
 * and never on API routes: those refresh in withApiSecurity, which sees the
 * answer (a sign-out must keep its cleared cookie).
 */

// The proxy also reads the CAPTCHA settings for pages: no database here.
vi.mock('@/lib/captcha/settings', () => ({
  resolveCaptchaSettings: async () => ({ provider: 'altcha', keys: true }),
  captchaSettingsSnapshot: () => ({ lastGood: null, fresh: false }),
  readCaptchaEnvOverrides: () => ({ provider: null, invalidProvider: null, siteKey: null, secretKey: null }),
  externalProviderConfigured: () => false,
}));

const SECRET = 'p'.repeat(40);
const DAY = 24 * 60 * 60;

function cookieIssuedDaysAgo(days: number): string {
  const now = Math.floor(Date.now() / 1000);
  const signed = buildGuestSessionCookie(
    { gid: 'g_' + 'b'.repeat(32), uid: '22222222-2222-4222-8222-222222222222', name: 'Can' },
    SECRET,
    { now: now - days * DAY }
  );
  return signed.setCookieHeader.split(';')[0]!;
}

async function run(path: string, cookie: string) {
  const { NextRequest } = await import('next/server');
  const { proxy } = await import('../../proxy');
  return proxy(new NextRequest(`https://chat.example.test${path}`, { headers: { cookie } }));
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the proxy slides the session on page loads', () => {
  it('re-signs a cookie past half its lifetime on a page', async () => {
    const response = await run('/lobby', cookieIssuedDaysAgo(4));
    expect(response.headers.getSetCookie().some((c) => c.startsWith('lf_guest='))).toBe(true);
  });

  it('leaves a fresh cookie alone', async () => {
    const response = await run('/lobby', cookieIssuedDaysAgo(0));
    expect(response.headers.getSetCookie().some((c) => c.startsWith('lf_guest='))).toBe(false);
  });

  it('never touches the cookie on an API route', async () => {
    const response = await run('/api/auth/logout', cookieIssuedDaysAgo(4));
    expect(response.headers.getSetCookie().some((c) => c.startsWith('lf_guest='))).toBe(false);
  });
});
