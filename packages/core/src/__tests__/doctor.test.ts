import { describe, it, expect } from 'vitest';
import {
  buildDoctorReport,
  recommendCapacityProfile,
  AlertLevel,
  DoctorCategory,
  CapacityTier,
  type DoctorCheck,
  type SystemStats,
} from '../doctor.js';

const baseStats: SystemStats = {
  cpuCount: 2,
  loadAverage1m: 0.5,
  totalMemoryBytes: 4 * 1024 * 1024 * 1024,
  freeMemoryBytes: 2 * 1024 * 1024 * 1024,
  totalDiskBytes: 100 * 1024 * 1024 * 1024,
  freeDiskBytes: 50 * 1024 * 1024 * 1024,
  diskUsageRatio: 0.5,
  uptimeSeconds: 60,
  livekitReachable: true,
  postgresReachable: true,
  redisReachable: true,
  httpsReachable: true,
  udpLikelyOpen: true,
  turnConfigured: false,
  startedAt: new Date('2026-06-09T00:00:00Z'),
};

describe('recommendCapacityProfile', () => {
  it('returns LOW for 1 CPU / <2 GB hosts', () => {
    const profile = recommendCapacityProfile({
      ...baseStats,
      cpuCount: 1,
      totalMemoryBytes: 1024 * 1024 * 1024,
    });
    expect(profile.tier).toBe(CapacityTier.LOW);
    expect(profile.maxVoiceUsersPerRoom).toBe(10);
    expect(profile.videoDefault).toBe('off');
  });

  it('returns HIGH for 4+ CPU, 8+ GB, <70% disk', () => {
    const profile = recommendCapacityProfile({
      ...baseStats,
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      diskUsageRatio: 0.4,
    });
    expect(profile.tier).toBe(CapacityTier.HIGH);
    expect(profile.maxVoiceUsersPerRoom).toBe(100);
    expect(profile.maxCameraUsersPerRoom).toBe(9);
    expect(profile.layout).toBe('grid');
  });

  it('returns MEDIUM for the default 2 CPU / 4 GB host', () => {
    const profile = recommendCapacityProfile(baseStats);
    expect(profile.tier).toBe(CapacityTier.MEDIUM);
    expect(profile.maxVoiceUsersPerRoom).toBe(40);
  });

  it('demotes to LOW on disk >= 95%', () => {
    const profile = recommendCapacityProfile({
      ...baseStats,
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      diskUsageRatio: 0.97,
    });
    expect(profile.tier).toBe(CapacityTier.LOW);
    expect(profile.rationale.some((r) => r.includes('95%'))).toBe(true);
  });

  it('demotes HIGH to MEDIUM on disk >= 90%', () => {
    const profile = recommendCapacityProfile({
      ...baseStats,
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      diskUsageRatio: 0.93,
    });
    expect(profile.tier).toBe(CapacityTier.MEDIUM);
  });

  it('demotes on heavy load (loadPerCpu > 2)', () => {
    const profile = recommendCapacityProfile({
      ...baseStats,
      cpuCount: 4,
      loadAverage1m: 12,
    });
    expect(profile.tier).toBe(CapacityTier.LOW);
    expect(profile.rationale.some((r) => r.includes('High load'))).toBe(true);
  });

  it('clamp01 protects against NaN/out-of-range disk ratios', () => {
    const a = recommendCapacityProfile({ ...baseStats, diskUsageRatio: Number.NaN });
    const b = recommendCapacityProfile({ ...baseStats, diskUsageRatio: 1.4 });
    const c = recommendCapacityProfile({ ...baseStats, diskUsageRatio: -0.2 });
    // NaN falls back to 0; -0.2 is clamped to 0; 1.4 is clamped to 1.
    // 1.4 → diskRatio == 1.0 → demote to LOW.
    expect(b.tier).toBe(CapacityTier.LOW);
    // The other two should not crash and should land in MEDIUM.
    expect([CapacityTier.MEDIUM, CapacityTier.HIGH]).toContain(a.tier);
    expect([CapacityTier.MEDIUM, CapacityTier.HIGH]).toContain(c.tier);
  });

  it('always returns a guidance string referencing re-measurement', () => {
    const p = recommendCapacityProfile(baseStats);
    expect(p.guidance.toLowerCase()).toContain('re-measure');
  });
});

describe('buildDoctorReport', () => {
  it('aggregates a clean report as ok', () => {
    const checks: DoctorCheck[] = [
      okCheck('postgres', DoctorCategory.SERVICES),
      okCheck('redis', DoctorCategory.SERVICES),
      okCheck('livekit_signaling', DoctorCategory.MEDIA),
    ];
    const report = buildDoctorReport(checks, baseStats, new Date('2026-06-09T00:00:30Z'));
    expect(report.ok).toBe(true);
    expect(report.uptimeSeconds).toBe(30);
    expect(report.summary).toEqual({ info: 0, warning: 0, critical: 0, fatal: 0, ok: 3 });
    expect(report.capacity.tier).toBe(CapacityTier.MEDIUM);
  });

  it('flips ok to false on a critical check', () => {
    const checks: DoctorCheck[] = [
      okCheck('postgres', DoctorCategory.SERVICES),
      failingCheck('redis', DoctorCategory.SERVICES, AlertLevel.CRITICAL, 'unreachable'),
    ];
    const report = buildDoctorReport(checks, baseStats);
    expect(report.ok).toBe(false);
    expect(report.summary.critical).toBe(1);
    expect(report.summary.ok).toBe(1);
  });

  it('flips ok to false on a fatal check', () => {
    const checks: DoctorCheck[] = [
      failingCheck('disk_full', DoctorCategory.SYSTEM, AlertLevel.FATAL, 'no space left'),
    ];
    const report = buildDoctorReport(checks, baseStats);
    expect(report.ok).toBe(false);
    expect(report.summary.fatal).toBe(1);
  });

  it('counts warnings without flipping ok to false', () => {
    const checks: DoctorCheck[] = [
      okCheck('postgres', DoctorCategory.SERVICES),
      failingCheck('turn', DoctorCategory.MEDIA, AlertLevel.WARNING, 'no TURN'),
    ];
    const report = buildDoctorReport(checks, baseStats);
    expect(report.ok).toBe(true);
    expect(report.summary.warning).toBe(1);
  });

  it('sorts checks by category then id', () => {
    const checks: DoctorCheck[] = [
      { id: 'livekit_signaling', category: DoctorCategory.MEDIA, ok: true, level: AlertLevel.INFO, message: 'ok' },
      { id: 'cpu_count', category: DoctorCategory.SYSTEM, ok: true, level: AlertLevel.INFO, message: 'ok' },
      { id: 'postgres', category: DoctorCategory.SERVICES, ok: true, level: AlertLevel.INFO, message: 'ok' },
      { id: 'dns', category: DoctorCategory.NETWORK, ok: true, level: AlertLevel.INFO, message: 'ok' },
    ];
    const report = buildDoctorReport(checks, baseStats);
    const ids = report.checks.map((c) => c.id);
    expect(ids).toEqual(['cpu_count', 'dns', 'postgres', 'livekit_signaling']);
  });
});

function okCheck(id: string, category: DoctorCategory): DoctorCheck {
  return { id, category, ok: true, level: AlertLevel.INFO, message: `${id} healthy` };
}

function failingCheck(id: string, category: DoctorCategory, level: AlertLevel, message: string): DoctorCheck {
  return { id, category, ok: false, level, message };
}
