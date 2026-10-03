import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const readGuestSession = vi.fn();
const isSessionRevoked = vi.fn();

vi.mock('@/lib/guest-session', () => ({ readGuestSession }));
vi.mock('@/lib/session-tracker', () => ({ isSessionRevoked }));

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', 'x'.repeat(32));
  readGuestSession.mockReset();
  isSessionRevoked.mockReset();
  readGuestSession.mockReturnValue({
    uid: '00000000-0000-0000-0000-000000000001',
    gid: `g_${'a'.repeat(32)}`,
    name: 'Owner',
    iat: 1,
    exp: 9_999_999_999,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request() {
  return new Request('https://example.test/api/settings/me', {
    headers: { cookie: 'lf_guest=signed' },
  });
}

describe('central session revocation guard', () => {
  it('rejects a revoked session before the route handler runs', async () => {
    isSessionRevoked.mockResolvedValue(true);
    const route = vi.fn(async () => NextResponse.json({ ok: true }));
    const { withApiSecurity } = await import('../security-headers.js');
    const handler = withApiSecurity(route, { allowedMethods: ['GET'], maintenanceMode: 'bypass' });

    const response = await handler(request(), undefined);

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(route).not.toHaveBeenCalled();
  });

  it('allows auth endpoints to explicitly bypass the revocation guard', async () => {
    isSessionRevoked.mockResolvedValue(true);
    const route = vi.fn(async () => NextResponse.json({ ok: true }));
    const { withApiSecurity } = await import('../security-headers.js');
    const handler = withApiSecurity(route, {
      allowedMethods: ['GET'],
      maintenanceMode: 'bypass',
      sessionRevocation: 'bypass',
    });

    const response = await handler(request(), undefined);

    expect(response.status).toBe(200);
    expect(route).toHaveBeenCalledOnce();
    expect(isSessionRevoked).not.toHaveBeenCalled();
  });

  it('fails closed in production when revocation storage is unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    isSessionRevoked.mockRejectedValue(new Error('Redis unavailable'));
    const route = vi.fn(async () => NextResponse.json({ ok: true }));
    const { withApiSecurity } = await import('../security-headers.js');
    const handler = withApiSecurity(route, { allowedMethods: ['GET'], maintenanceMode: 'bypass' });

    const response = await handler(request(), undefined);

    expect(response.status).toBe(503);
    expect(route).not.toHaveBeenCalled();
  });
});

// security-review AUTH-002: readers disagree on which of two duplicate
// lf_guest cookies counts (readCookie: first, next/headers: last), so a
// request carrying two is refused before any of them is trusted.
describe('duplicate session cookie guard', () => {
  function requestWithCookie(cookie: string) {
    return new Request('https://example.test/api/admin/bandwidth', { headers: { cookie } });
  }

  it('rejects a request carrying two lf_guest cookies with 400', async () => {
    isSessionRevoked.mockResolvedValue(false);
    const route = vi.fn(async () => NextResponse.json({ ok: true }));
    const { withApiSecurity } = await import('../security-headers.js');
    const handler = withApiSecurity(route, { allowedMethods: ['GET'], maintenanceMode: 'bypass' });

    const response = await handler(requestWithCookie('lf_guest=valid; lf_guest=revoked'), undefined);

    expect(response.status).toBe(400);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects duplicates even on routes that bypass the revocation guard', async () => {
    const route = vi.fn(async () => NextResponse.json({ ok: true }));
    const { withApiSecurity } = await import('../security-headers.js');
    const handler = withApiSecurity(route, {
      allowedMethods: ['GET'],
      maintenanceMode: 'bypass',
      sessionRevocation: 'bypass',
    });

    const response = await handler(requestWithCookie('lf_guest=a;lf_guest=b'), undefined);

    expect(response.status).toBe(400);
    expect(route).not.toHaveBeenCalled();
  });

  it('counts only the exact cookie name', async () => {
    isSessionRevoked.mockResolvedValue(false);
    const route = vi.fn(async () => NextResponse.json({ ok: true }));
    const { withApiSecurity } = await import('../security-headers.js');
    const handler = withApiSecurity(route, { allowedMethods: ['GET'], maintenanceMode: 'bypass' });

    const response = await handler(
      requestWithCookie('xlf_guest=1; lf_guest_old=2; lf_guest=signed; theme=lf_guest=3'),
      undefined
    );

    expect(response.status).toBe(200);
    expect(route).toHaveBeenCalledOnce();
  });

  it('countCookies matches names exactly', async () => {
    const { countCookies } = await import('../security-headers.js');
    expect(countCookies(null, 'lf_guest')).toBe(0);
    expect(countCookies('lf_guest=a', 'lf_guest')).toBe(1);
    expect(countCookies('lf_guest=a; other=b;  lf_guest=c', 'lf_guest')).toBe(2);
    expect(countCookies('lf_guest_x=a; xlf_guest=b; =lf_guest', 'lf_guest')).toBe(0);
  });
});
