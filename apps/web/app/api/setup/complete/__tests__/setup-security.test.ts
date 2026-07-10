import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockSetupAlreadyCompleteError extends Error {}

const completeInitialBootstrap = vi.fn();
const getInstanceBootstrapStatus = vi.fn();
const hashPassword = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  completeInitialBootstrap,
  getInstanceBootstrapStatus,
  SetupAlreadyCompleteError: MockSetupAlreadyCompleteError,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({ hashPassword }));
vi.mock('@/lib/api-auth', () => ({ getSessionSecret: () => 'x'.repeat(32) }));
vi.mock('@/lib/guest-session', () => ({
  createGuestIdentity: () => ({ gid: `g_${'a'.repeat(32)}`, uid: null, name: 'Guest' }),
  buildGuestSessionCookie: () => ({ setCookieHeader: 'lf_guest=signed; HttpOnly; SameSite=Lax' }),
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const originalNodeEnv = process.env.NODE_ENV;
const originalSetupToken = process.env.LOBBYFORGE_SETUP_TOKEN;
const env = process.env as Record<string, string | undefined>;

const validBody = {
  setupToken: 'correct-setup-token-which-is-long',
  instanceName: 'Secure Community',
  ownerDisplayName: 'Owner',
  ownerEmail: 'owner@example.com',
  ownerPassword: 'a secure password 42!',
  registrationMode: 'invite_only',
  guestAccessEnabled: false,
  seoIndexingEnabled: false,
  seoTitle: null,
  seoDescription: null,
};

function request(body: unknown): Request {
  return new Request('https://community.example/api/setup/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown) {
  const { POST } = await import('../route.js');
  return POST(request(body), {});
}

beforeEach(() => {
  completeInitialBootstrap.mockReset();
  getInstanceBootstrapStatus.mockReset();
  hashPassword.mockReset();
  env.NODE_ENV = 'production';
  process.env.LOBBYFORGE_SETUP_TOKEN = validBody.setupToken;
  getInstanceBootstrapStatus.mockResolvedValue({ bootstrapComplete: false });
  hashPassword.mockResolvedValue('scrypt$hash');
  completeInitialBootstrap.mockResolvedValue({
    owner: { id: 'owner-id', displayName: 'Owner', email: 'owner@example.com' },
    server: { id: 'server-id' },
    setup: {
      instanceId: 'self-host',
      instanceName: 'Secure Community',
      setupCompletedAt: new Date(),
      bootstrapVersion: 2,
      ownerUserId: 'owner-id',
    },
  });
});

afterEach(() => {
  env.NODE_ENV = originalNodeEnv;
  if (originalSetupToken === undefined) delete process.env.LOBBYFORGE_SETUP_TOKEN;
  else process.env.LOBBYFORGE_SETUP_TOKEN = originalSetupToken;
});

describe('POST /api/setup/complete security boundary', () => {
  it('fails closed in production when the setup token is not configured', async () => {
    delete process.env.LOBBYFORGE_SETUP_TOKEN;
    const response = await post({ ...validBody, setupToken: undefined });
    expect(response.status).toBe(503);
    expect(completeInitialBootstrap).not.toHaveBeenCalled();
  });

  it('rejects an invalid setup token before password hashing or DB access', async () => {
    const response = await post({ ...validBody, setupToken: 'incorrect-token-which-is-long' });
    expect(response.status).toBe(403);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(completeInitialBootstrap).not.toHaveBeenCalled();
  });

  it('returns 409 without hashing when the irreversible lock is set', async () => {
    getInstanceBootstrapStatus.mockResolvedValue({ bootstrapComplete: true });
    const response = await post(validBody);
    expect(response.status).toBe(409);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(completeInitialBootstrap).not.toHaveBeenCalled();
  });

  it('allows exactly one winner when concurrent requests pass the fast check', async () => {
    completeInitialBootstrap
      .mockResolvedValueOnce({
        owner: { id: 'owner-id', displayName: 'Owner', email: 'owner@example.com' },
        server: { id: 'server-id' },
        setup: {
          instanceId: 'self-host',
          instanceName: 'Secure Community',
          setupCompletedAt: new Date(),
          bootstrapVersion: 2,
          ownerUserId: 'owner-id',
        },
      })
      .mockRejectedValueOnce(new MockSetupAlreadyCompleteError());
    const responses = await Promise.all([post(validBody), post(validBody)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it('rejects HTML-like visible fields and does not reflect the payload', async () => {
    const attack = '<img src=x onerror=alert(1)>';
    const response = await post({ ...validBody, ownerDisplayName: attack });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain(attack);
    expect(completeInitialBootstrap).not.toHaveBeenCalled();
  });

  it('passes SQL-like names as data, never executable query text', async () => {
    const sqlLikeName = "Robert'); DROP TABLE users;--";
    const response = await post({ ...validBody, instanceName: sqlLikeName });
    expect(response.status).toBe(200);
    expect(completeInitialBootstrap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instanceName: sqlLikeName })
    );
  });
});
