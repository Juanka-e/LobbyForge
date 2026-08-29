import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Discord-style role hierarchy tests for PUT /members/[userId]/role:
 *  - a lower-ranked member with MANAGE_ROLES CANNOT assign a role at or
 *    above their own highest role
 *  - ADMINISTRATOR does NOT bypass the ranking
 *  - only the owner may change the owner's roles
 *  - the owner assigns freely
 */

const dbFns = {
  setMemberRoles: vi.fn(),
  getRoleById: vi.fn(),
  getHighestRolePosition: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  logAction: vi.fn(),
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
const ADMIN_LOW = 'admin-low-rank';
const MEMBER = 'plain-member';
const ROLE_HIGH = '22222222-2222-2222-2222-222222222222'; // position 10
const ROLE_LOW = '33333333-3333-3333-3333-333333333333'; // position 1

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  dbFns.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER });
  dbFns.isServerMember.mockResolvedValue(true);
  // The actor holds manage_roles AND administrator — hierarchy must still
  // apply (Discord semantics: only ownership bypasses ranking).
  dbFns.getUserPermissions.mockResolvedValue(['manage_roles', 'administrator']);
  dbFns.getHighestRolePosition.mockResolvedValue(5);
  // Signature is getRoleById(db, roleId) — read the SECOND argument.
  dbFns.getRoleById.mockImplementation(async (_db: unknown, id: string) =>
    id === ROLE_HIGH
      ? { id, serverId: SERVER_ID, name: 'High', position: 10 }
      : { id, serverId: SERVER_ID, name: 'Low', position: 1 }
  );
  dbFns.setMemberRoles.mockResolvedValue({ ok: true });
  dbFns.logAction.mockResolvedValue(undefined);
});

async function put(body: unknown, actor: string, target: string = MEMBER): Promise<Response> {
  const { PUT } = await import('../route.js');
  const handler = PUT as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: actor, name: 'T' };
  const cookie = `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
  return handler(
    new Request(`http://localhost/api/servers/${SERVER_ID}/members/${target}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SERVER_ID, userId: target }) }
  );
}

describe('PUT members/[userId]/role — Discord hierarchy', () => {
  it('rejects assigning a role at/above the actor highest role (even with administrator)', async () => {
    const res = await put({ roleIds: [ROLE_HIGH] }, ADMIN_LOW);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  it('allows assigning a role strictly below the actor highest role', async () => {
    const res = await put({ roleIds: [ROLE_LOW] }, ADMIN_LOW);
    expect(res.status).toBe(200);
    expect(dbFns.setMemberRoles).toHaveBeenCalledWith(expect.anything(), SERVER_ID, MEMBER, [
      ROLE_LOW,
    ]);
  });

  it('allows the owner to assign ANY role without rank checks', async () => {
    dbFns.getHighestRolePosition.mockResolvedValue(Number.POSITIVE_INFINITY);
    const res = await put({ roleIds: [ROLE_HIGH] }, OWNER);
    expect(res.status).toBe(200);
    expect(dbFns.setMemberRoles).toHaveBeenCalled();
  });

  it('only the owner may change the OWNER roles (admins cannot)', async () => {
    const res = await put({ roleIds: [ROLE_LOW] }, ADMIN_LOW, OWNER);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });
});
