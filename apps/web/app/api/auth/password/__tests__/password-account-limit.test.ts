import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@/lib/guest-session';

/**
 * Security follow-up: guesses at the CURRENT password on
 * POST /api/auth/password are limited per user (5 per 15 minutes), across
 * every IP and session — a stolen session cookie must not get unlimited
 * tries at the password that unlocks account takeover.
 */

const { getUserCredentialsById, replaceUserPasswordHash, verifyPassword, hashPassword } = vi.hoisted(() => ({
  getUserCredentialsById: vi.fn(),
  replaceUserPasswordHash: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({ getUserCredentialsById, replaceUserPasswordHash }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/password', () => ({ DUMMY_PASSWORD_HASH: 'dummy-hash', verifyPassword, hashPassword }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/session-tracker', () => ({ revokeOtherSessions: vi.fn(async () => 0) }));
vi.mock('@/lib/desktop-handoff-codes', () => ({ revokeDesktopHandoffCodes: vi.fn(async () => 0) }));

import { resetAccountAttemptsForTests } from '@/lib/auth-throttle';

const SECRET = 'x'.repeat(32);
const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  resetAccountAttemptsForTests();
  getUserCredentialsById.mockReset().mockImplementation(async (_db: unknown, id: string) => ({
    id,
    email: `${id}@example.com`,
    displayName: 'Owner',
    passwordHash: 'old-hash',
    isGuest: false,
    deletedAt: null,
  }));
  verifyPassword.mockReset().mockImplementation(async (password: string) => password === 'old password');
  hashPassword.mockReset().mockResolvedValue('new-hash');
  replaceUserPasswordHash.mockReset().mockResolvedValue(true);
});

async function change(userId: string, currentPassword: string, gidChar = 'a'): Promise<Response> {
  const { POST } = await import('../route.js');
  const cookie = buildGuestSessionCookie({ gid: `g_${gidChar.repeat(32)}`, uid: userId, name: 'Owner' }, SECRET)
    .setCookieHeader.split(';', 1)[0];
  return POST(
    new Request('https://example.test/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword, newPassword: 'a brand new password' }),
    }),
    {}
  );
}

describe('POST /api/auth/password — per-user current-password limit', () => {
  it('refuses the sixth guess with a 429 — even the right password, unchecked', async () => {
    for (let i = 0; i < 5; i += 1) expect((await change(USER_A, 'guess')).status).toBe(403);
    verifyPassword.mockClear();
    const res = await change(USER_A, 'old password');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(replaceUserPasswordHash).not.toHaveBeenCalled();
  });

  it('counts per user across sessions, not per session', async () => {
    for (let i = 0; i < 5; i += 1) await change(USER_A, 'guess', String(i));
    expect((await change(USER_A, 'guess', 'f')).status).toBe(429);
    expect((await change(USER_B, 'guess')).status).toBe(403);
  });

  it('a correct current password resets the counter', async () => {
    for (let i = 0; i < 4; i += 1) await change(USER_A, 'guess');
    expect((await change(USER_A, 'old password')).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await change(USER_A, 'guess')).status).toBe(403);
    expect((await change(USER_A, 'guess')).status).toBe(429);
  });

  it('an unauthenticated or malformed request is not counted', async () => {
    const { POST } = await import('../route.js');
    for (let i = 0; i < 6; i += 1) {
      const res = await POST(
        new Request('https://example.test/api/auth/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword: 'x', newPassword: 'a brand new password' }),
        }),
        {}
      );
      expect(res.status).toBe(401);
    }
    expect((await change(USER_A, 'old password')).status).toBe(200);
  });
});
