import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { buildGuestSessionCookie } from '@/lib/guest-session';

/**
 * withApiSecurity slides the session (lib/session-refresh.ts): a request
 * that passed the revocation check gets a re-signed cookie once its cookie
 * is past half its lifetime. A revoked session gets a 401 and nothing new;
 * the sign-in routes that bypass the revocation check handle the cookie
 * themselves.
 */

const revoked = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/session-tracker', () => ({
  isSessionRevoked: async () => revoked.value,
}));
vi.mock('@/lib/maintenance-guard', () => ({ maintenanceResponseForRequest: async () => null }));

const SECRET = 'q'.repeat(40);
const DAY = 24 * 60 * 60;

function request(daysAgo: number): Request {
  const now = Math.floor(Date.now() / 1000);
  const signed = buildGuestSessionCookie(
    { gid: 'g_' + 'c'.repeat(32), uid: '33333333-3333-4333-8333-333333333333', name: 'Deniz' },
    SECRET,
    { now: now - daysAgo * DAY }
  );
  return new Request('https://chat.example.test/api/thing', {
    method: 'GET',
    headers: { cookie: signed.setCookieHeader.split(';')[0]! },
  });
}

const setsSession = (res: Response) => res.headers.getSetCookie().some((c) => c.startsWith('lf_guest='));

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  revoked.value = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withApiSecurity and the sliding session', () => {
  it('re-signs a cookie past half its lifetime, and leaves a fresh one alone', async () => {
    const { withApiSecurity } = await import('../security-headers');
    const handler = withApiSecurity(async () => NextResponse.json({ ok: true }), { allowedMethods: ['GET'] });
    expect(setsSession(await handler(request(4), undefined))).toBe(true);
    expect(setsSession(await handler(request(0), undefined))).toBe(false);
  });

  it('gives a revoked session a 401 and no new cookie', async () => {
    revoked.value = true;
    const { withApiSecurity } = await import('../security-headers');
    const handler = withApiSecurity(async () => NextResponse.json({ ok: true }), { allowedMethods: ['GET'] });
    const res = await handler(request(4), undefined);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('lf_guest=') && !c.includes('Max-Age=0'))).toBe(false);
  });

  it('does not refresh on the routes that bypass the revocation check (sign-in, guest, logout)', async () => {
    const { withApiSecurity } = await import('../security-headers');
    const handler = withApiSecurity(async () => NextResponse.json({ ok: true }), {
      allowedMethods: ['GET'],
      sessionRevocation: 'bypass',
    });
    expect(setsSession(await handler(request(4), undefined))).toBe(false);
  });
});
