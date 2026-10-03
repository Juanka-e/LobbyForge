import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * The join approval queue's API:
 *   GET  /api/servers/{id}/join-requests              (moderators)
 *   POST /api/servers/{id}/join-requests/{requestId}  (approve / reject)
 *   GET / POST / DELETE /api/servers/{id}/join-requests/mine (the requester)
 * Reviewing needs KICK_MEMBERS or MANAGE_SERVER (lib/join-requests.ts).
 * Ids that are not UUIDs answer 404 before any database call.
 */

const getUserPermissions = vi.fn();
const listJoinRequestsForServer = vi.fn();
const approveJoinRequest = vi.fn();
const rejectJoinRequest = vi.fn();
const logAction = vi.fn();
const getOpenJoinRequest = vi.fn();
const cancelJoinRequest = vi.fn();
const getServerById = vi.fn();
const requireServerMember = vi.fn();
const notifyMemberJoined = vi.fn();
const requestToJoinServer = vi.fn();
const resolveAutoJoinServerId = vi.fn();

vi.mock('@lobbyforge/db', async () => {
  const actual = await vi.importActual<typeof import('@lobbyforge/db')>('@lobbyforge/db');
  return {
    getUserPermissions,
    listJoinRequestsForServer,
    approveJoinRequest,
    rejectJoinRequest,
    logAction,
    getOpenJoinRequest,
    cancelJoinRequest,
    getServerById,
    requestToJoinServer,
    joinRequestRetryAfter: actual.joinRequestRetryAfter,
    JOIN_REQUEST_NOTE_MAX_LENGTH: actual.JOIN_REQUEST_NOTE_MAX_LENGTH,
  };
});
vi.mock('@/lib/api-auth', async () => {
  const core = await vi.importActual<typeof import('@lobbyforge/core')>('@lobbyforge/core');
  const { readGuestSession } = await vi.importActual<typeof import('@/lib/guest-session')>('@/lib/guest-session');
  return {
    CorePermission: core.CorePermission,
    hasPermission: core.hasPermission,
    // Real signed-cookie parsing, like the real helper.
    requireMaterializedSession: (req: Request) => {
      const session = readGuestSession(req.headers.get('cookie'), SECRET);
      if (!session?.uid) {
        return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
      }
      return { ok: true, session };
    },
    requireServerMember,
  };
});
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/bots/welcome', () => ({ notifyMemberJoined }));
vi.mock('@/lib/lobby-auto-join', () => ({ resolveAutoJoinServerId }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const MOD = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_SERVER_REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const CREATED = new Date('2026-10-01T09:00:00Z');
const DECIDED = new Date('2026-10-03T09:00:00Z');

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Someone' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    serverId: SERVER,
    userId: USER,
    source: 'invite',
    inviteCode: 'ABCD2345EFGH',
    note: 'friend of Ada',
    status: 'pending',
    createdAt: CREATED,
    decidedAt: null,
    decidedBy: null,
    displayName: 'Newcomer',
    isGuest: true,
    accountCreatedAt: CREATED,
    inviterName: 'Owner',
    decidedByName: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [
    getUserPermissions,
    listJoinRequestsForServer,
    approveJoinRequest,
    rejectJoinRequest,
    logAction,
    getOpenJoinRequest,
    cancelJoinRequest,
    getServerById,
    requireServerMember,
    notifyMemberJoined,
    requestToJoinServer,
    resolveAutoJoinServerId,
  ]) {
    fn.mockReset();
  }
  resolveAutoJoinServerId.mockResolvedValue(SERVER);
  logAction.mockResolvedValue(undefined);
  notifyMemberJoined.mockResolvedValue(undefined);
  requireServerMember.mockResolvedValue({ ok: true });
  getUserPermissions.mockResolvedValue(['kick_members']);
  getServerById.mockResolvedValue({ id: SERVER, ownerUserId: MOD });
  listJoinRequestsForServer.mockResolvedValue({ requests: [row()], pendingCount: 1, nextOffset: null });
});

