import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserCredentialsByEmail = vi.fn();
const verifyPassword = vi.fn();

vi.mock('@lobbyforge/db', () => ({ getUserCredentialsByEmail }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({
  DUMMY_PASSWORD_HASH: 'dummy-hash',
  verifyPassword,
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(32);
  getUserCredentialsByEmail.mockReset();
  verifyPassword.mockReset();
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
