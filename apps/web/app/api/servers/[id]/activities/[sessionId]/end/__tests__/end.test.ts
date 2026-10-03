import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * security-review PLUG-002: POST …/activities/{sessionId}/end must check
 * server membership like GET/actions/SSE do. Channel visibility passes for
 * anyone on a channel without overrides and the host shortcut skips the
 * permission check, so a kicked or banned host could still end their game.
 *
 * The REAL `@/lib/permissions` runs here (only the db is mocked), so the
 * central guard in authorizeChannelVisibility is exercised too.
 */

const dbFns = {
  endGameSession: vi.fn(),
  getGameSessionById: vi.fn(),
  getServerById: vi.fn(),
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  logAction: vi.fn(),
};

vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
vi.mock('@/lib/activity-bus', () => ({ publishActivityStateChange: vi.fn() }));

const SECRET = 'x'.repeat(32);
const SERVER_ID = 'srv-1';
const OWNER = '00000000-0000-0000-0000-000000000099';
const HOST = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = 'sess-1';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(dbFns)) fn.mockReset();
  dbFns.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER });
  dbFns.getGameSessionById.mockResolvedValue({
    id: SESSION_ID,
    serverId: SERVER_ID,
    channelId: 'ch-open',
    pluginId: 'vampire-village',
    createdBy: HOST,
    status: 'running',
  });
  // An open channel: no overrides, so visibility alone admits anyone.
  dbFns.canMemberAccessChannel.mockResolvedValue(true);
  dbFns.endGameSession.mockResolvedValue({ id: SESSION_ID, status: 'ended', endedAt: new Date(), publicSummary: undefined });
  dbFns.logAction.mockResolvedValue(undefined);
});

async function end(uid: string): Promise<Response> {
  const { POST } = await import('../route.js');
  const handler = POST as unknown as (req: Request, ctx: unknown) => Promise<Response>;
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  const cookie = `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
  return handler(
    new Request(`http://localhost/api/servers/${SERVER_ID}/activities/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { cookie },
    }),
    { params: Promise.resolve({ id: SERVER_ID, sessionId: SESSION_ID }) }
  );
}

describe('POST activity end — security-review PLUG-002', () => {
  it('a host who is no longer a member (kicked / banned) gets 403 and ends nothing', async () => {
    dbFns.isServerMember.mockResolvedValue(false);
    dbFns.getUserPermissions.mockResolvedValue([]);
    const res = await end(HOST);
    expect(res.status).toBe(403);
    expect(dbFns.endGameSession).not.toHaveBeenCalled();
    expect(dbFns.logAction).not.toHaveBeenCalled();
  });

  it('a host who is still a member can end their own game', async () => {
    dbFns.isServerMember.mockResolvedValue(true);
    dbFns.getUserPermissions.mockResolvedValue(['send_messages']);
    const res = await end(HOST);
    expect(res.status).toBe(200);
    expect(dbFns.endGameSession).toHaveBeenCalledWith(expect.anything(), SESSION_ID);
    expect(dbFns.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'activity.end', actorUserId: HOST, metadata: { pluginId: 'vampire-village', wasHost: true } })
    );
  });

  it('the owner needs no membership row', async () => {
    // getUserPermissions reports the owner's implicit administrator.
    dbFns.getUserPermissions.mockResolvedValue(['administrator']);
    const res = await end(OWNER);
    expect(res.status).toBe(200);
    expect(dbFns.isServerMember).not.toHaveBeenCalled();
  });
});

describe('authorizeChannelVisibility — security-review PLUG-002 central guard', () => {
  it('refuses a non-member on a channel without overrides', async () => {
    const { authorizeChannelVisibility } = await import('@/lib/permissions');
    dbFns.getUserPermissions.mockResolvedValue([]);
    dbFns.isServerMember.mockResolvedValue(false);
    const result = await authorizeChannelVisibility(HOST, SERVER_ID, 'ch-open', OWNER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expect(dbFns.canMemberAccessChannel).not.toHaveBeenCalled();
  });

  it('still admits a member whose roles grant no permissions', async () => {
    const { authorizeChannelVisibility } = await import('@/lib/permissions');
    dbFns.getUserPermissions.mockResolvedValue([]);
    dbFns.isServerMember.mockResolvedValue(true);
    const result = await authorizeChannelVisibility(HOST, SERVER_ID, 'ch-open', OWNER);
    expect(result.ok).toBe(true);
  });

  it('asks for membership only when the permission list is empty', async () => {
    const { authorizeChannelVisibility } = await import('@/lib/permissions');
    dbFns.getUserPermissions.mockResolvedValue(['send_messages']);
    const result = await authorizeChannelVisibility(HOST, SERVER_ID, 'ch-open', OWNER);
    expect(result.ok).toBe(true);
    expect(dbFns.isServerMember).not.toHaveBeenCalled();
  });
});
