import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserCredentialsByEmail = vi.fn();
const verifyPassword = vi.fn();

vi.mock('@lobbyforge/db', () => ({ getUserCredentialsByEmail }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({
  DUMMY_PASSWORD_HASH: 'dummy-hash',
  verifyPassword,
}));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  resolveClientAddress: () => '203.0.113.7',
}));
const recordSession = vi.fn();
vi.mock('@/lib/session-tracker', () => ({ recordSession }));
// The per-account limiter has its own tests (lib/__tests__/auth-throttle.test.ts
// and the account-limit route tests). Here it always allows: under
// NODE_ENV=production it would otherwise reach for Redis, which CI lacks.
vi.mock('@/lib/auth-throttle', () => ({
  beginSignInAttempt: async () => ({ allowed: true, path: 'account' }),
  confirmSignInDevice: async (_subject: unknown, attempt: unknown) => attempt,
  finishSignInAttempt: async () => undefined,
  accountLockedResponse: () => new Response(null, { status: 429 }),
}));

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(32);
  getUserCredentialsByEmail.mockReset();
  verifyPassword.mockReset();
  recordSession.mockReset().mockResolvedValue(undefined);
});

async function post(body: unknown) {
  const { POST } = await import('../route.js');
  return POST(new Request('https://example.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), {});
}

describe('POST /api/auth/login', () => {
  it('returns the same generic error for an unknown account', async () => {
    getUserCredentialsByEmail.mockResolvedValue(null);
    verifyPassword.mockResolvedValue(false);
    const response = await post({ email: 'missing@example.com', password: 'not-the-password' });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid email or password.' });
    expect(verifyPassword).toHaveBeenCalledWith('not-the-password', 'dummy-hash');
  });

  it('issues an HttpOnly session for valid local credentials', async () => {
    getUserCredentialsByEmail.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      email: 'owner@example.com',
      displayName: 'Owner',
      passwordHash: 'stored-hash',
      deletedAt: null,
    });
    verifyPassword.mockResolvedValue(true);
    const response = await post({ email: 'OWNER@example.com', password: 'correct password' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('lf_guest=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });
});

// beta-review (S7): a password change revokes other sessions through
// revokeOtherSessions, which can only revoke sessions it can LIST — login
// never recorded its sessions, so an attacker who logged in with a stolen
// password survived the victim's password change.
describe('POST /api/auth/login — beta-review S7 session tracking', () => {
  const USER = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'owner@example.com',
    displayName: 'Owner',
    passwordHash: 'stored-hash',
    deletedAt: null,
  };

  it('records the minted session (awaited) under the cookie gid', async () => {
    getUserCredentialsByEmail.mockResolvedValue(USER);
    verifyPassword.mockResolvedValue(true);
    let recorded = false;
    recordSession.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      recorded = true;
    });
    const response = await post({ email: USER.email, password: 'correct password' });
    expect(response.status).toBe(200);
    expect(recorded).toBe(true); // resolved BEFORE the response was returned
    const { readGuestSession } = await import('@/lib/guest-session');
    const session = readGuestSession(response.headers.get('set-cookie'), 'x'.repeat(32));
    expect(recordSession).toHaveBeenCalledWith(USER.id, session?.gid, expect.any(Request));
  });

  it('outside production a tracking failure only logs', async () => {
    getUserCredentialsByEmail.mockResolvedValue(USER);
    verifyPassword.mockResolvedValue(true);
    recordSession.mockRejectedValue(new Error('redis down'));
    const response = await post({ email: USER.email, password: 'correct password' });
    expect(response.status).toBe(200);
  });

  it('in production an UNRECORDED (unrevocable) session is never handed out', async () => {
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      getUserCredentialsByEmail.mockResolvedValue(USER);
      verifyPassword.mockResolvedValue(true);
      recordSession.mockRejectedValue(new Error('redis down'));
      const response = await post({ email: USER.email, password: 'correct password' });
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      env.NODE_ENV = previous;
    }
  });

  it('in production the device cookie is Secure (and HttpOnly, SameSite=Lax, 180 days)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      getUserCredentialsByEmail.mockResolvedValue(USER);
      verifyPassword.mockResolvedValue(true);
      const response = await post({ email: USER.email, password: 'correct password' });
      expect(response.status).toBe(200);
      const cookies = response.headers.getSetCookie();
      const device = cookies.find((c) => c.startsWith('lf_device='));
      expect(device).toBeDefined();
      const flags = device!.split('; ').slice(1);
      expect(flags).toEqual(
        expect.arrayContaining(['Path=/', 'Max-Age=15552000', 'HttpOnly', 'SameSite=Lax', 'Secure'])
      );
      expect(cookies.find((c) => c.startsWith('lf_guest='))).toContain('Secure');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('failed logins record nothing', async () => {
    getUserCredentialsByEmail.mockResolvedValue(USER);
    verifyPassword.mockResolvedValue(false);
    const response = await post({ email: USER.email, password: 'wrong' });
    expect(response.status).toBe(401);
    expect(recordSession).not.toHaveBeenCalled();
  });
});
