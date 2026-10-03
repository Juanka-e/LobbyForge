import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@lobbyforge/core';

/**
 * security-review AUTH-002 — server-rendered pages read the session through
 * getActiveSession, which adds the revocation check the API boundary
 * already had (fail closed in production, open in dev/test).
 */

const { isSessionRevoked } = vi.hoisted(() => ({ isSessionRevoked: vi.fn() }));
vi.mock('@/lib/session-tracker', () => ({ isSessionRevoked }));

import { getActiveSession, isSessionActive } from '../active-session.js';

const SECRET = 's'.repeat(48);
const USER_ID = '00000000-0000-4000-8000-000000000001';
const GID = `g_${'1'.repeat(32)}`;

function cookie(uid: string | null = USER_ID): string {
  return buildGuestSessionCookie({ gid: GID, uid, name: 'Owner' }, SECRET).setCookieHeader.split(';', 1)[0];
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  isSessionRevoked.mockReset();
  isSessionRevoked.mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getActiveSession', () => {
  it('returns a live session', async () => {
    const session = await getActiveSession(cookie(), SECRET);
    expect(session).toMatchObject({ uid: USER_ID, gid: GID, name: 'Owner' });
    expect(isSessionRevoked).toHaveBeenCalledWith(USER_ID, GID);
  });

  it('returns null for a revoked session', async () => {
    isSessionRevoked.mockResolvedValue(true);
    await expect(getActiveSession(cookie(), SECRET)).resolves.toBeNull();
  });

  it('fails closed in production when the revocation check errors', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    isSessionRevoked.mockRejectedValue(new Error('redis down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(getActiveSession(cookie(), SECRET)).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fails open outside production when the revocation check errors', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    isSessionRevoked.mockRejectedValue(new Error('redis down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(getActiveSession(cookie(), SECRET)).resolves.toMatchObject({ uid: USER_ID });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('passes a guest cookie without a uid through unchanged (never tracked)', async () => {
    await expect(getActiveSession(cookie(null), SECRET)).resolves.toMatchObject({ uid: null, gid: GID });
    expect(isSessionRevoked).not.toHaveBeenCalled();
  });

  it('returns null for a missing or forged cookie without touching Redis', async () => {
    await expect(getActiveSession(null, SECRET)).resolves.toBeNull();
    await expect(getActiveSession(cookie(), 'x'.repeat(48))).resolves.toBeNull();
    expect(isSessionRevoked).not.toHaveBeenCalled();
  });
});

describe('isSessionActive', () => {
  it('checks the session the caller already verified', async () => {
    isSessionRevoked.mockResolvedValue(true);
    await expect(
      isSessionActive({ gid: GID, uid: USER_ID, name: 'Owner', iat: 1, exp: 9_999_999_999 })
    ).resolves.toBe(false);
  });
});
