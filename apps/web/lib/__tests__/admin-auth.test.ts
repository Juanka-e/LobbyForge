import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie } from '@lobbyforge/core';

const { getInstanceSetupStatus } = vi.hoisted(() => ({
  getInstanceSetupStatus: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getInstanceSetupStatus,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ test: true }),
}));

const { isSessionRevoked } = vi.hoisted(() => ({ isSessionRevoked: vi.fn() }));
vi.mock('@/lib/session-tracker', () => ({ isSessionRevoked }));

import {
  isAdminHealthAllowed,
  isInstanceAdminAllowed,
  requireInstanceAdmin,
} from '../admin-auth.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_SECRET = 's'.repeat(48);
const ADMIN_TOKEN = 'a'.repeat(48);

function ownerCookie(uid = OWNER_ID): string {
  return buildGuestSessionCookie(
    { gid: `g_${'1'.repeat(32)}`, uid, name: 'Owner' },
    SESSION_SECRET
  ).setCookieHeader;
}

describe('instance admin authentication', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SESSION_SECRET);
    vi.stubEnv('LOBBYFORGE_ADMIN_TOKEN', ADMIN_TOKEN);
    getInstanceSetupStatus.mockReset();
    getInstanceSetupStatus.mockResolvedValue({
      bootstrapVersion: 2,
      ownerUserId: OWNER_ID,
    });
    isSessionRevoked.mockReset();
    isSessionRevoked.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not bypass authentication in development', async () => {
    await expect(isInstanceAdminAllowed(null, null)).resolves.toBe(false);
  });

  it('accepts only the locked instance owner session', async () => {
    await expect(isInstanceAdminAllowed(ownerCookie(), null)).resolves.toBe(true);
    await expect(isInstanceAdminAllowed(ownerCookie(OTHER_ID), null)).resolves.toBe(false);
  });

  it('rejects owner sessions when bootstrap is not irreversibly locked', async () => {
    getInstanceSetupStatus.mockResolvedValue({ bootstrapVersion: 1, ownerUserId: OWNER_ID });
    await expect(isInstanceAdminAllowed(ownerCookie(), null)).resolves.toBe(false);
  });

  it('compares the emergency token exactly and requires a strong configured token', () => {
    expect(isAdminHealthAllowed(ADMIN_TOKEN)).toBe(true);
    expect(isAdminHealthAllowed(`${ADMIN_TOKEN.slice(0, -1)}b`)).toBe(false);
    vi.stubEnv('LOBBYFORGE_ADMIN_TOKEN', 'short');
    expect(isAdminHealthAllowed('short')).toBe(false);
  });

  // security-review AUTH-002: every admin page, the root layout and the
  // admin API routes trust this check — a revoked owner session must fail it.
  it('rejects a revoked owner session', async () => {
    isSessionRevoked.mockResolvedValue(true);
    await expect(isInstanceAdminAllowed(ownerCookie(), null)).resolves.toBe(false);
    expect(isSessionRevoked).toHaveBeenCalledWith(OWNER_ID, `g_${'1'.repeat(32)}`);
  });

  it('rejects the owner in production when the revocation check is unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    isSessionRevoked.mockRejectedValue(new Error('redis down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(isInstanceAdminAllowed(ownerCookie(), null)).resolves.toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('answers 401 on an admin API route for a revoked owner session', async () => {
    isSessionRevoked.mockResolvedValue(true);
    const response = await requireInstanceAdmin(
      new Request('http://localhost/api/admin/updates', {
        headers: { cookie: ownerCookie().split(';', 1)[0] },
      })
    );
    expect(response?.status).toBe(401);
  });

  it('does not query revocation for a visitor who is not the owner', async () => {
    await expect(isInstanceAdminAllowed(ownerCookie(OTHER_ID), null)).resolves.toBe(false);
    expect(isSessionRevoked).not.toHaveBeenCalled();
  });

  it('the emergency token does not depend on a session', async () => {
    isSessionRevoked.mockResolvedValue(true);
    await expect(isInstanceAdminAllowed(ownerCookie(), ADMIN_TOKEN)).resolves.toBe(true);
  });

  it('returns 401 without owner session or emergency token', async () => {
    const response = await requireInstanceAdmin(new Request('http://localhost/api/admin/updates'));
    expect(response?.status).toBe(401);
  });
});
