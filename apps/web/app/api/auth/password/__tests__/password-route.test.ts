import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@/lib/guest-session';

const getUserCredentialsById = vi.fn();
const replaceUserPasswordHash = vi.fn();
const verifyPassword = vi.fn();
const hashPassword = vi.fn();
const revokeOtherSessions = vi.fn();

vi.mock('@lobbyforge/db', () => ({ getUserCredentialsById, replaceUserPasswordHash }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({
  DUMMY_PASSWORD_HASH: 'dummy-hash',
  verifyPassword,
  hashPassword,
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/session-tracker', () => ({ revokeOtherSessions }));

const secret = 'x'.repeat(32);
const userId = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = secret;
  getUserCredentialsById.mockReset();
  replaceUserPasswordHash.mockReset();
  verifyPassword.mockReset();
  hashPassword.mockReset();
  revokeOtherSessions.mockReset();
});

async function post(body: unknown, authenticated = true) {
  const { POST } = await import('../route.js');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authenticated) {
    headers.cookie = buildGuestSessionCookie(
      { gid: `g_${'a'.repeat(32)}`, uid: userId, name: 'Owner' },
      secret
    ).setCookieHeader.split(';', 1)[0];
  }
  return POST(new Request('https://example.test/api/auth/password', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }), {});
}

describe('POST /api/auth/password', () => {
  it('requires an authenticated materialized session', async () => {
    const response = await post(
      { currentPassword: 'old password', newPassword: 'new password long' },
      false
    );
    expect(response.status).toBe(401);
  });

  it('does a dummy verification for an account without local credentials', async () => {
    getUserCredentialsById.mockResolvedValue(null);
    verifyPassword.mockResolvedValue(false);
    const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
    expect(response.status).toBe(403);
    expect(verifyPassword).toHaveBeenCalledWith('old password', 'dummy-hash');
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('rejects an incorrect current password without changing the hash', async () => {
    getUserCredentialsById.mockResolvedValue(credentials());
    verifyPassword.mockResolvedValue(false);
    const response = await post({ currentPassword: 'wrong password', newPassword: 'new password long' });
    expect(response.status).toBe(403);
    expect(replaceUserPasswordHash).not.toHaveBeenCalled();
  });

  it('hashes and atomically stores a valid new password', async () => {
    getUserCredentialsById.mockResolvedValue(credentials());
    verifyPassword.mockResolvedValue(true);
    hashPassword.mockResolvedValue('new-hash');
    replaceUserPasswordHash.mockResolvedValue(true);
    revokeOtherSessions.mockResolvedValue(2);
    const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'changed' });
    expect(replaceUserPasswordHash).toHaveBeenCalledWith(
      { __test: true },
      { userId, currentPasswordHash: 'old-hash', newPasswordHash: 'new-hash' }
    );
    expect(revokeOtherSessions).toHaveBeenCalledWith(userId, `g_${'a'.repeat(32)}`);
  });

  it('detects a concurrent credential change', async () => {
    getUserCredentialsById.mockResolvedValue(credentials());
    verifyPassword.mockResolvedValue(true);
    hashPassword.mockResolvedValue('new-hash');
    replaceUserPasswordHash.mockResolvedValue(false);
    const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
    expect(response.status).toBe(409);
  });
});

function credentials() {
  return {
    id: userId,
    email: 'owner@example.com',
    displayName: 'Owner',
    passwordHash: 'old-hash',
    isGuest: false,
    deletedAt: null,
  };
}
