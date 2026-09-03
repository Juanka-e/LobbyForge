import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * SEC-002 negative regression: a plain server member must NOT read an
 * activity (GET) whose session lives in a private/role-gated channel —
 * even with a valid sessionId UUID.
 */

const dbFns = {
  getGameSessionById: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  listPlayersForSession: vi.fn(),
  canMemberAccessChannel: vi.fn(),
};

vi.mock('drizzle-orm', () => ({
  asc: () => (x: unknown) => x,
  inArray: () => (x: unknown) => x, // the GET user-join
}));

vi.mock('@lobbyforge/db', () => ({
  ...dbFns,
  users: { id: 'users.id', displayName: 'users.displayName' },
}));
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    __mockDb: true,
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
    }),
  }),
}));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

vi.mock('@/lib/plugin-server-registry', () => ({
  getPluginServer: () => null, // no plugin registry in this test
}));
vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/permissions')>('@/lib/permissions');
  return {
    ...actual,
    authorizeSessionChannelVisibility: vi.fn(async (_u, _s, session, owner) => {
      // mirror the real helper against the mocked db
      if (session.serverId !== _s) return { ok: false, response: Response.json({}, { status: 404 }) };
      if (owner && owner === _u) return { ok: true };
      const perms = await dbFns.getUserPermissions();
      if (perms.includes('administrator') || perms.includes('manage_channels')) return { ok: true };
      const visible = await dbFns.canMemberAccessChannel();
      if (!visible) return { ok: false, response: Response.json({ error: 'forbidden' }, { status: 403 }) };
      return { ok: true };
    }),
  };
});

const SECRET = 'x'.repeat(32);
const SERVER_ID = 'srv-1';
const OWNER = '00000000-0000-0000-0000-000000000099';
const MEMBER = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = 'sess-1';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  dbFns.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER });
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getUserPermissions.mockResolvedValue([]);
  dbFns.canMemberAccessChannel.mockResolvedValue(true);
  dbFns.getGameSessionById.mockResolvedValue({
    id: SESSION_ID, serverId: SERVER_ID, channelId: 'ch-private', pluginId: 'hushle',
    status: 'active', state: {}, revision: 1, publicSummary: null,
    createdBy: OWNER, createdAt: new Date(), startedAt: null,
  });
  dbFns.listPlayersForSession.mockResolvedValue([]);
});

async function get(uid: string): Promise<Response> {
  const { GET } = await import('../route.js');
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'T' };
  const cookie = `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
  return GET(
    new Request(`https://e.test/api/servers/${SERVER_ID}/activities/${SESSION_ID}`, {
      headers: { cookie },
    }),
    { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
  );
}

describe('GET activity — SEC-002 private-channel gate', () => {
  it('403 for a plain member when the session is in a gated channel', async () => {
    dbFns.canMemberAccessChannel.mockResolvedValue(false);
    const res = await get(MEMBER);
    expect(res.status).toBe(403);
    expect(dbFns.listPlayersForSession).not.toHaveBeenCalled();
  });

  it('200 for the owner (bypass) and a permitted member', async () => {
    const ownerRes = await get(OWNER);
    expect(ownerRes.status).toBe(200);
    const memberRes = await get(MEMBER); // canMemberAccessChannel=true
    expect(memberRes.status).toBe(200);
  });
});