describe('GET /api/servers/{id}/join-requests', () => {
  const list = async (query = '', uid: string | null = MOD) => {
    const { GET } = await import('../route');
    return GET(
      new Request(`https://chat.example.test/api/servers/${SERVER}/join-requests${query}`, {
        headers: uid ? { cookie: cookie(uid) } : {},
      }),
      { params: Promise.resolve({ id: SERVER }) }
    );
  };

  it('lists pending requests for a KICK_MEMBERS moderator, without invite codes', async () => {
    const res = await list('?limit=10&offset=20');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { requests: Array<Record<string, unknown>>; pendingCount: number };
    expect(json.pendingCount).toBe(1);
    expect(json.requests[0]).toMatchObject({
      id: REQUEST_ID,
      displayName: 'Newcomer',
      note: 'friend of Ada',
      inviterName: 'Owner',
      inviteCode: null,
      createdAt: CREATED.toISOString(),
    });
    expect(listJoinRequestsForServer).toHaveBeenCalledWith({ __mockDb: true }, SERVER, {
      status: 'pending',
      limit: 10,
      offset: 20,
    });
  });

  it('shows invite codes to MANAGE_SERVER holders', async () => {
    getUserPermissions.mockResolvedValue(['manage_server']);
    const res = await list('?status=all');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { requests: Array<{ inviteCode: string | null }> };
    expect(json.requests[0]!.inviteCode).toBe('ABCD2345EFGH');
    expect(listJoinRequestsForServer).toHaveBeenCalledWith({ __mockDb: true }, SERVER, {
      status: 'all',
      limit: 50,
      offset: 0,
    });
  });

  it('403 for a member without KICK_MEMBERS or MANAGE_SERVER', async () => {
    getUserPermissions.mockResolvedValue(['ban_members', 'moderate_members', 'send_messages']);
    expect((await list()).status).toBe(403);
    expect(listJoinRequestsForServer).not.toHaveBeenCalled();
  });

  it('404 for a server id that is not a UUID — before any database call', async () => {
    const { GET } = await import('../route');
    const res = await GET(
      new Request('https://chat.example.test/api/servers/not-a-uuid/join-requests', { headers: { cookie: cookie(MOD) } }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) }
    );
    expect(res.status).toBe(404);
    expect(requireServerMember).not.toHaveBeenCalled();
    expect(listJoinRequestsForServer).not.toHaveBeenCalled();
  });

  it('403 for a non-member, 401 without a session, 400 for a bad query', async () => {
    requireServerMember.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    expect((await list()).status).toBe(403);
    expect((await list('', null)).status).toBe(401);
    expect((await list('?limit=1000')).status).toBe(400);
    expect(listJoinRequestsForServer).not.toHaveBeenCalled();
  });
});

