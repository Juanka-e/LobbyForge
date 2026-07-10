import { describe, it, expect } from 'vitest';
import { AlertLevel, DoctorCategory, type SystemStats } from '@lobbyforge/core';
import { buildChecksFromStats } from '../doctor.js';

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
