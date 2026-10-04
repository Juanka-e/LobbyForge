import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@/lib/guest-session';

const getUserCredentialsById = vi.fn();
const replaceUserPasswordHash = vi.fn();
const verifyPassword = vi.fn();
const hashPassword = vi.fn();
const revokeOtherSessions = vi.fn();
const revokeDesktopHandoffCodes = vi.fn();

vi.mock('@lobbyforge/db', () => ({ getUserCredentialsById, replaceUserPasswordHash }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({
  DUMMY_PASSWORD_HASH: 'dummy-hash',
  verifyPassword,
  hashPassword,
}));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/session-tracker', () => ({ revokeOtherSessions }));
vi.mock('@/lib/desktop-handoff-codes', () => ({ revokeDesktopHandoffCodes }));
// The per-account limiter has its own tests (lib/__tests__/auth-throttle.test.ts
// and the account-limit route tests). Here it always allows: under
// NODE_ENV=production it would otherwise reach for Redis, which CI lacks.
vi.mock('@/lib/auth-throttle', () => ({
  beginAccountAttempt: async () => ({ allowed: true }),
  clearAccountAttempts: async () => undefined,
  accountLockedResponse: () => new Response(null, { status: 429 }),
}));

const secret = 'x'.repeat(32);
const userId = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = secret;
  getUserCredentialsById.mockReset();
  replaceUserPasswordHash.mockReset();
  verifyPassword.mockReset();
  hashPassword.mockReset();
  revokeOtherSessions.mockReset();
  revokeDesktopHandoffCodes.mockReset();
  revokeDesktopHandoffCodes.mockResolvedValue(0);
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

// security-review AUTH-001: a password change must also void outstanding
// desktop handoff codes, and must not report plain success when the other
// sessions survived it.
describe('POST /api/auth/password — security-review AUTH-001', () => {
  function validChange() {
    getUserCredentialsById.mockResolvedValue(credentials());
    verifyPassword.mockResolvedValue(true);
    hashPassword.mockResolvedValue('new-hash');
    replaceUserPasswordHash.mockResolvedValue(true);
  }

  it('clears the outstanding desktop handoff codes after a successful change', async () => {
    validChange();
    revokeOtherSessions.mockResolvedValue(0);
    revokeDesktopHandoffCodes.mockResolvedValue(2);
    const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
    expect(response.status).toBe(200);
    expect(revokeDesktopHandoffCodes).toHaveBeenCalledWith(userId);
  });

  it('does not touch handoff codes when the change is refused', async () => {
    getUserCredentialsById.mockResolvedValue(credentials());
    verifyPassword.mockResolvedValue(false);
    const response = await post({ currentPassword: 'wrong password', newPassword: 'new password long' });
    expect(response.status).toBe(403);
    expect(revokeDesktopHandoffCodes).not.toHaveBeenCalled();
  });

  it('a failed handoff-code cleanup only logs (the credential fingerprint still voids them)', async () => {
    validChange();
    revokeOtherSessions.mockResolvedValue(0);
    revokeDesktopHandoffCodes.mockRejectedValue(new Error('redis down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
      expect(response.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // AUTH-001 follow-up: the password WAS changed, so an error status made
  // the dialog report failure (in English) and invited a retry with the old
  // password. It is a success carrying a warning the client translates.
  it.each(['production', 'test'])(
    'a failed session revocation is a success with a warning, never a silent one (NODE_ENV=%s)',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      validChange();
      revokeOtherSessions.mockRejectedValue(new Error('redis down'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await expect(response.json()).resolves.toEqual({ status: 'changed', warning: 'sessions_not_revoked' });
        // The operator still learns about it.
        expect(errorSpy).toHaveBeenCalledWith('[auth/password] failed to revoke other sessions', 'redis down');
      } finally {
        errorSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    }
  );

  it('a successful revocation carries no warning', async () => {
    validChange();
    revokeOtherSessions.mockResolvedValue(3);
    const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'changed' });
    expect(body).not.toHaveProperty('warning');
  });

  it('re-issues this browser a device cookie bound to the NEW password (old entries are void)', async () => {
    validChange();
    revokeOtherSessions.mockResolvedValue(0);
    const response = await post({ currentPassword: 'old password', newPassword: 'new password long' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^lf_device=/);
    expect(cookie).toContain('HttpOnly');
    const { readDeviceClaim, deviceClaimHolds } = await import('@/lib/device-cookie');
    const claim = readDeviceClaim(cookie.split(';', 1)[0]!, 'owner@example.com');
    expect(claim).not.toBeNull();
    expect(deviceClaimHolds(claim, 'owner@example.com', 'new-hash')).toBe(true);
    expect(deviceClaimHolds(claim, 'owner@example.com', 'old-hash')).toBe(false);
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
