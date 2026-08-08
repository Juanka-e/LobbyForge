import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const getInviteMetadata = vi.fn();
const redeemInvite = vi.fn();
const logAction = vi.fn();

vi.mock('@lobbyforge/db', () => ({ getInviteMetadata, redeemInvite, logAction }));
vi.mock('@/lib/invite-code', () => ({ normalizeInviteCode: (c: string) => c }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };
const CODE = 'ABCD1234EFGH';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  getInviteMetadata.mockReset();
  redeemInvite.mockReset();
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeCookie(uid: string = '00000000-0000-0000-0000-000000000099'): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

describe('GET /api/invites/[code]', () => {
  it('returns the invite metadata when the invite exists', async () => {
    getInviteMetadata.mockResolvedValue({
      code: CODE,
      serverId: 'srv-1',
      serverName: 'Community',
      expiresAt: null,
      currentUses: 0,
      maxUses: null,
      isExpired: false,
      isExhausted: false,
    });
    const { GET } = await import('../route.js');
    const res = await GET(new Request(`https://example.test/api/invites/${CODE}`), {
      params: Promise.resolve({ code: CODE }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { invite: { serverName: string } };
    expect(json.invite.serverName).toBe('Community');
  });

  it('returns 404 when the invite does not exist', async () => {
    getInviteMetadata.mockResolvedValue(null);
    const { GET } = await import('../route.js');
    const res = await GET(new Request(`https://example.test/api/invites/${CODE}`), {
      params: Promise.resolve({ code: CODE }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the code is empty (fails normalization)', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(new Request('https://example.test/api/invites/'), {
      params: Promise.resolve({ code: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/invites/[code]/redeem', () => {
  it('creates a membership and returns 201 on a successful redeem', async () => {
    redeemInvite.mockResolvedValue({
      ok: true,
      serverId: 'srv-1',
      membershipId: 'mem-1',
      roleId: 'role-1',
    });
    const { POST } = await import('../redeem/route.js');
    const res = await POST(
      new Request(`https://example.test/api/invites/${CODE}/redeem`, {
        method: 'POST',
        headers: { cookie: makeCookie() },
      }),
      { params: Promise.resolve({ code: CODE }) }
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { membership: { serverId: string } };
    expect(json.membership.serverId).toBe('srv-1');
  });

  it('returns 409 when the user is already a member', async () => {
    redeemInvite.mockResolvedValue({ ok: false, error: 'already_member' });
    const { POST } = await import('../redeem/route.js');
    const res = await POST(
      new Request(`https://example.test/api/invites/${CODE}/redeem`, {
        method: 'POST',
        headers: { cookie: makeCookie() },
      }),
      { params: Promise.resolve({ code: CODE }) }
    );
    expect(res.status).toBe(409);
  });

  it('returns 403 when the invite is expired, exhausted, or not found', async () => {
    for (const error of ['expired', 'exhausted', 'not_found', 'banned'] as const) {
      redeemInvite.mockResolvedValue({ ok: false, error });
      const { POST } = await import('../redeem/route.js');
      const res = await POST(
        new Request(`https://example.test/api/invites/${CODE}/redeem`, {
          method: 'POST',
          headers: { cookie: makeCookie() },
        }),
        { params: Promise.resolve({ code: CODE }) }
      );
      expect(res.status).toBe(403);
      vi.resetModules();
    }
  });

  it('returns 401 when no cookie is present', async () => {
    const { POST } = await import('../redeem/route.js');
    const res = await POST(
      new Request(`https://example.test/api/invites/${CODE}/redeem`, { method: 'POST' }),
      { params: Promise.resolve({ code: CODE }) }
    );
    expect(res.status).toBe(401);
  });

  it('logs the invite.redeem audit action on success', async () => {
    redeemInvite.mockResolvedValue({
      ok: true,
      serverId: 'srv-1',
      membershipId: 'mem-1',
      roleId: 'role-1',
    });
    const { POST } = await import('../redeem/route.js');
    const res = await POST(
      new Request(`https://example.test/api/invites/${CODE}/redeem`, {
        method: 'POST',
        headers: { cookie: makeCookie() },
      }),
      { params: Promise.resolve({ code: CODE }) }
    );
    expect(res.status).toBe(201);
    expect(logAction).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ action: 'invite.redeem' })
    );
  });
});
