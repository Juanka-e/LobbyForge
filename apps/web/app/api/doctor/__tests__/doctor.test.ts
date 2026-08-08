import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const requireAdminHealthToken = vi.fn();
const collectDoctorReport = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  requireAdminHealthToken,
}));

vi.mock('@/lib/doctor', () => ({
  collectDoctorReport,
}));

vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
}));

async function loadRoute() {
  return import('../route.js');
}

const okReport = {
  ok: true,
  generatedAt: '2026-01-01T00:00:00.000Z',
  uptimeSeconds: 60,
  checks: [],
  summary: { info: 0, warning: 0, critical: 0, fatal: 0, ok: 0 },
  capacity: {
    tier: 'MEDIUM',
    maxVoiceUsersPerRoom: 40,
    maxCameraUsersPerRoom: 5,
    maxScreenSharePerRoom: 1,
    videoDefault: 'optional',
    layout: 'speaker-thumbnails',
    guidance: 'ok',
    rationale: [],
  },
};

const failingReport = { ...okReport, ok: false };

const baseStats = {
  cpuCount: 4,
  loadAverage1m: 0.5,
  totalMemoryBytes: 8e9,
  freeMemoryBytes: 4e9,
  totalDiskBytes: 100e9,
  freeDiskBytes: 50e9,
  diskUsageRatio: 0.5,
  uptimeSeconds: 60,
  livekitReachable: true,
  postgresReachable: true,
  redisReachable: true,
  httpsReachable: true,
  udpLikelyOpen: null,
  turnConfigured: false,
  startedAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  vi.resetModules();
  requireAdminHealthToken.mockReset();
  collectDoctorReport.mockReset();
  // Default: admin is allowed (null response).
  requireAdminHealthToken.mockResolvedValue(null);
});

describe('GET /api/doctor admin gating', () => {
  it('rejects with the denied response when requireAdminHealthToken returns one', async () => {
    const denied = NextResponse.json({ error: 'Instance owner authentication required.' }, { status: 401 });
    requireAdminHealthToken.mockResolvedValue(denied);
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/doctor'), {});
    expect(res.status).toBe(401);
    expect(collectDoctorReport).not.toHaveBeenCalled();
  });
});

describe('GET /api/doctor report', () => {
  it('returns 200 when the report is ok', async () => {
    collectDoctorReport.mockResolvedValue({ report: okReport, stats: { ...baseStats } });
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/doctor'), {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { report: typeof okReport; stats: Record<string, unknown> };
    expect(json.report.ok).toBe(true);
  });

  it('returns 503 when the report has issues', async () => {
    collectDoctorReport.mockResolvedValue({ report: failingReport, stats: { ...baseStats } });
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/doctor'), {});
    expect(res.status).toBe(503);
  });

  it('redacts startedAt from the public stats', async () => {
    collectDoctorReport.mockResolvedValue({ report: okReport, stats: { ...baseStats } });
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/doctor'), {});
    const json = (await res.json()) as { stats: Record<string, unknown> };
    expect(json.stats.startedAt).toBeUndefined();
    // uptimeSeconds stays — only the Date object is stripped.
    expect(json.stats.uptimeSeconds).toBe(60);
  });

  it('responds with Cache-Control: no-store', async () => {
    collectDoctorReport.mockResolvedValue({ report: okReport, stats: { ...baseStats } });
    const { GET } = await loadRoute();
    const res = await GET(new Request('https://example.test/api/doctor'), {});
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
