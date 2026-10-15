import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * The community banner (POST to set or clear, DELETE to clear) is a
 * Manage Community setting. Security review 2026-10 (A1): a timed-out
 * manager kept changing it — the timeout only reached the moderation gate.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  getActiveMemberTimeout: vi.fn(),
  updateServerBannerUrl: vi.fn(),
  logAction: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/mail/verification', () => ({ requireVerifiedEmail: vi.fn(async () => null) }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MANAGER = '33333333-3333-4333-8333-333333333333';

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function send(method: 'POST' | 'DELETE', uid: string): Promise<Response> {
  const route = await import('../route.js');
  return route[method](
    new Request(`https://chat.example.test/api/servers/${SERVER}/banner`, {
      method,
      headers: { cookie: cookie(uid), 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ dataUrl: null }) } : {}),
    }),
    { params: Promise.resolve({ id: SERVER }) }
  );
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of Object.values(db)) fn.mockReset();
  db.getServerById.mockResolvedValue({ id: SERVER, ownerUserId: OWNER });
  db.isServerMember.mockResolvedValue(true);
  db.getUserPermissions.mockImplementation(async (_db: unknown, uid: string) =>
    uid === OWNER ? ['administrator'] : ['manage_server']
  );
  db.getActiveMemberTimeout.mockResolvedValue(null);
  db.updateServerBannerUrl.mockResolvedValue({ bannerUrl: null });
  db.logAction.mockResolvedValue(undefined);
});

describe('community banner — a timed-out manager changes nothing (actor_timed_out)', () => {
  it('POST and DELETE are refused before the banner is touched', async () => {
    const until = new Date(Date.now() + 60_000);
    db.getActiveMemberTimeout.mockResolvedValue(until);
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await send(method, MANAGER);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'actor_timed_out', until: until.toISOString() });
    }
    expect(db.getActiveMemberTimeout).toHaveBeenCalledWith({ __mockDb: true }, SERVER, MANAGER);
    expect(db.updateServerBannerUrl).not.toHaveBeenCalled();
    expect(db.logAction).not.toHaveBeenCalled();
  });

  it('a manager who is not timed out clears the banner', async () => {
    expect((await send('DELETE', MANAGER)).status).toBe(200);
    expect(db.updateServerBannerUrl).toHaveBeenCalledWith({ __mockDb: true }, SERVER, null);
  });

  it('the owner is never asked about a timeout', async () => {
    db.getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + 60_000));
    expect((await send('POST', OWNER)).status).toBe(200);
    expect(db.getActiveMemberTimeout).not.toHaveBeenCalled();
  });
});
