import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { AlertLevel, DoctorCategory, type SystemStats } from '@lobbyforge/core';
import { buildChecksFromStats, collectSystemStats } from '../doctor.js';

const healthyStats: SystemStats = {
  cpuCount: 4,
  loadAverage1m: 0.5,
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  freeMemoryBytes: 4 * 1024 * 1024 * 1024,
  totalDiskBytes: 100 * 1024 * 1024 * 1024,
  freeDiskBytes: 50 * 1024 * 1024 * 1024,
  diskUsageRatio: 0.5,
  uptimeSeconds: 60,
  livekitReachable: true,
  postgresReachable: true,
  redisReachable: true,
  httpsReachable: true,
  udpLikelyOpen: true,
  turnConfigured: true,
  startedAt: new Date(),
};

describe('buildChecksFromStats', () => {
  it('produces the expected check ids for a healthy host', () => {
    const checks = buildChecksFromStats(healthyStats);
    const ids = checks.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'cpu_count',
        'memory_free',
        'disk_usage',
        'load_average',
        'https',
        'udp_range',
        'postgres',
        'redis',
        'livekit_signaling',
        'turn_configured',
      ])
    );
  });

  it('marks postgres as critical when unreachable', () => {
    const checks = buildChecksFromStats({ ...healthyStats, postgresReachable: false });
    const pg = checks.find((c) => c.id === 'postgres');
    expect(pg?.ok).toBe(false);
    expect(pg?.level).toBe(AlertLevel.CRITICAL);
  });

  it('marks disk_usage fatal at >= 95%', () => {
    const checks = buildChecksFromStats({ ...healthyStats, diskUsageRatio: 0.97 });
    const disk = checks.find((c) => c.id === 'disk_usage');
    expect(disk?.level).toBe(AlertLevel.FATAL);
    expect(disk?.ok).toBe(false);
  });

  it('marks disk_usage critical at >= 90%', () => {
    const checks = buildChecksFromStats({ ...healthyStats, diskUsageRatio: 0.92 });
    const disk = checks.find((c) => c.id === 'disk_usage');
    expect(disk?.level).toBe(AlertLevel.CRITICAL);
  });

  it('marks disk_usage warning at >= 80%', () => {
    const checks = buildChecksFromStats({ ...healthyStats, diskUsageRatio: 0.85 });
    const disk = checks.find((c) => c.id === 'disk_usage');
    expect(disk?.level).toBe(AlertLevel.WARNING);
  });

  it('flags load_average as warning when load per CPU >= 2', () => {
    const checks = buildChecksFromStats({ ...healthyStats, cpuCount: 2, loadAverage1m: 5 });
    const load = checks.find((c) => c.id === 'load_average');
    expect(load?.level).toBe(AlertLevel.WARNING);
  });

  it('flags memory_free as critical when < 10% free', () => {
    const checks = buildChecksFromStats({
      ...healthyStats,
      totalMemoryBytes: 10 * 1024 * 1024 * 1024,
      freeMemoryBytes: 500 * 1024 * 1024,
    });
    const mem = checks.find((c) => c.id === 'memory_free');
    expect(mem?.level).toBe(AlertLevel.CRITICAL);
  });

  it('treats null reachability as "not yet probed" (info, ok=true)', () => {
    const checks = buildChecksFromStats({
      ...healthyStats,
      livekitReachable: null,
      postgresReachable: null,
      redisReachable: null,
    });
    for (const id of ['livekit_signaling', 'postgres', 'redis']) {
      const c = checks.find((x) => x.id === id);
      expect(c?.level).toBe(AlertLevel.INFO);
      expect(c?.ok).toBe(true);
    }
  });

  it('warns when TURN is missing AND UDP looks blocked', () => {
    const checks = buildChecksFromStats({
      ...healthyStats,
      turnConfigured: false,
      udpLikelyOpen: false,
    });
    const turn = checks.find((c) => c.id === 'turn_configured');
    expect(turn?.ok).toBe(false);
    expect(turn?.level).toBe(AlertLevel.WARNING);
  });

  it('does not warn on TURN when UDP looks open', () => {
    const checks = buildChecksFromStats({
      ...healthyStats,
      turnConfigured: false,
      udpLikelyOpen: true,
    });
    const turn = checks.find((c) => c.id === 'turn_configured');
    expect(turn?.ok).toBe(true);
    expect(turn?.level).toBe(AlertLevel.INFO);
  });

  it('uses DoctorCategory values correctly', () => {
    const checks = buildChecksFromStats(healthyStats);
    const ids = new Set(checks.map((c) => c.category));
    expect(ids.has(DoctorCategory.SYSTEM)).toBe(true);
    expect(ids.has(DoctorCategory.NETWORK)).toBe(true);
    expect(ids.has(DoctorCategory.SERVICES)).toBe(true);
    expect(ids.has(DoctorCategory.MEDIA)).toBe(true);
  });
});

