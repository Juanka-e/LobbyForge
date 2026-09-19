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
  getMemberRoleIds: vi.fn(),
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
const queueMemberVoiceSync = vi.fn();
vi.mock('@/lib/voice-moderation', () => ({ queueMemberVoiceSync }));

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
  // LF-SEC-004: the gate now compares actor-vs-TARGET too — make the
  // positions per-user so the hierarchy is observable.
  const positions = new Map<string, number>([
    [OWNER, Number.POSITIVE_INFINITY],
    [ADMIN_LOW, 5],
    [MEMBER, 1],
    ['higher-target', 80],
    ['equal-target', 5],
  ]);
  dbFns.getHighestRolePosition.mockImplementation(
    async (_db: unknown, _sid: string, userId: string) => positions.get(userId) ?? -1
  );
  // Signature is getRoleById(db, roleId) — read the SECOND argument.
  dbFns.getRoleById.mockImplementation(async (_db: unknown, id: string) =>
    id === ROLE_HIGH
      ? { id, serverId: SERVER_ID, name: 'High', position: 10 }
      : { id, serverId: SERVER_ID, name: 'Low', position: 1 }
  );
  dbFns.setMemberRoles.mockResolvedValue({ ok: true });
  dbFns.getMemberRoleIds.mockResolvedValue([]);
  queueMemberVoiceSync.mockReset();
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
    const res = await put({ roleIds: [ROLE_HIGH] }, OWNER);
    expect(res.status).toBe(200);
    expect(dbFns.setMemberRoles).toHaveBeenCalled();
  });

  it('only the owner may change the OWNER roles (admins cannot)', async () => {
    const res = await put({ roleIds: [ROLE_LOW] }, ADMIN_LOW, OWNER);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  // LF-SEC-004: the actor must ALSO outrank the TARGET user — a lower
  // role manager cannot strip a higher-ranked member's roles.
  it('rejects a lower-ranked actor stripping a HIGHER target with roleIds: []', async () => {
    const res = await put({ roleIds: [] }, ADMIN_LOW, 'higher-target');
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  it('rejects a lower-ranked actor replacing a higher target with low roles', async () => {
    const res = await put({ roleIds: [ROLE_LOW] }, ADMIN_LOW, 'higher-target');
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  it('rejects an EQUAL-rank actor managing an equal-rank target', async () => {
    const res = await put({ roleIds: [ROLE_LOW] }, ADMIN_LOW, 'equal-target');
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  it('rejects a non-member actor entirely', async () => {
    dbFns.isServerMember.mockResolvedValue(false);
    const res = await put({ roleIds: [ROLE_LOW] }, ADMIN_LOW, MEMBER);
    expect(res.status).toBe(403);
  });

  it('rejects acting on a target who is not a member', async () => {
    // isServerMember(db, userId, serverId) — userId is the SECOND arg.
    dbFns.isServerMember.mockImplementation(
      async (_db: unknown, userId: string) => userId === ADMIN_LOW
    );
    const res = await put({ roleIds: [ROLE_LOW] }, ADMIN_LOW, MEMBER);
    expect(res.status).toBe(404);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });
});

// beta-review (S1): rank alone does not make a role assignable — an
// owner-created LOW-position role may carry `administrator` or other
// permissions the actor lacks; assigning it is the same escalation as
// editing them into a role.
describe('PUT members/[userId]/role — beta-review S1 grant cap', () => {
  const ROLE_LOW_ADMIN = '44444444-4444-4444-4444-444444444444'; // position 1, administrator
  const ROLE_LOW_BAN = '55555555-5555-5555-5555-555555555555'; // position 1, ban_members

  beforeEach(() => {
    dbFns.getRoleById.mockImplementation(async (_db: unknown, id: string) => {
      if (id === ROLE_LOW_ADMIN) return { id, serverId: SERVER_ID, name: 'LowAdmin', position: 1, permissions: ['administrator'] };
      if (id === ROLE_LOW_BAN) return { id, serverId: SERVER_ID, name: 'LowBan', position: 1, permissions: ['ban_members'] };
      if (id === ROLE_HIGH) return { id, serverId: SERVER_ID, name: 'High', position: 10, permissions: [] };
      return { id, serverId: SERVER_ID, name: 'Low', position: 1, permissions: ['send_messages'] };
    });
  });

  it('a MANAGE_ROLES member cannot assign a low role that carries administrator', async () => {
    dbFns.getUserPermissions.mockResolvedValue(['manage_roles', 'send_messages']);
    const res = await put({ roleIds: [ROLE_LOW_ADMIN] }, ADMIN_LOW);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  it('a non-owner ADMINISTRATOR cannot hand out administrator either', async () => {
    const res = await put({ roleIds: [ROLE_LOW_ADMIN] }, ADMIN_LOW);
    expect(res.status).toBe(403);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  it('a MANAGE_ROLES member cannot assign a role carrying a permission they lack', async () => {
    dbFns.getUserPermissions.mockResolvedValue(['manage_roles', 'send_messages']);
    const res = await put({ roleIds: [ROLE_LOW_BAN] }, ADMIN_LOW);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { permissions: string[] };
    expect(json.permissions).toEqual(['ban_members']);
    expect(dbFns.setMemberRoles).not.toHaveBeenCalled();
  });

  it('roles the target ALREADY holds may be resubmitted alongside a new grantable role', async () => {
    dbFns.getUserPermissions.mockResolvedValue(['manage_roles', 'send_messages']);
    dbFns.getMemberRoleIds.mockResolvedValue([ROLE_LOW_BAN]);
    const res = await put({ roleIds: [ROLE_LOW_BAN, ROLE_LOW] }, ADMIN_LOW);
    expect(res.status).toBe(200);
    expect(dbFns.getMemberRoleIds).toHaveBeenCalledWith(expect.anything(), SERVER_ID, MEMBER);
    expect(dbFns.setMemberRoles).toHaveBeenCalledWith(expect.anything(), SERVER_ID, MEMBER, [
      ROLE_LOW_BAN,
      ROLE_LOW,
    ]);
  });

  it('a manager holding the permission may assign the role', async () => {
    dbFns.getUserPermissions.mockResolvedValue(['manage_roles', 'ban_members']);
    const res = await put({ roleIds: [ROLE_LOW_BAN] }, ADMIN_LOW);
    expect(res.status).toBe(200);
  });

  it('the owner may assign an administrator role (unchanged)', async () => {
    const res = await put({ roleIds: [ROLE_LOW_ADMIN] }, OWNER);
    expect(res.status).toBe(200);
    expect(dbFns.setMemberRoles).toHaveBeenCalled();
  });

  it('beta-review S2: a successful assignment re-syncs the target voice session', async () => {
    const res = await put({ roleIds: [ROLE_LOW] }, OWNER);
    expect(res.status).toBe(200);
    expect(queueMemberVoiceSync).toHaveBeenCalledWith(SERVER_ID, MEMBER);
  });
});
