import { beforeEach, describe, expect, it, vi } from 'vitest';

const createLocalAccount = vi.fn();
const getEffectiveInstanceAccessSettings = vi.fn();
const getInstanceBootstrapStatus = vi.fn();
const getInviteMetadata = vi.fn();
const getServerAccessPolicy = vi.fn();
const hashPassword = vi.fn();
const recordSession = vi.fn();
const isOfficialDeployment = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  createLocalAccount,
  getEffectiveInstanceAccessSettings,
  getInstanceBootstrapStatus,
  getInviteMetadata,
  getServerAccessPolicy,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({ hashPassword }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment }));
vi.mock('@/lib/session-tracker', () => ({ recordSession }));
vi.mock('@/lib/api-auth', () => ({ getSessionSecret: () => 'x'.repeat(32) }));
vi.mock('@/lib/guest-session', () => ({
  createGuestIdentity: () => ({ gid: `g_${'a'.repeat(32)}`, uid: null, name: 'Guest' }),
  buildGuestSessionCookie: () => ({ setCookieHeader: 'lf_guest=signed; HttpOnly; SameSite=Lax' }),
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

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
});

async function post(body: unknown) {
  const { POST } = await import('../route.js');
  return POST(new Request('https://community.example/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), {});
}

describe('POST /api/auth/register', () => {
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
      expect.objectContaining({ inviteCode: 'ABCD2345EFGH' })
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

  it('fails closed while first-join approval has no approval queue', async () => {
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

  it('does not expose local registration on official deployment', async () => {
    isOfficialDeployment.mockReturnValue(true);
    const response = await post(validBody);
    expect(response.status).toBe(404);
    expect(getEffectiveInstanceAccessSettings).not.toHaveBeenCalled();
  });
});
