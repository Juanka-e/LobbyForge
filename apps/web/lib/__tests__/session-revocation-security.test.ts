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
