import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const findOrCreateGuestUser = vi.fn();
const authorizeGuestRegistration = vi.fn();
const isSessionRevoked = vi.fn();
const recordSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({ findOrCreateGuestUser }));
vi.mock('@/lib/instance-access', () => ({ authorizeGuestRegistration }));
vi.mock('@/lib/session-tracker', () => ({
  isSessionRevoked,
  recordSession,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

async function loadRoute() {
  return import('../route.js');
}

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  findOrCreateGuestUser.mockReset();
  authorizeGuestRegistration.mockReset();
  isSessionRevoked.mockReset();
  recordSession.mockReset();
  // Defaults: registration allowed, no prior session.
  authorizeGuestRegistration.mockResolvedValue({ ok: true });
  isSessionRevoked.mockResolvedValue(false);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeCookie(uid: string | null = '00000000-0000-0000-0000-000000000001'): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

describe('POST /api/auth/guest', () => {
  it('creates a new guest session and sets a cookie when no prior session exists', async () => {
    findOrCreateGuestUser.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000002', displayName: 'Guest ABCD' });
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/auth/guest', { method: 'POST', body: JSON.stringify({}) }),
      {}
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('lf_guest=');
    expect(findOrCreateGuestUser).toHaveBeenCalled();
  });

  it('returns 400 when displayNameSeed is too long', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/auth/guest', {
        method: 'POST',
        body: JSON.stringify({ displayNameSeed: 'x'.repeat(200) }),
      }),
      {}
    );
    expect(res.status).toBe(400);
  });

  it('returns the access-policy status when registration is denied', async () => {
    authorizeGuestRegistration.mockResolvedValue({ ok: false, status: 403, error: 'Invite code required' });
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/auth/guest', { method: 'POST', body: JSON.stringify({}) }),
      {}
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Invite code required');
  });

  it('returns 503 when the access policy lookup throws', async () => {
    authorizeGuestRegistration.mockRejectedValue(new Error('db down'));
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/auth/guest', { method: 'POST', body: JSON.stringify({}) }),
      {}
    );
    expect(res.status).toBe(503);
  });
});

describe('GET /api/auth/guest', () => {
  it('returns the current guest session when a valid cookie is present', async () => {
    const { GET } = await loadRoute();
    const res = await GET(
      new Request('https://example.test/api/auth/guest', { headers: { cookie: makeCookie() } }),
      {}
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { guest: { uid: string } };
    expect(json.guest.uid).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('returns 401 when no cookie is present', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/auth/guest'), {});
    expect(res.status).toBe(401);
  });
});

// Security follow-up (absolute session lifetime): the refresh route used to
// extend a session forever. It now keeps the session's auth_time, never
// signs past auth_time + the lifetime, and does not refresh an over-age
// session at all.
describe('POST /api/auth/guest — absolute session lifetime', () => {
  const DAY = 24 * 60 * 60;
  const USER_ID = '00000000-0000-0000-0000-000000000001';
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  function cookieStartedDaysAgo(days: number): string {
    const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: USER_ID, name: 'Owner' };
    return `lf_guest=${buildGuestSessionCookie(identity, SECRET, { authTime: nowSeconds() - days * DAY }).raw}`;
  }

  async function refresh(cookie?: string) {
    const { POST } = await loadRoute();
    return POST(
      new Request('https://example.test/api/auth/guest', {
        method: 'POST',
        headers: cookie ? { cookie } : {},
        body: JSON.stringify({}),
      }),
      {}
    );
  }

  async function sessionOf(res: Response) {
    const { readGuestSession } = await import('@/lib/guest-session');
    return readGuestSession(res.headers.get('set-cookie')?.split(';', 1)[0] ?? null, SECRET);
  }

  it('a refresh keeps the original auth_time and records it', async () => {
    const res = await refresh(cookieStartedDaysAgo(3));
    expect(res.status).toBe(200);
    const session = await sessionOf(res);
    expect(session?.gid).toBe('g_'.padEnd(34, 'a'));
    expect(session?.uid).toBe(USER_ID);
    expect(session?.auth_time).toBeLessThanOrEqual(nowSeconds() - 3 * DAY);
    expect(session?.auth_time).toBeGreaterThan(nowSeconds() - 3 * DAY - 5);
    expect(recordSession).toHaveBeenCalledWith(USER_ID, session?.gid, expect.any(Request), {
      authTime: session?.auth_time,
    });
    expect(findOrCreateGuestUser).not.toHaveBeenCalled();
  });

  it('near the limit the refreshed cookie expires at the limit, not an hour later', async () => {
    const res = await refresh(cookieStartedDaysAgo(30 - 1 / 144)); // ten minutes left
    const session = await sessionOf(res);
    expect(session).not.toBeNull();
    expect(session!.exp).toBe(session!.auth_time! + 30 * DAY);
    const json = (await res.json()) as { guest: { ttlSeconds: number } };
    expect(json.guest.ttlSeconds).toBeLessThanOrEqual(600);
    expect(json.guest.ttlSeconds).toBeGreaterThan(590);
  });

  it('an over-age session is not refreshed — the request gets a NEW guest identity', async () => {
    findOrCreateGuestUser.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000009', displayName: 'Guest beef' });
    const res = await refresh(cookieStartedDaysAgo(31));
    expect(res.status).toBe(200);
    const session = await sessionOf(res);
    expect(session?.gid).not.toBe('g_'.padEnd(34, 'a'));
    expect(session?.uid).toBe('00000000-0000-0000-0000-000000000009');
    expect(session?.auth_time).toBeGreaterThan(nowSeconds() - 5);
    // Treated like a request without a session, for the access policy too.
    expect(authorizeGuestRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ existingUserId: undefined }));
    expect(isSessionRevoked).not.toHaveBeenCalled();
  });

  it('an over-age session is refused outright when guests are not allowed', async () => {
    authorizeGuestRegistration.mockResolvedValue({ ok: false, status: 403, error: 'Guest access is disabled' });
    const res = await refresh(cookieStartedDaysAgo(31));
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('honours LOBBYFORGE_SESSION_MAX_AGE_DAYS', async () => {
    process.env.LOBBYFORGE_SESSION_MAX_AGE_DAYS = '2';
    findOrCreateGuestUser.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000009', displayName: 'Guest beef' });
    const res = await refresh(cookieStartedDaysAgo(3));
    expect((await sessionOf(res))?.gid).not.toBe('g_'.padEnd(34, 'a'));
  });

  it('a legacy cookie without auth_time is refreshed and its clock starts now', async () => {
    const { signSessionCookie } = await import('@lobbyforge/core');
    const now = nowSeconds();
    const legacy = signSessionCookie(
      { gid: 'g_'.padEnd(34, 'a'), uid: USER_ID, name: 'Owner', iat: now - 60, exp: now + 3540 },
      { name: 'lf_guest', secret: SECRET, maxAgeSeconds: 3600 }
    );
    const res = await refresh(`lf_guest=${legacy.raw}`);
    const session = await sessionOf(res);
    expect(session?.gid).toBe('g_'.padEnd(34, 'a'));
    expect(session?.auth_time).toBeGreaterThanOrEqual(now);
  });
});
