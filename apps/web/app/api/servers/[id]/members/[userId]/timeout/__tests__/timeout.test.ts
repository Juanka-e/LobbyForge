import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * MODERATE_MEMBERS timeout endpoint:
 *  - requires the permission
 *  - hierarchy: actor's highest role must be strictly above the target's
 *  - the owner can never be timed out
 *  - null clears, future ISO sets (28-day cap clamps)
 */

const dbFns = {
  getHighestRolePosition: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  logAction: vi.fn(),
  setMemberTimeout: vi.fn(),
};

vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

const SECRET = 'x'.repeat(32);
const SERVER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER = 'owner-user';
const MOD = 'moderator';
const MEMBER = 'plain-member';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  dbFns.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER });
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getUserPermissions.mockResolvedValue(['moderate_members']);
  dbFns.logAction.mockResolvedValue(undefined);
  dbFns.setMemberTimeout.mockImplementation(
    async (_db: unknown, _s: string, _u: string, until: Date | null) => ({
      id: 'membership-1',
      serverId: SERVER_ID,
      userId: _u,
      roleId: null,
      nickname: null,
      timedOutUntil: until,
      createdAt: new Date(),
    })
  );
  // Hierarchy default: mod at 5, target at 1 → allowed.
  dbFns.getHighestRolePosition.mockImplementation(
    async (_db: unknown, _s: string, userId: string) => (userId === MOD ? 5 : 1)
  );
});

async function put(body: unknown, actor: string, target: string): Promise<Response> {
  const { PUT } = await import('../route.js');
  const handler = PUT as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: actor, name: 'T' };
  const cookie = `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
  return handler(
    new Request(`http://localhost/api/servers/${SERVER_ID}/members/${target}/timeout`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SERVER_ID, userId: target }) }
  );
}

describe('PUT members/[userId]/timeout — MODERATE_MEMBERS', () => {
  it('sets a timeout on a lower-ranked member', async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const res = await put({ until }, MOD, MEMBER);
    expect(res.status).toBe(200);
    expect(dbFns.setMemberTimeout).toHaveBeenCalled();
  });

  it('403 without MODERATE_MEMBERS', async () => {
    dbFns.getUserPermissions.mockResolvedValue(['send_messages']);
    const res = await put({ until: new Date(Date.now() + 60_000).toISOString() }, MOD, MEMBER);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberTimeout).not.toHaveBeenCalled();
  });

  it('403 when the target outranks or equals the actor', async () => {
    // Target at 10 ≥ actor's 5.
    dbFns.getHighestRolePosition.mockImplementation(
      async (_db: unknown, _s: string, userId: string) => (userId === MOD ? 5 : 10)
    );
    const res = await put({ until: new Date(Date.now() + 60_000).toISOString() }, MOD, MEMBER);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberTimeout).not.toHaveBeenCalled();
  });

  it('the owner can never be timed out (even by a mod)', async () => {
    const res = await put({ until: new Date(Date.now() + 60_000).toISOString() }, MOD, OWNER);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberTimeout).not.toHaveBeenCalled();
  });

  it('null clears an active timeout', async () => {
    const res = await put({ until: null }, MOD, MEMBER);
    expect(res.status).toBe(200);
    expect(dbFns.setMemberTimeout).toHaveBeenCalledWith(expect.anything(), SERVER_ID, MEMBER, null);
  });

  it('clamps an absurd duration to the 28-day cap', async () => {
    const yearLong = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const res = await put({ until: yearLong }, MOD, MEMBER);
    expect(res.status).toBe(200);
    const passedUntil = dbFns.setMemberTimeout.mock.calls[0]![3] as Date;
    expect(passedUntil.getTime()).toBeLessThanOrEqual(Date.now() + 28 * 24 * 60 * 60 * 1000 + 1000);
  });
});
