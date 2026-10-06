import { beforeEach, describe, expect, it, vi } from 'vitest';

const createLocalAccount = vi.fn();
const getEffectiveInstanceAccessSettings = vi.fn();
const getInstanceBootstrapStatus = vi.fn();
const getInviteMetadata = vi.fn();
const getServerAccessPolicy = vi.fn();
const hashPassword = vi.fn();
const recordSession = vi.fn();
const isOfficialDeployment = vi.fn();
const createOfficialAccount = vi.fn();

vi.mock('@lobbyforge/db', async () => {
  const actual = await vi.importActual<typeof import('@lobbyforge/db')>('@lobbyforge/db');
  return {
    createLocalAccount,
    getEffectiveInstanceAccessSettings,
    getInstanceBootstrapStatus,
    getInviteMetadata,
    getServerAccessPolicy,
    // The real server-policy check: these tests pin what it refuses.
    serverPolicyRegistrationRefusal: actual.serverPolicyRegistrationRefusal,
  };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({ hashPassword }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment }));
vi.mock('@/lib/official-account', () => ({ createOfficialAccount }));
vi.mock('@/lib/session-tracker', () => ({ recordSession }));
vi.mock('@/lib/api-auth', () => ({ getSessionSecret: () => 'x'.repeat(32) }));
vi.mock('@/lib/guest-session', () => ({
  createGuestIdentity: () => ({ gid: `g_${'a'.repeat(32)}`, uid: null, name: 'Guest' }),
  buildGuestSessionCookie: () => ({ setCookieHeader: 'lf_guest=signed; HttpOnly; SameSite=Lax' }),
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
// Bot protection has its own suites (lib/captcha/__tests__); here the guard
// is a spy that lets everything through unless a test says otherwise.
const guardCaptchaSurface = vi.fn();
vi.mock('@/lib/captcha/guard', () => ({ guardCaptchaSurface }));

const validBody = {
  email: 'member@example.com',
  displayName: 'Member',
  password: 'long password 42!',
};

beforeEach(() => {
  createLocalAccount.mockReset();
  getEffectiveInstanceAccessSettings.mockReset();
  getInstanceBootstrapStatus.mockReset();
  getInviteMetadata.mockReset();
  getServerAccessPolicy.mockReset();
  hashPassword.mockReset();
  recordSession.mockReset();
  isOfficialDeployment.mockReset();
  isOfficialDeployment.mockReturnValue(false);
  createOfficialAccount.mockReset();
  createOfficialAccount.mockResolvedValue({
    ok: true,
    user: { id: 'official-user-id', email: validBody.email, displayName: validBody.displayName },
  });
  getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'open' });
  getInstanceBootstrapStatus.mockResolvedValue({ bootstrapComplete: true, firstServerId: 'server-id' });
  getInviteMetadata.mockResolvedValue({ serverId: 'server-id', isExpired: false, isExhausted: false });
  getServerAccessPolicy.mockResolvedValue(null);
  hashPassword.mockResolvedValue('scrypt$hash');
  createLocalAccount.mockResolvedValue({
    ok: true,
    user: { id: 'user-id', email: validBody.email, displayName: validBody.displayName },
    serverId: 'server-id',
  });
  recordSession.mockResolvedValue(undefined);
  guardCaptchaSurface.mockReset().mockResolvedValue(null);
});

async function post(body: unknown) {
  const { POST } = await import('../route.js');
  return POST(new Request('https://community.example/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), {});
}

// The first test pays the route's cold import, which can pass 5 s when the
// whole suite runs in parallel.
describe('POST /api/auth/register', { timeout: 20_000 }, () => {
  it('creates an open-registration account and issues a session', async () => {
    const response = await post(validBody);
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(createLocalAccount).toHaveBeenCalledWith(
      { __test: true },
      {
        email: validBody.email,
        displayName: validBody.displayName,
        passwordHash: 'scrypt$hash',
        serverId: 'server-id',
        signupChannel: 'open',
      }
    );
  });

  it('requires an invite before hashing in invite-only mode', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'invite_only' });
    const response = await post(validBody);
    expect(response.status).toBe(400);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('normalizes and redeems an invite for local registration', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'invite_only' });
    const response = await post({ ...validBody, inviteCode: 'abcd2345efgh' });
    expect(response.status).toBe(201);
    expect(createLocalAccount).toHaveBeenCalledWith(
      { __test: true },
      expect.objectContaining({ inviteCode: 'ABCD2345EFGH', signupChannel: 'invite' })
    );
  });

  it('uses a uniform response for an unavailable invite before hashing', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'invite_only' });
    getInviteMetadata.mockResolvedValue(null);
    const response = await post({ ...validBody, inviteCode: 'abcd2345efgh' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Invite is unavailable.' });
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('rejects closed registration before hashing', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'closed' });
    const response = await post(validBody);
    expect(response.status).toBe(403);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('enforces an explicit server policy before hashing a password', async () => {
    getServerAccessPolicy.mockResolvedValue({
      joinPolicy: 'public_self_register',
      localAccount: 'existing_local_users_only',
      accountLinking: 'allow_link',
      requireApprovalForFirstJoin: false,
    });
    const response = await post(validBody);
    expect(response.status).toBe(403);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('requires an invite when an explicit server policy is invite-only', async () => {
    getServerAccessPolicy.mockResolvedValue({
      joinPolicy: 'invite_only',
      localAccount: 'allow_local_email_password',
      accountLinking: 'allow_link',
      requireApprovalForFirstJoin: false,
    });
    const response = await post(validBody);
    expect(response.status).toBe(403);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('refuses registration under a first-join approval policy (joins go through the queue)', async () => {
    getServerAccessPolicy.mockResolvedValue({
      joinPolicy: 'public_self_register',
      localAccount: 'allow_local_email_password',
      accountLinking: 'require_admin_approval_first_join',
      requireApprovalForFirstJoin: true,
    });
    const response = await post(validBody);
    expect(response.status).toBe(403);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('returns conflict for an existing email', async () => {
    createLocalAccount.mockResolvedValue({ ok: false, error: 'email_exists' });
    const response = await post(validBody);
    expect(response.status).toBe(409);
  });

  describe('on the official hub', () => {
    beforeEach(() => {
      isOfficialDeployment.mockReturnValue(true);
    });

    it('creates an account that joins no community, and signs it in', async () => {
      const response = await post(validBody);
      expect(response.status).toBe(201);
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
      expect(await response.json()).toEqual({
        user: { id: 'official-user-id', email: validBody.email, displayName: validBody.displayName },
      });
      expect(createOfficialAccount).toHaveBeenCalledWith(
        { __test: true },
        { email: validBody.email, displayName: validBody.displayName, passwordHash: 'scrypt$hash', signupChannel: 'open' }
      );
      expect(recordSession).toHaveBeenCalledWith('official-user-id', expect.stringMatching(/^g_/), expect.any(Request));
      // No self-host community machinery: no policy, no first server, no membership.
      expect(getEffectiveInstanceAccessSettings).not.toHaveBeenCalled();
      expect(getInstanceBootstrapStatus).not.toHaveBeenCalled();
      expect(createLocalAccount).not.toHaveBeenCalled();
    });

    it('returns conflict for an address that already has an account', async () => {
      createOfficialAccount.mockResolvedValue({ ok: false, error: 'email_exists' });
      const response = await post(validBody);
      expect(response.status).toBe(409);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('validates the payload the same way before hashing', async () => {
      const response = await post({ ...validBody, password: 'too short' });
      expect(response.status).toBe(400);
      expect(hashPassword).not.toHaveBeenCalled();
      expect(createOfficialAccount).not.toHaveBeenCalled();
    });

    it('does not redeem invite codes at sign-up', async () => {
      const response = await post({ ...validBody, inviteCode: 'abcd2345efgh' });
      expect(response.status).toBe(400);
      expect(hashPassword).not.toHaveBeenCalled();
      expect(createOfficialAccount).not.toHaveBeenCalled();
    });
  });
});

// Bot protection (docs/CAPTCHA.md §2, §4.4): the surface depends on the
// invite, the registration mode goes along (an invite can only ADD
// protection — the real rule is pinned in register-captcha.test.ts), the
// official hub always uses `register`, and a refusal stops the request
// before any account work or password hashing.
describe('POST /api/auth/register — bot protection', { timeout: 20_000 }, () => {
  it('without an invite: the register surface, with the body’s captcha fields and the registration mode', async () => {
    const body = { ...validBody, captchaToken: 'tok', captchaProvider: 'turnstile', formToken: 'ft', website: '' };
    expect((await post(body)).status).toBe(201);
    expect(guardCaptchaSurface).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ captchaToken: 'tok', formToken: 'ft' }),
      'register',
      { registrationMode: 'open' }
    );
  });

  it('with an invite: the invite_register surface — and the mode, so an open instance cannot be downgraded', async () => {
    await post({ ...validBody, inviteCode: 'abcd2345efgh' });
    expect(guardCaptchaSurface).toHaveBeenCalledWith(expect.any(Request), expect.anything(), 'invite_register', { registrationMode: 'open' });
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'invite_only' });
    await post({ ...validBody, inviteCode: 'abcd2345efgh' });
    expect(guardCaptchaSurface).toHaveBeenLastCalledWith(expect.any(Request), expect.anything(), 'invite_register', {
      registrationMode: 'invite_only',
    });
  });

  it('a closed instance answers 403 without asking for a challenge', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'closed' });
    expect((await post({ ...validBody, inviteCode: 'abcd2345efgh' })).status).toBe(403);
    expect(guardCaptchaSurface).not.toHaveBeenCalled();
  });

  it('the official hub always uses register', async () => {
    isOfficialDeployment.mockReturnValue(true);
    await post(validBody);
    expect(guardCaptchaSurface).toHaveBeenCalledWith(expect.any(Request), expect.anything(), 'register');
    expect(createOfficialAccount).toHaveBeenCalled();
    guardCaptchaSurface.mockClear();
    await post({ ...validBody, inviteCode: 'abcd2345efgh' });
    expect(guardCaptchaSurface).toHaveBeenCalledWith(expect.any(Request), expect.anything(), 'register');
    expect(getEffectiveInstanceAccessSettings).not.toHaveBeenCalled();
  });

  it('a refusal comes back as is — before invite lookups, hashing or account creation', async () => {
    for (const error of ['captcha_required', 'captcha_invalid', 'captcha_unavailable', 'form_rejected']) {
      guardCaptchaSurface.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: 400 }));
      const response = await post({ ...validBody, inviteCode: 'abcd2345efgh' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
    isOfficialDeployment.mockReturnValue(true);
    guardCaptchaSurface.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'captcha_required' }), { status: 400 }));
    expect((await post(validBody)).status).toBe(400);
    expect(getInviteMetadata).not.toHaveBeenCalled();
    expect(getInstanceBootstrapStatus).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(createLocalAccount).not.toHaveBeenCalled();
    expect(createOfficialAccount).not.toHaveBeenCalled();
  });

  it('keeps the schema strict: only the contract’s fields are added', async () => {
    expect((await post({ ...validBody, captchaToken: 'x'.repeat(4097) })).status).toBe(400);
    expect((await post({ ...validBody, captchaProvider: 'none' })).status).toBe(400);
    expect((await post({ ...validBody, recaptcha: 'x' })).status).toBe(400);
    expect(guardCaptchaSurface).not.toHaveBeenCalled();
  });
});
