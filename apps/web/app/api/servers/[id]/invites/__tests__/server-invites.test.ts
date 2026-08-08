import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';
import { NextResponse } from 'next/server';

const authorizeServerPermission = vi.fn();
const getServerById = vi.fn();
const isServerMember = vi.fn();
const listInvitesForServer = vi.fn();
const createInvite = vi.fn();
const getInviteById = vi.fn();
const revokeInvite = vi.fn();
const logAction = vi.fn();

vi.mock('@/lib/permissions', () => ({
  CorePermission: { CREATE_INVITE: 'create_invite', MANAGE_SERVER: 'manage_server' },
  authorizeServerPermission,
}));
vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  listInvitesForServer,
  createInvite,
  getInviteById,
  revokeInvite,
  logAction,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };
const SERVER_ID = '00000000-0000-0000-0000-000000000001';
const UID = '00000000-0000-0000-0000-000000000099';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  vi.resetModules();
  authorizeServerPermission.mockReset();
  getServerById.mockReset();
  isServerMember.mockReset();
  listInvitesForServer.mockReset();
  createInvite.mockReset();
  getInviteById.mockReset();
  revokeInvite.mockReset();
  logAction.mockReset();
  logAction.mockResolvedValue(undefined);
  // Defaults: caller is the owner (so the GET list path skips membership/perm check).
  getServerById.mockResolvedValue({ ownerUserId: UID });
  authorizeServerPermission.mockResolvedValue({ ok: true });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeCookie(uid: string = UID): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function serverCtx() {
  return { params: Promise.resolve({ id: SERVER_ID }) };
}

describe('GET /api/servers/[id]/invites', () => {
  it('returns the invite list for the server owner', async () => {
    listInvitesForServer.mockResolvedValue([
      {
        id: 'inv-1',
        serverId: SERVER_ID,
        createdBy: UID,
        code: 'ABCD1234EFGH',
        maxUses: null,
        currentUses: 0,
        expiresAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites`, { headers: { cookie: makeCookie() } }),
      serverCtx()
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { invites: Array<{ code: string }> };
    expect(json.invites).toHaveLength(1);
  });

  it('returns 403 when a non-owner member lacks CREATE_INVITE permission', async () => {
    getServerById.mockResolvedValue({ ownerUserId: '00000000-0000-0000-0000-0000000000BB' });
    isServerMember.mockResolvedValue(true);
    authorizeServerPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites`, { headers: { cookie: makeCookie() } }),
      serverCtx()
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when the server does not exist', async () => {
    getServerById.mockResolvedValue(null);
    const { GET } = await import('../route.js');
    const res = await GET(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites`, { headers: { cookie: makeCookie() } }),
      serverCtx()
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 when no cookie is present', async () => {
    const { GET } = await import('../route.js');
    const res = await GET(new Request(`https://example.test/api/servers/${SERVER_ID}/invites`), serverCtx());
    expect(res.status).toBe(401);
  });
});

describe('POST /api/servers/[id]/invites', () => {
  it('creates an invite and returns 201 when CREATE_INVITE is granted', async () => {
    createInvite.mockResolvedValue({
      id: 'inv-2',
      serverId: SERVER_ID,
      createdBy: UID,
      code: 'NEWCODE12345',
      maxUses: 5,
      currentUses: 0,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites`, {
        method: 'POST',
        headers: { cookie: makeCookie() },
        body: JSON.stringify({ maxUses: 5 }),
      }),
      serverCtx()
    );
    expect(res.status).toBe(201);
    expect(createInvite).toHaveBeenCalledWith(
      { __mockDb: true },
      expect.objectContaining({ serverId: SERVER_ID, createdBy: UID, maxUses: 5 })
    );
  });

  it('returns 403 when CREATE_INVITE permission is missing', async () => {
    authorizeServerPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites`, {
        method: 'POST',
        headers: { cookie: makeCookie() },
        body: JSON.stringify({}),
      }),
      serverCtx()
    );
    expect(res.status).toBe(403);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('returns 400 for an out-of-range maxUses', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites`, {
        method: 'POST',
        headers: { cookie: makeCookie() },
        body: JSON.stringify({ maxUses: 99999 }),
      }),
      serverCtx()
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/servers/[id]/invites/[inviteId]', () => {
  const INVITE_ID = '00000000-0000-0000-0000-0000000000EE';

  function inviteCtx() {
    return { params: Promise.resolve({ id: SERVER_ID, inviteId: INVITE_ID }) };
  }

  it('revokes the invite and returns ok when permission is granted', async () => {
    getInviteById.mockResolvedValue({ serverId: SERVER_ID });
    const { DELETE } = await import('../[inviteId]/route.js');
    const res = await DELETE(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites/${INVITE_ID}`, {
        method: 'DELETE',
        headers: { cookie: makeCookie() },
      }),
      inviteCtx()
    );
    expect(res.status).toBe(200);
    expect(revokeInvite).toHaveBeenCalledWith({ __mockDb: true }, INVITE_ID);
  });

  it('returns 404 when the invite belongs to a different server', async () => {
    getInviteById.mockResolvedValue({ serverId: '00000000-0000-0000-0000-0000000000DD' });
    const { DELETE } = await import('../[inviteId]/route.js');
    const res = await DELETE(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites/${INVITE_ID}`, {
        method: 'DELETE',
        headers: { cookie: makeCookie() },
      }),
      inviteCtx()
    );
    expect(res.status).toBe(404);
    expect(revokeInvite).not.toHaveBeenCalled();
  });

  it('returns 403 when CREATE_INVITE permission is missing', async () => {
    authorizeServerPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const { DELETE } = await import('../[inviteId]/route.js');
    const res = await DELETE(
      new Request(`https://example.test/api/servers/${SERVER_ID}/invites/${INVITE_ID}`, {
        method: 'DELETE',
        headers: { cookie: makeCookie() },
      }),
      inviteCtx()
    );
    expect(res.status).toBe(403);
  });
});