describe('collectSystemStats disk resolution', () => {
  const originalEnv = process.env.LOBBYFORGE_DISK_USAGE_RATIO;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.LOBBYFORGE_DISK_USAGE_RATIO;
  });

  it('honors the LOBBYFORGE_DISK_USAGE_RATIO env override when set', async () => {
    process.env.LOBBYFORGE_DISK_USAGE_RATIO = '0.75';
    const stats = await collectSystemStats();
    expect(stats.diskUsageRatio).toBe(0.75);
  });

  it('falls back to a real fs.statfs ratio when env is unset and statfs succeeds', async () => {
    vi.doMock('node:fs/promises', () => ({
      statfs: vi.fn().mockResolvedValue({ bsize: 4096, blocks: 1000, bfree: 400 }),
    }));
    const stats = await collectSystemStats();
    // 400/1000 free → 60% used
    expect(stats.diskUsageRatio).toBeCloseTo(0.6, 2);
    expect(stats.totalDiskBytes).toBe(4096 * 1000);
  });

  it('falls back to 0.5 when fs.statfs throws (e.g. Windows ENOSYS)', async () => {
    vi.doMock('node:fs/promises', () => ({
      statfs: vi.fn().mockRejectedValue(Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' })),
    }));
    const stats = await collectSystemStats();
    expect(stats.diskUsageRatio).toBe(0.5);
  });

  // Restore env after the suite so other tests are unaffected.
  afterAll(() => {
    if (originalEnv !== undefined) process.env.LOBBYFORGE_DISK_USAGE_RATIO = originalEnv;
  });
});

describe('probeRedis (via collectDoctorReport integration)', () => {
  // probeRedis is not exported directly; we exercise it through the Redis
  // check by mocking the shared ioredis singleton it imports. We also
  // mock postgres + fetch so the parallel probes return instantly
  // instead of timing out against a real DB / HTTP server.
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('postgres', () => {
      const sql = vi.fn(async () => [{ ok: 1 }]);
      (sql as unknown as { end: () => Promise<void> }).end = async () => {};
      return { default: vi.fn(() => sql) };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
  });

  it('reports redis reachable when ping returns PONG', async () => {
    vi.doMock('@/lib/redis', () => ({
      redis: { ping: vi.fn().mockResolvedValue('PONG') },
    }));
    const { collectDoctorReport } = await import('../doctor.js');
    const { report } = await collectDoctorReport();
    const redis = report.checks.find((c) => c.id === 'redis');
    expect(redis?.ok).toBe(true);
  }, 15000);

  it('reports redis unreachable when ping throws', async () => {
    vi.doMock('@/lib/redis', () => ({
      redis: { ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) },
    }));
    const { collectDoctorReport } = await import('../doctor.js');
    const { report } = await collectDoctorReport();
    const redis = report.checks.find((c) => c.id === 'redis');
    expect(redis?.ok).toBe(false);
    expect(redis?.level).toBe(AlertLevel.CRITICAL);
  }, 15000);
});
