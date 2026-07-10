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

  it('returns 401 without owner session or emergency token', async () => {
    const response = await requireInstanceAdmin(new Request('http://localhost/api/admin/updates'));
    expect(response?.status).toBe(401);
  });
});
