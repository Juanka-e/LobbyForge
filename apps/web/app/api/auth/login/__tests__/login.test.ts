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
// Bot protection has its own suites (lib/captcha/__tests__); here the guard
// is a spy that lets everything through unless a test says otherwise.
const { guardSignInCaptcha, noteSignInFailure } = vi.hoisted(() => ({ guardSignInCaptcha: vi.fn(), noteSignInFailure: vi.fn() }));
vi.mock('@/lib/captcha/guard', () => ({ guardSignInCaptcha, noteSignInFailure }));
// The per-account limiter has its own tests (lib/__tests__/auth-throttle.test.ts
// and the account-limit route tests). Here it always allows: under
// NODE_ENV=production it would otherwise reach for Redis, which CI lacks.
const { deviceSignInPathOpen } = vi.hoisted(() => ({ deviceSignInPathOpen: vi.fn() }));
vi.mock('@/lib/auth-throttle', () => ({
  beginSignInAttempt: async () => ({ allowed: true, path: 'account' }),
  confirmSignInDevice: async (_subject: unknown, attempt: unknown) => attempt,
  finishSignInAttempt: async () => undefined,
  accountLockedResponse: () => new Response(null, { status: 429 }),
  // Is the device's own failure bucket still below its limit?
  deviceSignInPathOpen,
}));

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(32);
  getUserCredentialsByEmail.mockReset();
  verifyPassword.mockReset();
  recordSession.mockReset().mockResolvedValue(undefined);
  guardSignInCaptcha.mockReset().mockResolvedValue(null);
  noteSignInFailure.mockReset().mockResolvedValue(undefined);
  deviceSignInPathOpen.mockReset().mockResolvedValue(true);
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

// Bot protection (docs/CAPTCHA.md §2): adaptive sign-in. The guard runs
// after the zod parse and BEFORE the attempt is counted or the account is
// looked up; a wrong password feeds the address / attack-mode signals.
describe('POST /api/auth/login — bot protection', () => {
  const USER = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'owner@example.com',
    displayName: 'Owner',
    passwordHash: 'stored-hash',
    deletedAt: null,
  };

  it('asks the sign-in guard with the email, the body’s captcha fields and no device claim', async () => {
    getUserCredentialsByEmail.mockResolvedValue(USER);
    verifyPassword.mockResolvedValue(true);
    const res = await post({ email: 'OWNER@example.com', password: 'pw', captchaToken: 'tok', captchaProvider: 'recaptcha', website: '' });
    expect(res.status).toBe(200);
    expect(guardSignInCaptcha).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ captchaToken: 'tok', captchaProvider: 'recaptcha' }),
      { email: 'owner@example.com', hasDeviceClaim: false }
    );
  });

  async function postWithCookie(cookie: string) {
    const { POST } = await import('../route.js');
    return POST(
      new Request('https://example.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ email: USER.email, password: 'pw' }),
      }),
      {}
    );
  }

  async function deviceCookie(passwordHash = USER.passwordHash): Promise<string> {
    const { buildDeviceCookie } = await import('@/lib/device-cookie');
    return buildDeviceCookie(null, USER.email, passwordHash)!.split(';', 1)[0]!;
  }

  it('a trusted device for the account (claim holds, bucket open) skips the challenge — one lookup, reused', async () => {
    getUserCredentialsByEmail.mockResolvedValue(USER);
    verifyPassword.mockResolvedValue(true);
    expect((await postWithCookie(await deviceCookie())).status).toBe(200);
    expect(guardSignInCaptcha).toHaveBeenCalledWith(expect.any(Request), expect.anything(), { email: USER.email, hasDeviceClaim: true });
    expect(getUserCredentialsByEmail).toHaveBeenCalledTimes(1);
  });

  it('a stale device cookie (issued before a password change) does NOT skip the challenge', async () => {
    getUserCredentialsByEmail.mockResolvedValue(USER); // current hash: stored-hash
    verifyPassword.mockResolvedValue(true);
    await postWithCookie(await deviceCookie('the-old-password-hash'));
    expect(guardSignInCaptcha).toHaveBeenCalledWith(expect.any(Request), expect.anything(), { email: USER.email, hasDeviceClaim: false });
  });

  it('a device whose own failure bucket tripped does NOT skip the challenge — and is not even looked up first', async () => {
    deviceSignInPathOpen.mockResolvedValue(false);
    getUserCredentialsByEmail.mockResolvedValue(USER);
    guardSignInCaptcha.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'captcha_required' }), { status: 400 }));
    expect((await postWithCookie(await deviceCookie())).status).toBe(400);
    expect(guardSignInCaptcha).toHaveBeenCalledWith(expect.any(Request), expect.anything(), { email: USER.email, hasDeviceClaim: false });
    expect(getUserCredentialsByEmail).not.toHaveBeenCalled();
  });

  it('a device cookie for a deleted account does not count', async () => {
    getUserCredentialsByEmail.mockResolvedValue({ ...USER, deletedAt: new Date() });
    verifyPassword.mockResolvedValue(true);
    await postWithCookie(await deviceCookie());
    expect(guardSignInCaptcha).toHaveBeenCalledWith(expect.any(Request), expect.anything(), { email: USER.email, hasDeviceClaim: false });
  });

  it('a refusal comes back before the lookup or the password check', async () => {
    for (const error of ['captcha_required', 'captcha_invalid', 'captcha_unavailable', 'form_rejected']) {
      guardSignInCaptcha.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: 400 }));
      const res = await post({ email: USER.email, password: 'pw' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(getUserCredentialsByEmail).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('a wrong password feeds the sign-in failure signals; a right one does not', async () => {
    getUserCredentialsByEmail.mockResolvedValue(USER);
    verifyPassword.mockResolvedValue(false);
    expect((await post({ email: USER.email, password: 'bad' })).status).toBe(401);
    expect(noteSignInFailure).toHaveBeenCalledTimes(1);
    verifyPassword.mockResolvedValue(true);
    expect((await post({ email: USER.email, password: 'pw' })).status).toBe(200);
    expect(noteSignInFailure).toHaveBeenCalledTimes(1);
  });

  it('validates the captcha fields like every protected route', async () => {
    expect((await post({ email: USER.email, password: 'pw', captchaToken: 'x'.repeat(4097) })).status).toBe(400);
    expect((await post({ email: USER.email, password: 'pw', captchaProvider: 'hcaptcha' })).status).toBe(400);
    expect(guardSignInCaptcha).not.toHaveBeenCalled();
  });
});
