import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Bots milestone: every path that creates a membership tells the Welcome
 * Bot — after the join committed, only for a real join, and never for a
 * failed one. (The Welcome Bot itself is covered in welcome.test.ts.)
 */

const notifyMemberJoined = vi.fn();
vi.mock('@/lib/bots/welcome', () => ({ notifyMemberJoined }));

const redeemInvite = vi.fn();
const logAction = vi.fn();
const createLocalAccount = vi.fn();
const getEffectiveInstanceAccessSettings = vi.fn();
const getInstanceBootstrapStatus = vi.fn();
const getInviteMetadata = vi.fn();
const getServerAccessPolicy = vi.fn();
vi.mock('@lobbyforge/db', () => ({
  redeemInvite,
  logAction,
  createLocalAccount,
  getEffectiveInstanceAccessSettings,
  getInstanceBootstrapStatus,
  getInviteMetadata,
  getServerAccessPolicy,
  // The join approval queue: the redeem route's note limit, and register's
  // server-policy check (no saved policy here → nothing refused).
  JOIN_REQUEST_NOTE_MAX_LENGTH: 500,
  serverPolicyRegistrationRefusal: () => null,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
// Bot protection is covered by lib/captcha/__tests__ — a pass-through here.
vi.mock('@/lib/captcha/guard', () => ({ guardCaptchaSurface: async () => null }));
vi.mock('@/lib/invite-code', () => ({ normalizeInviteCode: (code: string) => code }));
vi.mock('@/lib/password', () => ({ hashPassword: async () => 'scrypt$hash' }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => false }));
vi.mock('@/lib/official-account', () => ({ createOfficialAccount: vi.fn() }));
vi.mock('@/lib/session-tracker', () => ({ recordSession: async () => undefined }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [notifyMemberJoined, redeemInvite, logAction, createLocalAccount, getEffectiveInstanceAccessSettings, getInstanceBootstrapStatus, getInviteMetadata, getServerAccessPolicy]) {
    fn.mockReset();
  }
  notifyMemberJoined.mockResolvedValue(undefined);
  logAction.mockResolvedValue(undefined);
  getEffectiveInstanceAccessSettings.mockResolvedValue({ registrationMode: 'open' });
  getInstanceBootstrapStatus.mockResolvedValue({ bootstrapComplete: true, firstServerId: SERVER });
  getServerAccessPolicy.mockResolvedValue(null);
});

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

describe('POST /api/invites/{code}/redeem', () => {
  const redeem = async () => {
    const { POST } = await import('@/app/api/invites/[code]/redeem/route');
    return POST(
      new Request('https://chat.example.test/api/invites/ABCD2345EFGH/redeem', {
        method: 'POST',
        headers: { cookie: cookie(USER) },
      }),
      { params: Promise.resolve({ code: 'ABCD2345EFGH' }) }
    );
  };

  it('greets the new member once the membership exists', async () => {
    redeemInvite.mockResolvedValue({ ok: true, membershipId: 'm-1', serverId: SERVER, roleId: 'r-1' });
    expect((await redeem()).status).toBe(201);
    expect(notifyMemberJoined).toHaveBeenCalledWith({ serverId: SERVER, userId: USER });
  });

  it('does not greet when the redemption fails', async () => {
    for (const error of ['already_member', 'expired', 'banned']) {
      redeemInvite.mockResolvedValue({ ok: false, error });
      await redeem();
    }
    expect(notifyMemberJoined).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/register (self-host)', () => {
  const register = async () => {
    const { POST } = await import('@/app/api/auth/register/route');
    return POST(
      new Request('https://chat.example.test/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com', displayName: 'Newcomer', password: 'long password 42!' }),
      }),
      undefined as never
    );
  };

  it('greets the member the registration just joined', async () => {
    createLocalAccount.mockResolvedValue({
      ok: true,
      user: { id: USER, email: 'new@example.com', displayName: 'Newcomer' },
      serverId: SERVER,
    });
    expect((await register()).status).toBe(201);
    expect(notifyMemberJoined).toHaveBeenCalledWith({ serverId: SERVER, userId: USER });
  });

  it('does not greet when the account was not created', async () => {
    createLocalAccount.mockResolvedValue({ ok: false, error: 'email_exists' });
    expect((await register()).status).toBe(409);
    expect(notifyMemberJoined).not.toHaveBeenCalled();
  });
});
