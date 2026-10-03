import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@lobbyforge/core';

const SECRET = 's'.repeat(40);
const cookieHeader = { value: '' };
const getUserById = vi.fn();
const isSessionRevoked = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => cookieHeader.value }),
}));
vi.mock('@lobbyforge/db', () => ({ getUserById }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __test: true }) }));
vi.mock('@/lib/session-tracker', () => ({ isSessionRevoked }));

const { getHubViewer, sessionUser } = await import('../hub-viewer');

function signedCookie(uid: string | null, name = 'Ada') {
  const { raw } = buildGuestSessionCookie({ gid: `g_${'a'.repeat(32)}`, uid, name }, SECRET);
  return `lf_guest=${raw}`;
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  cookieHeader.value = '';
  getUserById.mockReset();
  isSessionRevoked.mockReset();
  isSessionRevoked.mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sessionUser', () => {
  it('reads the user from a valid session cookie', async () => {
    await expect(sessionUser(signedCookie('user-1'), SECRET)).resolves.toEqual({ userId: 'user-1', name: 'Ada' });
  });

  it('treats a guest cookie without a user row as signed out', async () => {
    await expect(sessionUser(signedCookie(null), SECRET)).resolves.toBeNull();
  });

  it('rejects a cookie signed with another secret', async () => {
    await expect(sessionUser(signedCookie('user-1'), 'x'.repeat(40))).resolves.toBeNull();
  });

  it('is signed out, not crashed, when the instance has no usable secret', async () => {
    await expect(sessionUser(signedCookie('user-1'), undefined)).resolves.toBeNull();
    await expect(sessionUser(signedCookie('user-1'), 'short')).resolves.toBeNull();
  });

  // security-review AUTH-002
  it('treats a revoked session as signed out', async () => {
    isSessionRevoked.mockResolvedValue(true);
    await expect(sessionUser(signedCookie('user-1'), SECRET)).resolves.toBeNull();
    expect(isSessionRevoked).toHaveBeenCalledWith('user-1', `g_${'a'.repeat(32)}`);
  });
});

describe('getHubViewer', () => {
  it('is null for a visitor without a session', async () => {
    await expect(getHubViewer()).resolves.toBeNull();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('uses the current display name from the user row', async () => {
    cookieHeader.value = signedCookie('user-1', 'Old name');
    const createdAt = new Date('2026-09-01T00:00:00Z');
    getUserById.mockResolvedValue({ displayName: 'Ada Lovelace', createdAt });
    await expect(getHubViewer()).resolves.toEqual({ userId: 'user-1', name: 'Ada Lovelace', createdAt });
  });

  it('is null for a revoked session (security-review AUTH-002)', async () => {
    cookieHeader.value = signedCookie('user-1');
    isSessionRevoked.mockResolvedValue(true);
    await expect(getHubViewer()).resolves.toBeNull();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('falls back to the session name when the user row cannot be read', async () => {
    cookieHeader.value = signedCookie('user-1', 'Ada');
    getUserById.mockRejectedValue(new Error('db down'));
    await expect(getHubViewer()).resolves.toEqual({ userId: 'user-1', name: 'Ada', createdAt: null });
  });
});
