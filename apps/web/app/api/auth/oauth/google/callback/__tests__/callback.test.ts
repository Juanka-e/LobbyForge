import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/auth/oauth/google/callback
 *
 * beta-review:
 *  - NEW-account creation honours the self-host access policy
 *    (registrationMode + guestAccessEnabled — OAuth accounts are guest
 *    rows); already-linked accounts sign in as before; the official hub
 *    keeps open OAuth sign-up.
 *  - (S7) every session minted here is recorded before the cookie is
 *    handed out, so a password change can revoke it.
 */

const dbFns = {
  getIdentityLinkByProviderSubject: vi.fn(),
  createUserIdentityLink: vi.fn(),
  touchUserIdentityLink: vi.fn(),
  listUserIdentityLinks: vi.fn(),
  findOrCreateGuestUser: vi.fn(),
  getEffectiveInstanceAccessSettings: vi.fn(),
  getInviteMetadata: vi.fn(),
};
vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const exchangeGoogleCode = vi.fn();
vi.mock('@/lib/oauth-google', () => ({
  isGoogleOAuthConfigured: () => true,
  exchangeGoogleCode: (...args: unknown[]) => exchangeGoogleCode(...args),
}));
const isOfficialDeployment = vi.fn();
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => isOfficialDeployment() }));
const recordSession = vi.fn();
vi.mock('@/lib/session-tracker', () => ({ recordSession }));

const SECRET = 'x'.repeat(32);
const STATE = 'ab'.repeat(16);
const NEW_USER_ID = '00000000-0000-0000-0000-0000000000a1';
const LINKED_USER_ID = '00000000-0000-0000-0000-0000000000b2';

function settings(overrides: Partial<{ registrationMode: string; guestAccessEnabled: boolean }> = {}) {
  return {
    instanceId: 'self-host',
    registrationMode: 'open',
    guestAccessEnabled: true,
    seoIndexingEnabled: false,
    seoTitle: null,
    seoDescription: null,
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  exchangeGoogleCode.mockReset().mockResolvedValue({
    sub: 'google-sub-1',
    email: 'someone@example.com',
    emailVerified: true,
    name: 'Someone',
    picture: null,
  });
  isOfficialDeployment.mockReset().mockReturnValue(false);
  recordSession.mockReset().mockResolvedValue(undefined);
  dbFns.getIdentityLinkByProviderSubject.mockResolvedValue(null);
  dbFns.findOrCreateGuestUser.mockResolvedValue({ id: NEW_USER_ID, displayName: 'Someone' });
  dbFns.createUserIdentityLink.mockResolvedValue({ id: 'link-1', userId: NEW_USER_ID });
  dbFns.touchUserIdentityLink.mockResolvedValue(undefined);
  dbFns.getEffectiveInstanceAccessSettings.mockResolvedValue(settings());
});

async function callback(): Promise<Response> {
  const { GET } = await import('../route.js');
  return GET(
    new Request(`https://community.example/api/auth/oauth/google/callback?code=abc&state=${STATE}`, {
      headers: { cookie: `lf_oauth_state=${STATE}; lf_oauth_redirect=%2Flobby` },
    }),
    {}
  );
}

describe('OAuth callback — beta-review: new accounts honour the instance access policy', () => {
  it('open self-host: creates the account, links it and signs in', async () => {
    const res = await callback();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://community.example/lobby');
    expect(dbFns.findOrCreateGuestUser).toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toContain('lf_guest=');
  });

  it.each([
    ['closed registration', settings({ registrationMode: 'closed' })],
    ['invite-only registration (no invite flow in OAuth)', settings({ registrationMode: 'invite_only' })],
    ['guest access disabled (OAuth accounts are guest rows)', settings({ guestAccessEnabled: false })],
  ])('refuses a NEW account under %s', async (_label, value) => {
    dbFns.getEffectiveInstanceAccessSettings.mockResolvedValue(value);
    const res = await callback();
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://community.example/login?error=registration_closed');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('lf_guest=');
    expect(dbFns.findOrCreateGuestUser).not.toHaveBeenCalled();
    expect(dbFns.createUserIdentityLink).not.toHaveBeenCalled();
    expect(recordSession).not.toHaveBeenCalled();
  });

  it('an already-linked account still signs in on an invite-only instance', async () => {
    dbFns.getEffectiveInstanceAccessSettings.mockResolvedValue(settings({ registrationMode: 'invite_only' }));
    dbFns.getIdentityLinkByProviderSubject.mockResolvedValue({ id: 'link-9', userId: LINKED_USER_ID });
    const res = await callback();
    expect(res.headers.get('location')).toBe('https://community.example/lobby');
    expect(res.headers.get('set-cookie')).toContain('lf_guest=');
    expect(dbFns.findOrCreateGuestUser).not.toHaveBeenCalled();
  });

  it('the official hub keeps open OAuth sign-up (no instance policy there)', async () => {
    isOfficialDeployment.mockReturnValue(true);
    dbFns.getEffectiveInstanceAccessSettings.mockResolvedValue(settings({ registrationMode: 'invite_only' }));
    const res = await callback();
    expect(res.headers.get('location')).toBe('https://community.example/lobby');
    expect(dbFns.findOrCreateGuestUser).toHaveBeenCalled();
  });
});

describe('OAuth callback — beta-review S7 session tracking', () => {
  it('records the minted session under the cookie gid', async () => {
    dbFns.getIdentityLinkByProviderSubject.mockResolvedValue({ id: 'link-9', userId: LINKED_USER_ID });
    const res = await callback();
    const { readGuestSession } = await import('@/lib/guest-session');
    // Several Set-Cookie headers (the two OAuth cookie deletions + the
    // session) — pick the session cookie's name=value pair.
    const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith('lf_guest='));
    const session = readGuestSession(sessionCookie?.split(';')[0] ?? null, SECRET);
    expect(session?.uid).toBe(LINKED_USER_ID);
    expect(recordSession).toHaveBeenCalledWith(LINKED_USER_ID, session?.gid, expect.any(Request));
  });

  it('outside production a tracking failure only logs', async () => {
    recordSession.mockRejectedValue(new Error('redis down'));
    const res = await callback();
    expect(res.headers.get('location')).toBe('https://community.example/lobby');
    expect(res.headers.get('set-cookie')).toContain('lf_guest=');
  });

  it('in production an unrecorded session is never handed out', async () => {
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      recordSession.mockRejectedValue(new Error('redis down'));
      const res = await callback();
      expect(res.headers.get('location')).toBe('https://community.example/login?error=session_unavailable');
      expect(res.headers.get('set-cookie') ?? '').not.toContain('lf_guest=');
    } finally {
      env.NODE_ENV = previous;
    }
  });
});