describe('POST /api/servers/{id}/join-requests/{requestId}', () => {
  const decide = async (body: unknown, requestId = REQUEST_ID, serverId = SERVER) => {
    const { POST } = await import('../[requestId]/route');
    return POST(
      new Request(`https://chat.example.test/api/servers/${serverId}/join-requests/${requestId}`, {
        method: 'POST',
        headers: { cookie: cookie(MOD), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: serverId, requestId }) }
    );
  };
  const decided = (status: string) => row({ status, decidedAt: DECIDED, decidedBy: MOD });

  it('approve creates the membership, greets the new member and audits member.join_approved', async () => {
    approveJoinRequest.mockResolvedValue({
      ok: true,
      created: true,
      request: decided('approved'),
      membership: { id: 'm-1', serverId: SERVER, userId: USER },
    });
    const res = await decide({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      request: { id: REQUEST_ID, status: 'approved', decidedBy: MOD },
      membership: { serverId: SERVER, userId: USER },
    });
    expect(approveJoinRequest).toHaveBeenCalledWith({ __mockDb: true }, { serverId: SERVER, requestId: REQUEST_ID, decidedBy: MOD });
    expect(notifyMemberJoined).toHaveBeenCalledWith({ serverId: SERVER, userId: USER });
    expect(logAction).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({
        serverId: SERVER,
        actorUserId: MOD,
        action: 'member.join_approved',
        targetType: 'user',
        targetId: USER,
        metadata: { requestId: REQUEST_ID, source: 'invite', membershipId: 'm-1' },
      })
    );
  });

  it('the audit rows never carry the invite code (audit readers may not see codes)', async () => {
    approveJoinRequest.mockResolvedValue({
      ok: true,
      created: true,
      request: decided('approved'),
      membership: { id: 'm-1', serverId: SERVER, userId: USER },
    });
    rejectJoinRequest.mockResolvedValue({ ok: true, request: decided('rejected') });
    await decide({ action: 'approve' });
    await decide({ action: 'reject' });
    expect(logAction).toHaveBeenCalledTimes(2);
    for (const [, entry] of logAction.mock.calls as Array<[unknown, { metadata: Record<string, unknown> }]>) {
      expect(entry.metadata).not.toHaveProperty('inviteCode');
      expect(entry.metadata.source).toBe('invite');
      expect(JSON.stringify(entry)).not.toContain('ABCD2345EFGH');
    }
  });

  it('an approval that found an existing membership greets no one', async () => {
    approveJoinRequest.mockResolvedValue({
      ok: true,
      created: false,
      request: decided('approved'),
      membership: { id: 'm-1', serverId: SERVER, userId: USER },
    });
    expect((await decide({ action: 'approve' })).status).toBe(200);
    expect(notifyMemberJoined).not.toHaveBeenCalled();
  });

  it('reject audits member.join_rejected and creates nothing', async () => {
    rejectJoinRequest.mockResolvedValue({ ok: true, request: decided('rejected') });
    const res = await decide({ action: 'reject' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request: { status: 'rejected' } });
    expect(approveJoinRequest).not.toHaveBeenCalled();
    expect(notifyMemberJoined).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({
        action: 'member.join_rejected',
        targetId: USER,
        metadata: { requestId: REQUEST_ID, source: 'invite' },
      })
    );
  });

  it('a banned requester is not admitted (409 banned)', async () => {
    approveJoinRequest.mockResolvedValue({ ok: false, error: 'banned', request: decided('rejected') });
    const res = await decide({ action: 'approve' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'banned' });
    expect(notifyMemberJoined).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('a decided request answers 409 not_pending; an unknown one 404', async () => {
    approveJoinRequest.mockResolvedValue({ ok: false, error: 'not_pending', request: decided('approved') });
    const conflict = await decide({ action: 'approve' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'not_pending', status: 'approved' });
    rejectJoinRequest.mockResolvedValue({ ok: false, error: 'not_found' });
    expect((await decide({ action: 'reject' })).status).toBe(404);
  });

  it('403 without KICK_MEMBERS or MANAGE_SERVER — nothing is decided', async () => {
    getUserPermissions.mockResolvedValue(['ban_members', 'create_invite']);
    expect((await decide({ action: 'approve' })).status).toBe(403);
    expect((await decide({ action: 'reject' })).status).toBe(403);
    expect(approveJoinRequest).not.toHaveBeenCalled();
    expect(rejectJoinRequest).not.toHaveBeenCalled();
  });

  it("another server's request id is not found here: 404, nothing decided, nothing audited", async () => {
    // The moderator reviews SERVER; the id belongs to another server's
    // queue. The lookup is scoped to the URL's server (the one whose
    // permissions were checked), so the query finds nothing.
    approveJoinRequest.mockResolvedValue({ ok: false, error: 'not_found' });
    rejectJoinRequest.mockResolvedValue({ ok: false, error: 'not_found' });
    expect((await decide({ action: 'approve' }, OTHER_SERVER_REQUEST_ID)).status).toBe(404);
    expect((await decide({ action: 'reject' }, OTHER_SERVER_REQUEST_ID)).status).toBe(404);
    expect(approveJoinRequest).toHaveBeenCalledWith(
      { __mockDb: true },
      { serverId: SERVER, requestId: OTHER_SERVER_REQUEST_ID, decidedBy: MOD }
    );
    expect(rejectJoinRequest).toHaveBeenCalledWith(
      { __mockDb: true },
      { serverId: SERVER, requestId: OTHER_SERVER_REQUEST_ID, decidedBy: MOD }
    );
    expect(getUserPermissions).toHaveBeenCalledWith({ __mockDb: true }, MOD, SERVER);
    expect(logAction).not.toHaveBeenCalled();
    expect(notifyMemberJoined).not.toHaveBeenCalled();
  });

  it('400 for an unknown action, 404 for a malformed request id or server id', async () => {
    expect((await decide({ action: 'ban' })).status).toBe(400);
    expect((await decide({ action: 'approve' }, 'not-a-uuid')).status).toBe(404);
    expect((await decide({ action: 'approve' }, REQUEST_ID, 'not-a-uuid')).status).toBe(404);
    expect((await decide({ action: 'reject' }, REQUEST_ID, "1' or '1'='1")).status).toBe(404);
    expect(requireServerMember).not.toHaveBeenCalled();
    expect(approveJoinRequest).not.toHaveBeenCalled();
    expect(rejectJoinRequest).not.toHaveBeenCalled();
  });
});

