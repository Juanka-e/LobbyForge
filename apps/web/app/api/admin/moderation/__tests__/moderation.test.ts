import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Faz D completion: the moderation API now returns filed instance
 * reports and accepts moderation decisions — instance listing changes
 * AND report resolution.
 */

const listPendingSubmissions = vi.fn();
const listPublicRegistryInstances = vi.fn();
const listInstanceReports = vi.fn();
const setRegistryInstanceListing = vi.fn();
const setInstanceReportStatus = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  listPendingSubmissions,
  listPublicRegistryInstances,
  listInstanceReports,
  setRegistryInstanceListing,
  setInstanceReportStatus,
}));

const requireAdminHealthToken = vi.fn();
vi.mock('@/lib/admin-auth', () => ({ requireAdminHealthToken }));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

const readGuestSession = vi.fn();
vi.mock('@/lib/guest-session', () => ({ readGuestSession }));

beforeEach(() => {
  process.env.LOBBYFORGE_SESSION_SECRET = 'x'.repeat(32);
  for (const fn of [
    listPendingSubmissions,
    listPublicRegistryInstances,
    listInstanceReports,
    setRegistryInstanceListing,
    setInstanceReportStatus,
    requireAdminHealthToken,
    readGuestSession,
  ]) {
    fn.mockReset();
  }
  requireAdminHealthToken.mockResolvedValue(null);
  listPendingSubmissions.mockResolvedValue([]);
  listPublicRegistryInstances.mockResolvedValue([]);
  listInstanceReports.mockResolvedValue([]);
  readGuestSession.mockReturnValue(null);
});

async function get(): Promise<Response> {
  const { GET } = await import('../route.js');
  return GET(new Request('https://example.test/api/admin/moderation'), {});
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import('../route.js');
  return POST(
    new Request('https://example.test/api/admin/moderation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

describe('GET /api/admin/moderation', () => {
  it('includes filed reports with reporter attribution', async () => {
    listInstanceReports.mockResolvedValue([
      {
        id: '00000000-0000-0000-0000-0000000000a1',
        instanceId: 'inst-1',
        reporterUserId: 'u-1',
        reporterName: 'Alice',
        reason: 'spam',
        detail: 'bad place',
        status: 'pending',
        reviewerUserId: null,
        reviewedAt: null,
        createdAt: new Date('2026-09-08T00:00:00Z'),
      },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { reports: Array<{ id: string; reporterName: string }> };
    expect(json.reports).toHaveLength(1);
    expect(json.reports[0]!.reporterName).toBe('Alice');
  });

  it('401 for non-admins', async () => {
    requireAdminHealthToken.mockResolvedValue(
      Response.json({ error: 'Instance owner authentication required' }, { status: 401 })
    );
    const res = await get();
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/moderation — report resolution', () => {
  it('resolves a pending report as actioned, attributed to the admin session', async () => {
    readGuestSession.mockReturnValue({ uid: 'admin-1', gid: 'g', name: 'Admin' });
    setInstanceReportStatus.mockResolvedValue(true);
    const res = await post({ type: 'report', reportId: '00000000-0000-0000-0000-0000000000a1', action: 'actioned' });
    expect(res.status).toBe(200);
    expect(setInstanceReportStatus).toHaveBeenCalledWith(
      { __mockDb: true },
      '00000000-0000-0000-0000-0000000000a1',
      'actioned',
      'admin-1'
    );
  });

  it('dismisses a report; emergency-token admins stay anonymous', async () => {
    setInstanceReportStatus.mockResolvedValue(true);
    const res = await post({ type: 'report', reportId: '00000000-0000-0000-0000-0000000000a2', action: 'dismiss' });
    expect(res.status).toBe(200);
    expect(setInstanceReportStatus).toHaveBeenCalledWith(
      { __mockDb: true },
      '00000000-0000-0000-0000-0000000000a2',
      'dismissed',
      null
    );
  });

  it('404 when the report is unknown or already resolved', async () => {
    setInstanceReportStatus.mockResolvedValue(false);
    const res = await post({ type: 'report', reportId: '00000000-0000-0000-0000-0000000000aa', action: 'dismiss' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/moderation — instance listing', () => {
  it('block unlists AND blocks', async () => {
    setRegistryInstanceListing.mockResolvedValue(undefined);
    const res = await post({ type: 'instance', instanceId: 'inst-1', action: 'block' });
    expect(res.status).toBe(200);
    expect(setRegistryInstanceListing).toHaveBeenCalledWith(
      { __mockDb: true },
      'inst-1',
      { isBlocked: true, isListed: false }
    );
  });

  it('rejects unknown bodies', async () => {
    const res = await post({ type: 'nonsense' });
    expect(res.status).toBe(400);
  });
});
