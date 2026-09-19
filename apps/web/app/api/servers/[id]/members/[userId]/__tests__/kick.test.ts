import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * DELETE /api/servers/{id}/members/{userId} — kick / self-leave.
 * beta-review (S2): removing the membership row is not enough — the
 * user's LIVE LiveKit session outlives it, so every successful removal
 * re-syncs voice access (which evicts non-members from the room), and a
 * kick invalidates the target's live WS/SSE topics.
 */

const dbFns = {
  getHighestRolePosition: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  logAction: vi.fn(),
  removeMember: vi.fn(),
};

vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
const publishAccessInvalidation = vi.fn();
vi.mock('@/lib/access-invalidation', () => ({ publishAccessInvalidation }));
const queueMemberVoiceSync = vi.fn();
vi.mock('@/lib/voice-moderation', () => ({ queueMemberVoiceSync }));

const SECRET = 'x'.repeat(32);
const SERVER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER = 'owner-user';
const MOD = 'moderator';
const MEMBER = 'plain-member';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  publishAccessInvalidation.mockReset();
  queueMemberVoiceSync.mockReset();
  dbFns.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER });
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getUserPermissions.mockResolvedValue(['kick_members']);
  dbFns.logAction.mockResolvedValue(undefined);
  dbFns.removeMember.mockResolvedValue(undefined);
  dbFns.getHighestRolePosition.mockImplementation(
    async (_db: unknown, _s: string, userId: string) => (userId === MOD ? 5 : 1)
  );
});

async function del(actor: string, target: string): Promise<Response> {
  const { DELETE } = await import('../route.js');
  const handler = DELETE as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid: actor, name: 'T' };
  const cookie = `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
  return handler(
    new Request(`http://localhost/api/servers/${SERVER_ID}/members/${target}`, {
      method: 'DELETE',
      headers: { cookie },
    }),
    { params: Promise.resolve({ id: SERVER_ID, userId: target }) }
  );
}

describe('DELETE members/[userId] — beta-review S2 voice enforcement', () => {
  it('a kick removes the member, invalidates live topics and evicts them from voice', async () => {
    const res = await del(MOD, MEMBER);
    expect(res.status).toBe(200);
    expect(dbFns.removeMember).toHaveBeenCalledWith(expect.anything(), SERVER_ID, MEMBER);
    expect(publishAccessInvalidation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user-server-access', userId: MEMBER, reason: 'kick' })
    );
    expect(queueMemberVoiceSync).toHaveBeenCalledWith(SERVER_ID, MEMBER);
  });

  it('a self-leave also leaves any live voice room', async () => {
    dbFns.getUserPermissions.mockResolvedValue([]);
    const res = await del(MEMBER, MEMBER);
    expect(res.status).toBe(200);
    expect(queueMemberVoiceSync).toHaveBeenCalledWith(SERVER_ID, MEMBER);
  });

  it('a rejected kick touches neither the membership nor voice', async () => {
    dbFns.getHighestRolePosition.mockResolvedValue(3); // equal rank
    const res = await del(MOD, MEMBER);
    expect(res.status).toBe(403);
    expect(dbFns.removeMember).not.toHaveBeenCalled();
    expect(queueMemberVoiceSync).not.toHaveBeenCalled();
  });
});