describe('/api/servers/{id}/join-requests/mine', () => {
  const call = async (method: 'GET' | 'DELETE', uid: string | null = USER, serverId = SERVER) => {
    const mod = await import('../mine/route');
    const handler = method === 'GET' ? mod.GET : mod.DELETE;
    return handler(
      new Request(`https://chat.example.test/api/servers/${serverId}/join-requests/mine`, {
        method,
        headers: uid ? { cookie: cookie(uid) } : {},
      }),
      { params: Promise.resolve({ id: serverId }) }
    );
  };

  it("returns the caller's pending request — only their own, without the note", async () => {
    getOpenJoinRequest.mockResolvedValue(row());
    const res = await call('GET');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { request: Record<string, unknown> };
    expect(json.request).toEqual({
      id: REQUEST_ID,
      status: 'pending',
      createdAt: CREATED.toISOString(),
      decidedAt: null,
      retryAfter: null,
    });
    expect(getOpenJoinRequest).toHaveBeenCalledWith({ __mockDb: true }, SERVER, USER);
  });

  it('a rejection carries the date the user may ask again', async () => {
    getOpenJoinRequest.mockResolvedValue(row({ status: 'rejected', decidedAt: DECIDED, decidedBy: MOD }));
    const json = (await (await call('GET')).json()) as { request: { status: string; retryAfter: string } };
    expect(json.request.status).toBe('rejected');
    expect(new Date(json.request.retryAfter).getTime()).toBe(DECIDED.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it('null when there is nothing open; 404 for an unknown server; 401 signed out', async () => {
    getOpenJoinRequest.mockResolvedValue(null);
    expect(await (await call('GET')).json()).toEqual({ request: null });
    getServerById.mockResolvedValueOnce(null);
    expect((await call('GET')).status).toBe(404);
    expect((await call('GET', null)).status).toBe(401);
  });

  it('404 for a server id that is not a UUID — before any database call', async () => {
    expect((await call('GET', USER, 'not-a-uuid')).status).toBe(404);
    expect((await call('DELETE', USER, 'not-a-uuid')).status).toBe(404);
    expect(getServerById).not.toHaveBeenCalled();
    expect(getOpenJoinRequest).not.toHaveBeenCalled();
    expect(cancelJoinRequest).not.toHaveBeenCalled();
  });

  it('DELETE withdraws the pending request', async () => {
    cancelJoinRequest.mockResolvedValue(row({ status: 'cancelled' }));
    const res = await call('DELETE');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(cancelJoinRequest).toHaveBeenCalledWith({ __mockDb: true }, SERVER, USER);
    cancelJoinRequest.mockResolvedValue(null);
    expect(await (await call('DELETE')).json()).toEqual({ cancelled: false });
  });
});

describe('POST /api/servers/{id}/join-requests/mine (the lobby "Ask to join")', () => {
  const ask = async (
    body: string | undefined,
    { uid = USER as string | null, serverId = SERVER }: { uid?: string | null; serverId?: string } = {}
  ) => {
    const { POST } = await import('../mine/route');
    return POST(
      new Request(`https://chat.example.test/api/servers/${serverId}/join-requests/mine`, {
        method: 'POST',
        headers: {
          ...(uid ? { cookie: cookie(uid) } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
      }),
      { params: Promise.resolve({ id: serverId }) }
    );
  };
  const filed = (overrides: Record<string, unknown> = {}) =>
    row({ source: 'auto_join', inviteCode: null, note: 'I host the Friday quiz', ...overrides });

  it('files an auto_join request with the note → 202 pending_approval', async () => {
    requestToJoinServer.mockResolvedValue({ kind: 'pending', created: true, request: filed() });
    const res = await ask(JSON.stringify({ note: 'I host the Friday quiz' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: 'pending_approval',
      request: { id: REQUEST_ID, serverId: SERVER, createdAt: CREATED.toISOString() },
    });
    expect(resolveAutoJoinServerId).toHaveBeenCalledWith({ __mockDb: true }, USER);
    expect(requestToJoinServer).toHaveBeenCalledWith(
      { __mockDb: true },
      { serverId: SERVER, userId: USER, note: 'I host the Friday quiz' }
    );
  });

  it('an empty body asks without a note; a repeat returns the pending request (202)', async () => {
    requestToJoinServer.mockResolvedValue({ kind: 'pending', created: false, request: filed({ note: null }) });
    const res = await ask(undefined);
    expect(res.status).toBe(202);
    expect(requestToJoinServer).toHaveBeenCalledWith({ __mockDb: true }, { serverId: SERVER, userId: USER, note: null });
  });

  it('403 invite_required for a server the lobby auto-join does not serve — nothing filed', async () => {
    resolveAutoJoinServerId.mockResolvedValue(null);
    const closed = await ask(undefined);
    expect(closed.status).toBe(403);
    expect(await closed.json()).toMatchObject({ code: 'invite_required' });
    resolveAutoJoinServerId.mockResolvedValue('99999999-9999-4999-8999-999999999999');
    expect((await ask(undefined)).status).toBe(403);
    expect(requestToJoinServer).not.toHaveBeenCalled();
  });

  it('keeps the invite-filed rules: banned, cooldown, daily limit', async () => {
    requestToJoinServer.mockResolvedValueOnce({ kind: 'banned' });
    const banned = await ask(undefined);
    expect(banned.status).toBe(403);
    expect(await banned.json()).toMatchObject({ code: 'banned' });

    const retryAfter = new Date('2026-10-10T09:00:00Z');
    requestToJoinServer.mockResolvedValueOnce({ kind: 'rejected', request: filed({ status: 'rejected' }), retryAfter });
    const rejected = await ask(undefined);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: 'join_rejected', retryAfter: retryAfter.toISOString() });

    requestToJoinServer.mockResolvedValueOnce({ kind: 'limited' });
    const limited = await ask(undefined);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'join_request_limit' });
  });

  it('409 for a member, or when the community admits newcomers without approval', async () => {
    requestToJoinServer.mockResolvedValueOnce({ kind: 'already_member' });
    const member = await ask(undefined);
    expect(member.status).toBe(409);
    expect(await member.json()).toMatchObject({ code: 'already_member' });
    requestToJoinServer.mockResolvedValueOnce({ kind: 'approval_not_required' });
    const open = await ask(undefined);
    expect(open.status).toBe(409);
    expect(await open.json()).toMatchObject({ code: 'approval_not_required' });
  });

  it('400 for a note over 500 characters, an unknown field or broken JSON — nothing filed', async () => {
    expect((await ask(JSON.stringify({ note: 'x'.repeat(501) }))).status).toBe(400);
    expect((await ask(JSON.stringify({ note: 'hi', source: 'invite' }))).status).toBe(400);
    expect((await ask('{"note":')).status).toBe(400);
    expect(requestToJoinServer).not.toHaveBeenCalled();
  });

  it('401 signed out; 404 for a non-UUID or unknown server — before anything is filed', async () => {
    expect((await ask(undefined, { uid: null })).status).toBe(401);
    expect((await ask(undefined, { serverId: 'not-a-uuid' })).status).toBe(404);
    expect(getServerById).not.toHaveBeenCalled();
    getServerById.mockResolvedValueOnce(null);
    expect((await ask(undefined)).status).toBe(404);
    expect(resolveAutoJoinServerId).not.toHaveBeenCalled();
    expect(requestToJoinServer).not.toHaveBeenCalled();
  });

  it('500 without details when the database fails', async () => {
    requestToJoinServer.mockRejectedValue(new Error('connection reset'));
    const res = await ask(undefined);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('connection reset');
  });
});
