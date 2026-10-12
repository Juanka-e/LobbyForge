import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

// Mock the db query layer.
const getServerById = vi.fn();
const isServerMember = vi.fn();
const listAuditLogsForServer = vi.fn();
const getUserPermissions = vi.fn();
const listChannelsForServer = vi.fn();
const listVisibleChannelsForMember = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  listAuditLogsForServer,
  getUserPermissions,
  listChannelsForServer,
  listVisibleChannelsForMember,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDbClient: true }),
}));

const SECRET = 'x'.repeat(32);
const envSnapshot = { ...process.env };

const SERVER_ID = 'srv-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const MEMBER_ID = '00000000-0000-0000-0000-000000000002';
const OUTSIDER_ID = '00000000-0000-0000-0000-000000000003';

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  getServerById.mockReset();
  isServerMember.mockReset();
  listAuditLogsForServer.mockReset();
  getUserPermissions.mockReset();
  listChannelsForServer.mockReset();
  listVisibleChannelsForMember.mockReset();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete (process.env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    (process.env as Record<string, string | undefined>)[key] = envSnapshot[key];
  }
});

function makeSessionCookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Guest test' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

async function loadRoute() {
  return import('../route.js');
}

function makeReq(url: string, cookie: string | null) {
  const headers: Record<string, string> = {};
  if (cookie) headers['cookie'] = cookie;
  return new Request(url, { method: 'GET', headers });
}

describe('GET /api/servers/{id}/audit-logs', () => {
  it('returns 401 when no session is present', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq(`http://localhost/api/servers/${SERVER_ID}/audit-logs`, null), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the server does not exist', async () => {
    getServerById.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/audit-logs`, makeSessionCookie(OWNER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for non-members who are not the owner', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    isServerMember.mockResolvedValue(false);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/audit-logs`, makeSessionCookie(OUTSIDER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for members without VIEW_AUDIT_LOG', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    isServerMember.mockResolvedValue(true);
    getUserPermissions.mockResolvedValue([]);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/audit-logs`, makeSessionCookie(MEMBER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it('returns 200 for the owner with the audit-log list', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    getUserPermissions.mockResolvedValue(['administrator']);
    listAuditLogsForServer.mockResolvedValue([
      {
        id: 'log-1',
        serverId: SERVER_ID,
        actorUserId: OWNER_ID,
        action: 'channel.create',
        targetType: 'channel',
        targetId: 'ch-1',
        metadata: { name: 'general' },
        createdAt: new Date('2026-06-11T00:00:00Z'),
      },
    ]);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/audit-logs`, makeSessionCookie(OWNER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { auditLogs: { action: string }[] };
    expect(json.auditLogs).toHaveLength(1);
    expect(json.auditLogs[0]?.action).toBe('channel.create');
    expect(listAuditLogsForServer).toHaveBeenCalledWith(expect.anything(), SERVER_ID, {
      limit: 100,
    });
  });

  it('honors the `limit` query parameter', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    getUserPermissions.mockResolvedValue(['administrator']);
    listAuditLogsForServer.mockResolvedValue([]);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(`http://localhost/api/servers/${SERVER_ID}/audit-logs?limit=25`, makeSessionCookie(OWNER_ID)),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(200);
    expect(listAuditLogsForServer).toHaveBeenCalledWith(expect.anything(), SERVER_ID, {
      limit: 25,
    });
  });

  it('returns 400 for an invalid `before` cursor', async () => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    getUserPermissions.mockResolvedValue(['administrator']);
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq(
        `http://localhost/api/servers/${SERVER_ID}/audit-logs?before=not-a-date`,
        makeSessionCookie(OWNER_ID)
      ),
      { params: Promise.resolve({ id: SERVER_ID }) }
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/servers/{id}/audit-logs — metadata per viewer (security-review AUTHZ-010)', () => {
  const OPEN = '0a1b2c3d-0000-4000-8000-000000000002';
  const STAFF = '0a1b2c3d-0000-4000-8000-000000000003';
  const log = (action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) => ({
    id: `log-${action}-${targetId}`,
    serverId: SERVER_ID,
    actorUserId: OWNER_ID,
    action,
    targetType,
    targetId,
    metadata,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  const rows = () => [
    log('invite.create', 'invite', 'inv-1', { code: 'SECRETCODE12', maxUses: null, expiresAt: null }),
    log('invite.redeem', 'membership', 'mem-1', { code: 'SECRETCODE12', roleId: 'r-1' }),
    log('channel.update', 'channel', STAFF, { name: 'staff-only', topic: 'raises', visibleToRoleIds: ['r-staff'] }),
    log('channel.update', 'channel', OPEN, { name: 'lounge' }),
    log('bot.moderation.block', 'user', MEMBER_ID, { rule: 'blocked_word', detail: 'payroll', channelId: STAFF }),
  ];

  async function read(uid: string) {
    const { GET } = await loadRoute();
    const res = await GET(makeReq(`http://localhost/api/servers/${SERVER_ID}/audit-logs`, makeSessionCookie(uid)), {
      params: Promise.resolve({ id: SERVER_ID }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { auditLogs: Array<{ metadata: Record<string, unknown> }> }).auditLogs.map((e) => e.metadata);
  }

  beforeEach(() => {
    getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OWNER_ID });
    isServerMember.mockResolvedValue(true);
    listAuditLogsForServer.mockResolvedValue(rows());
    listChannelsForServer.mockResolvedValue([
      { id: OPEN, serverId: SERVER_ID, name: 'lounge' },
      { id: STAFF, serverId: SERVER_ID, name: 'staff-only' },
    ]);
    listVisibleChannelsForMember.mockResolvedValue([{ id: OPEN, serverId: SERVER_ID, name: 'lounge' }]);
  });

  it('a View Audit Log holder gets no invite code and nothing from a channel they cannot see', async () => {
    getUserPermissions.mockResolvedValue(['view_audit_log']);
    const metadata = await read(MEMBER_ID);
    expect(metadata).toEqual([
      { maxUses: null, expiresAt: null },
      { roleId: 'r-1' },
      {},
      { name: 'lounge' },
      { rule: 'blocked_word', channelId: STAFF },
    ]);
  });

  it('MANAGE_SERVER sees invite codes; channel metadata still follows channel visibility', async () => {
    getUserPermissions.mockResolvedValue(['view_audit_log', 'manage_server']);
    const metadata = await read(MEMBER_ID);
    expect(metadata[0]).toMatchObject({ code: 'SECRETCODE12' });
    expect(metadata[1]).toMatchObject({ code: 'SECRETCODE12' });
    expect(metadata[2]).toEqual({});
  });

  it('the owner reads every row unchanged', async () => {
    getUserPermissions.mockResolvedValue(['administrator']);
    expect(await read(OWNER_ID)).toEqual(rows().map((r) => r.metadata));
  });
});
