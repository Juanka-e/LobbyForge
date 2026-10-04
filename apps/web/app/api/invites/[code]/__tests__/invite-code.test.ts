import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

const getInviteMetadata = vi.fn();
const redeemInvite = vi.fn();
const logAction = vi.fn();
const getServerAccessPolicy = vi.fn();
const notifyMemberJoined = vi.fn();

vi.mock('@lobbyforge/db', async () => {
  const actual = await vi.importActual<typeof import('@lobbyforge/db')>('@lobbyforge/db');
  return {
    getInviteMetadata,
    redeemInvite,
    logAction,
    getServerAccessPolicy,
    accessPolicyRequiresApproval: actual.accessPolicyRequiresApproval,
    JOIN_REQUEST_NOTE_MAX_LENGTH: actual.JOIN_REQUEST_NOTE_MAX_LENGTH,
  };
});
vi.mock('@/lib/bots/welcome', () => ({ notifyMemberJoined }));
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
  getServerAccessPolicy.mockReset();
  getServerAccessPolicy.mockResolvedValue(null);
  notifyMemberJoined.mockReset();
  notifyMemberJoined.mockResolvedValue(undefined);
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
    const json = (await res.json()) as { invite: { serverName: string; requiresApproval: boolean } };
    expect(json.invite.serverName).toBe('Community');
    expect(json.invite.requiresApproval).toBe(false);
  });

  it('says when the server reviews new members (the join page offers a note)', async () => {
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
    getServerAccessPolicy.mockResolvedValue({
      joinPolicy: 'public_with_approval',
      accountLinking: 'allow_link',
      requireApprovalForFirstJoin: false,
    });
    const { GET } = await import('../route.js');
    const res = await GET(new Request(`https://example.test/api/invites/${CODE}`), {
      params: Promise.resolve({ code: CODE }),
    });
    expect(((await res.json()) as { invite: { requiresApproval: boolean } }).invite.requiresApproval).toBe(true);
    expect(getServerAccessPolicy).toHaveBeenCalledWith({ __mockDb: true }, 'srv-1');
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

  // security-review AUTHZ-004 follow-up: under an approval policy the
  // redeem files a join request — 202, no membership, no join hook, no audit.
  describe('under an approval policy (the join queue)', () => {
    const CREATED = new Date('2026-10-03T10:00:00Z');
    const pending = (created: boolean) => ({
      ok: false,
      error: 'pending_approval',
      serverId: 'srv-1',
      created,
      request: { id: 'jr-1', serverId: 'srv-1', userId: 'u', status: 'pending', createdAt: CREATED },
    });
    const post = async (init: RequestInit = {}) => {
      const { POST } = await import('../redeem/route.js');
      return POST(
        new Request(`https://example.test/api/invites/${CODE}/redeem`, {
          method: 'POST',
          ...init,
          headers: { cookie: makeCookie(), ...(init.headers as Record<string, string> | undefined) },
        }),
        { params: Promise.resolve({ code: CODE }) }
      );
    };

    it('answers 202 pending_approval and greets / logs no one', async () => {
      redeemInvite.mockResolvedValue(pending(true));
      const res = await post();
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: 'pending_approval',
        request: { id: 'jr-1', serverId: 'srv-1', createdAt: CREATED.toISOString() },
      });
      expect(logAction).not.toHaveBeenCalled();
      expect(notifyMemberJoined).not.toHaveBeenCalled();
    });

    it('a repeat redeem returns the same pending request', async () => {
      redeemInvite.mockResolvedValue(pending(false));
      const res = await post();
      expect(res.status).toBe(202);
      expect(((await res.json()) as { request: { id: string } }).request.id).toBe('jr-1');
    });

    it('passes the optional note to the request', async () => {
      redeemInvite.mockResolvedValue(pending(true));
      const res = await post({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'friend of Ada' }),
      });
      expect(res.status).toBe(202);
      expect(redeemInvite).toHaveBeenCalledWith(
        { __mockDb: true },
        CODE,
        '00000000-0000-0000-0000-000000000099',
        { note: 'friend of Ada' }
      );
    });

    it('refuses a note over 500 characters or an unknown field', async () => {
      for (const body of [{ note: 'x'.repeat(501) }, { note: 'hi', extra: true }]) {
        const res = await post({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(400);
        vi.resetModules();
      }
      expect(redeemInvite).not.toHaveBeenCalled();
    });

    it('a rejected requester gets 403 join_rejected with the retry date', async () => {
      redeemInvite.mockResolvedValue({
        ok: false,
        error: 'join_rejected',
        serverId: 'srv-1',
        retryAfter: new Date('2026-10-10T00:00:00Z'),
      });
      const res = await post();
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'join_rejected', retryAfter: '2026-10-10T00:00:00.000Z' });
    });

    it('the daily request limit answers 429', async () => {
      redeemInvite.mockResolvedValue({ ok: false, error: 'join_request_limit', serverId: 'srv-1' });
      const res = await post();
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ code: 'join_request_limit' });
    });
  });

  it('logs an unexpected failure (JSON-quoted, without the invite code) and answers 500', async () => {
    // A Drizzle query error carries the query parameters in its own message;
    // only the driver error it wraps may reach the log.
    const driverError = Object.assign(new TypeError('invite.expires_at.getTime is not a function\nforged line'), {
      code: 'XX000',
    });
    redeemInvite.mockRejectedValue(
      new Error(`Failed query: select ... params: ${CODE},00000000-0000-0000-0000-000000000099`, { cause: driverError })
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { POST } = await import('../redeem/route.js');
      const res = await POST(
        new Request(`https://example.test/api/invites/${CODE}/redeem`, {
          method: 'POST',
          headers: { cookie: makeCookie() },
        }),
        { params: Promise.resolve({ code: CODE }) }
      );
      expect(res.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [prefix, detail] = errorSpy.mock.calls[0] as [string, string];
      expect(prefix).toBe('[invites/redeem] redeem failed:');
      expect(JSON.parse(detail)).toEqual({
        error: 'TypeError',
        code: 'XX000',
        message: 'invite.expires_at.getTime is not a function\nforged line',
      });
      expect(detail).not.toContain('\n');
      expect(detail).not.toContain(CODE);
    } finally {
      errorSpy.mockRestore();
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
