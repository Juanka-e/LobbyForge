import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The /lobby auto-join rule (lib/lobby-auto-join.ts) — shared by the lobby
 * page and POST /api/servers/{id}/join-requests/mine, so "Ask to join"
 * can only reach the community a user could have auto-joined.
 */

const getEffectiveInstanceAccessSettings = vi.fn();
const getInstanceBootstrapStatus = vi.fn();
const getUserById = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getEffectiveInstanceAccessSettings,
  getInstanceBootstrapStatus,
  getUserById,
}));

const DB = { __mockDb: true } as never;
const FIRST = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

async function resolve(setup?: { firstServerId: string | null; ownerUserId: string | null }) {
  const { resolveAutoJoinServerId } = await import('../lobby-auto-join');
  return resolveAutoJoinServerId(DB, USER, setup);
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.LOBBYFORGE_DEPLOYMENT_MODE;
  for (const fn of [getEffectiveInstanceAccessSettings, getInstanceBootstrapStatus, getUserById]) fn.mockReset();
  getInstanceBootstrapStatus.mockResolvedValue({ firstServerId: FIRST, ownerUserId: OWNER });
  getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'open', guestAccessEnabled: false });
  getUserById.mockResolvedValue({ id: USER, isGuest: false });
});

afterEach(() => {
  delete process.env.LOBBYFORGE_DEPLOYMENT_MODE;
});

describe('resolveAutoJoinServerId', () => {
  it('an account on an open-registration instance may auto-join the first community', async () => {
    expect(await resolve()).toBe(FIRST);
  });

  it('the owner always may; nobody may before setup created a community', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'invite_only', guestAccessEnabled: false });
    const { resolveAutoJoinServerId } = await import('../lobby-auto-join');
    expect(await resolveAutoJoinServerId(DB, OWNER, { firstServerId: FIRST, ownerUserId: OWNER })).toBe(FIRST);
    expect(await resolve({ firstServerId: null, ownerUserId: OWNER })).toBeNull();
  });

  it('an invite-only (or closed) instance admits no one without an invite', async () => {
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'invite_only', guestAccessEnabled: true });
    expect(await resolve()).toBeNull();
  });

  it('a guest only while guest access is on', async () => {
    getUserById.mockResolvedValue({ id: USER, isGuest: true });
    expect(await resolve()).toBeNull();
    getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'open', guestAccessEnabled: true });
    expect(await resolve()).toBe(FIRST);
  });

  it('never on the official hub — and reads nothing there', async () => {
    process.env.LOBBYFORGE_DEPLOYMENT_MODE = 'official';
    expect(await resolve()).toBeNull();
    expect(getInstanceBootstrapStatus).not.toHaveBeenCalled();
  });

  it('reuses the setup status the lobby already read', async () => {
    expect(await resolve({ firstServerId: FIRST, ownerUserId: OWNER })).toBe(FIRST);
    expect(getInstanceBootstrapStatus).not.toHaveBeenCalled();
  });
});
