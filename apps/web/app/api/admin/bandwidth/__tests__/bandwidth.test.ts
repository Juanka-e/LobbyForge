import { describe, it, expect, vi, beforeEach } from 'vitest';

const isInstanceAdminAllowed = vi.fn();
const getInstanceSetupStatus = vi.fn();
const listServersForUser = vi.fn();
const getServerBandwidthTotals = vi.fn();
const clearBandwidthAlert = vi.fn();
const nextCookies = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  isInstanceAdminAllowed,
  ADMIN_TOKEN_COOKIE: 'lf_admin_token',
}));

// security-review AUTH-002: the route must NOT read next/headers cookies
// (it keeps the last duplicate cookie); this spy proves it is never used.
vi.mock('next/headers', () => ({ cookies: nextCookies }));

vi.mock('@lobbyforge/db', () => ({
  getInstanceSetupStatus,
  listServersForUser,
}));

vi.mock('@/lib/redis', () => ({
  getServerBandwidthTotals,
  clearBandwidthAlert,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => ({ __mockDb: true }),
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

async function loadRoute() {
  return import('../route.js');
}

const SERVER_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.resetModules();
  isInstanceAdminAllowed.mockReset();
  getInstanceSetupStatus.mockReset();
  listServersForUser.mockReset();
  getServerBandwidthTotals.mockReset();
  clearBandwidthAlert.mockReset();
  nextCookies.mockReset();
  nextCookies.mockResolvedValue({ toString: () => '', get: () => undefined });
  // Default: admin allowed.
  isInstanceAdminAllowed.mockResolvedValue(true);
  // clearBandwidthAlert is called with .catch() in the route — must return a Promise.
  clearBandwidthAlert.mockResolvedValue(undefined);
});

describe('GET /api/admin/bandwidth', () => {
  it('returns 403 when the caller is not an instance admin', async () => {
    isInstanceAdminAllowed.mockResolvedValue(false);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/bandwidth'), {});
    expect(res.status).toBe(403);
    expect(getInstanceSetupStatus).not.toHaveBeenCalled();
  });

  it('returns an empty totals list when no owner is set up', async () => {
    getInstanceSetupStatus.mockResolvedValue({ ownerUserId: null });
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/bandwidth'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { totals: unknown[] };
    expect(json.totals).toEqual([]);
  });

  it('aggregates per-server bandwidth totals', async () => {
    getInstanceSetupStatus.mockResolvedValue({ ownerUserId: 'owner-1' });
    listServersForUser.mockResolvedValue([{ id: SERVER_ID, name: 'Community' }]);
    getServerBandwidthTotals.mockResolvedValue({
      totalBytes: 1000,
      todayBytes: 500,
      alertTriggered: true,
      hourly: [10, 20],
    });
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/bandwidth'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      totals: Array<{ serverId: string; serverName: string; totalBytes: number }>;
    };
    expect(json.totals).toHaveLength(1);
    expect(json.totals[0]).toMatchObject({
      serverId: SERVER_ID,
      serverName: 'Community',
      totalBytes: 1000,
    });
  });

  it('swallows per-server bandwidth read failures (zeros fallback)', async () => {
    getInstanceSetupStatus.mockResolvedValue({ ownerUserId: 'owner-1' });
    listServersForUser.mockResolvedValue([{ id: SERVER_ID, name: 'Community' }]);
    getServerBandwidthTotals.mockRejectedValue(new Error('redis down'));
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/bandwidth'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      totals: Array<{ totalBytes: number; alertTriggered: boolean }>;
    };
    expect(json.totals[0].totalBytes).toBe(0);
    expect(json.totals[0].alertTriggered).toBe(false);
  });
});

describe('POST /api/admin/bandwidth', () => {
  it('clears the alert for the given server and returns success', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/admin/bandwidth', {
        method: 'POST',
        body: JSON.stringify({ action: 'acknowledge-alert', serverId: SERVER_ID }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(clearBandwidthAlert).toHaveBeenCalledWith(SERVER_ID);
  });

  it('returns 400 when the body is invalid (missing serverId)', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/admin/bandwidth', {
        method: 'POST',
        body: JSON.stringify({ action: 'acknowledge-alert' }),
      }),
      {}
    );
    expect(res.status).toBe(400);
    expect(clearBandwidthAlert).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an instance admin', async () => {
    isInstanceAdminAllowed.mockResolvedValue(false);
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/admin/bandwidth', {
        method: 'POST',
        body: JSON.stringify({ action: 'acknowledge-alert', serverId: SERVER_ID }),
      }),
      {}
    );
    expect(res.status).toBe(403);
  });
});

// security-review AUTH-002: `Cookie: lf_guest=<valid>; lf_guest=<revoked>` —
// next/headers kept the last duplicate while withApiSecurity's revocation
// check read the first. The route now authorizes from the request header
// itself, the same one the wrapper checked.
describe('/api/admin/bandwidth — security-review AUTH-002 cookie source', () => {
  const COOKIE = 'lf_guest=first.sig; lf_admin_token=operator-token; lf_guest=second.sig';

  it('GET authorizes with the request Cookie header, not next/headers', async () => {
    getInstanceSetupStatus.mockResolvedValue({ ownerUserId: null });
    const { GET } = await loadRoute();
    const res = await GET(
      new Request('https://example.test/api/admin/bandwidth', { headers: { cookie: COOKIE } }),
      {}
    );
    expect(res.status).toBe(200);
    expect(isInstanceAdminAllowed).toHaveBeenCalledWith(COOKIE, 'operator-token');
    expect(nextCookies).not.toHaveBeenCalled();
  });

  it('POST authorizes with the request Cookie header, not next/headers', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('https://example.test/api/admin/bandwidth', {
        method: 'POST',
        headers: { cookie: COOKIE },
        body: JSON.stringify({ action: 'acknowledge-alert', serverId: SERVER_ID }),
      }),
      {}
    );
    expect(res.status).toBe(200);
    expect(isInstanceAdminAllowed).toHaveBeenCalledWith(COOKIE, 'operator-token');
    expect(nextCookies).not.toHaveBeenCalled();
  });

  it('a request without cookies is checked as anonymous', async () => {
    isInstanceAdminAllowed.mockResolvedValue(false);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/admin/bandwidth'), {});
    expect(res.status).toBe(403);
    expect(isInstanceAdminAllowed).toHaveBeenCalledWith(null, null);
  });
});
