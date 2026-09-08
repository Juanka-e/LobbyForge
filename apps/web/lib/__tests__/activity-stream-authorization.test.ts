/**
 * 9th-audit: the activity-stream authorization used by the SSE
 * keepalive. The kicked-user scenario is the regression that matters —
 * the old check (visibility-only) let a kicked member's open stream
 * keep flowing on public channels.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerById, isServerMember, authorizeChannelVisibility } = vi.hoisted(() => ({
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  authorizeChannelVisibility: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/permissions', () => ({ authorizeChannelVisibility }));

import { denyActivityStreamAccess } from '../activity-stream-authorization';

const UID = 'user-1';
const OWNER = 'owner-1';
const ROW = { id: 's-1', serverId: 'srv-1', channelId: 'ch-1' };

beforeEach(() => {
  getServerById.mockReset().mockResolvedValue({ id: 'srv-1', ownerUserId: OWNER });
  isServerMember.mockReset().mockResolvedValue(true);
  authorizeChannelVisibility.mockReset().mockResolvedValue({ ok: true });
});

describe('denyActivityStreamAccess', () => {
  it('allows an ordinary member on a visible channel', async () => {
    await expect(denyActivityStreamAccess(UID, { serverId: 'srv-1', channelId: 'ch-1', session: ROW })).resolves.toBeNull();
  });

  it('9th-audit REGRESSION: denies a KICKED member even on a PUBLIC channel', async () => {
    isServerMember.mockResolvedValue(false); // kicked
    // The old visibility-only path returned true for no-override
    // channels — this is exactly the hole.
    authorizeChannelVisibility.mockResolvedValue({ ok: true });
    const denial = await denyActivityStreamAccess(UID, { serverId: 'srv-1', channelId: 'ch-1', session: ROW });
    expect(denial?.status).toBe(403);
  });

  it('the owner bypasses membership but NOT session binding', async () => {
    await expect(denyActivityStreamAccess(OWNER, { serverId: 'srv-1', channelId: 'ch-1', session: ROW })).resolves.toBeNull();
    const denial = await denyActivityStreamAccess(OWNER, {
      serverId: 'srv-1',
      channelId: null,
      session: { id: 's-x', serverId: 'OTHER', channelId: null },
    });
    expect(denial?.status).toBe(404);
  });

  it('denies when the channel visibility policy rejects (role removed)', async () => {
    authorizeChannelVisibility.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'no access' }, { status: 403 }),
    });
    const denial = await denyActivityStreamAccess(UID, { serverId: 'srv-1', channelId: 'ch-1', session: ROW });
    expect(denial?.status).toBe(403);
  });

  it('404 when the server disappeared', async () => {
    getServerById.mockResolvedValue(null);
    const denial = await denyActivityStreamAccess(UID, { serverId: 'gone', channelId: null, session: ROW });
    expect(denial?.status).toBe(404);
  });
});
