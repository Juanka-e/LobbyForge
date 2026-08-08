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
