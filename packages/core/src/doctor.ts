/**
 * LobbyForge Doctor — system health, capacity, and media profile recommendations.
 *
 * The Doctor subsystem answers the self-host admin's "is my instance healthy?" and
 * "how many users can I host?" questions. It is the operational heart of the app
 * (see projectdetails/19_OBSERVABILITY_DOCTOR_CAPACITY.md).
 *
 * Design constraints taken from the spec:
 *   - Each check is a pure function: name + category, returns { ok, level, message, detail? }.
 *   - The report aggregates checks, never edits them; callers decide what to alert on.
 *   - Capacity recommendations are conservative — the report's *language* must avoid
 *     hard promises (see §8 of the spec). We return a "guidance" profile, not a contract.
 *   - All primitives are deterministic given a SystemStats snapshot, so they are unit-testable
 *     on any platform (the actual os.cpus() call is injected by the caller).
 */

export const DoctorCategory = {
  SYSTEM: 'system',
  NETWORK: 'network',
  SERVICES: 'services',
  MEDIA: 'media',
} as const;
export type DoctorCategory = typeof DoctorCategory[keyof typeof DoctorCategory];

export const AlertLevel = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
  FATAL: 'fatal',
} as const;
export type AlertLevel = typeof AlertLevel[keyof typeof AlertLevel];

export interface DoctorCheck {
  id: string;
  category: DoctorCategory;
  ok: boolean;
  level: AlertLevel;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * A pluggable check is a function that takes the current system snapshot and returns
 * one or more DoctorCheck entries. Returning an empty array means "no opinion".
 */
export type DoctorCheckFn = (stats: SystemStats) => DoctorCheck[];

/**
 * Snapshot of host metrics. The web app is responsible for filling this from
 * `os.cpus()`, `os.totalmem()`, `os.freemem()`, container stats, etc. Keeping it
 * a plain object makes every check deterministic and easy to unit-test.
 */
export interface SystemStats {
  cpuCount: number;
  loadAverage1m: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  totalDiskBytes: number;
  freeDiskBytes: number;
  /** 0..1 fill ratio reported by the OS for the primary volume. */
  diskUsageRatio: number;
  uptimeSeconds: number;
  /** LiveKit server reachable? null = not yet probed. */
  livekitReachable: boolean | null;
  /** PostgreSQL reachable? null = not yet probed. */
  postgresReachable: boolean | null;
  /** Redis reachable? null = not yet probed. */
  redisReachable: boolean | null;
  /** HTTPS reachable? null = not yet probed. */
  httpsReachable: boolean | null;
  /** UDP range looks open (best-effort; always best-guess). null = not probed. */
  udpLikelyOpen: boolean | null;
  /** TURN server configured (credentials present). null = not probed. */
  turnConfigured: boolean | null;
  /** Process started-at — used for uptime reporting. */
  startedAt: Date;
}

export const CapacityTier = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;
export type CapacityTier = typeof CapacityTier[keyof typeof CapacityTier];

export interface CapacityProfile {
  tier: CapacityTier;
  maxVoiceUsersPerRoom: number;
  maxCameraUsersPerRoom: number;
  maxScreenSharePerRoom: number;
  videoDefault: 'off' | 'opt-in' | 'on';
  layout: 'active-speaker' | 'active-speaker-thumbnails' | 'grid';
  /**
   * Human-readable rationale: explain *why* this tier was chosen, so the admin
   * can re-evaluate after a hardware change.
   */
  rationale: string[];
  /**
   * Required-by-spec disclaimer: the report language must avoid promises.
   */
  guidance: string;
}

/**
 * Sanity floor and ceiling for the heuristics. If a host is so small it falls
 * below the floor, we still report LOW — we do not pretend to know better.
 */
const CAPACITY_FLOOR_CPU = 1;
const CAPACITY_FLOOR_MEM_BYTES = 512 * 1024 * 1024; // 512 MB

export function recommendCapacityProfile(stats: SystemStats): CapacityProfile {
  const reasons: string[] = [];

  const cpu = Math.max(CAPACITY_FLOOR_CPU, stats.cpuCount);
  const memBytes = Math.max(CAPACITY_FLOOR_MEM_BYTES, stats.totalMemoryBytes);
  const memGB = memBytes / 1024 / 1024 / 1024;
  const diskRatio = clamp01(stats.diskUsageRatio);

  // Initial tier pick from the most-constrained resource.
  let tier: CapacityTier = CapacityTier.MEDIUM;

  if (cpu <= 1 || memGB < 2) {
    tier = CapacityTier.LOW;
    reasons.push(`Constrained host: ${cpu} CPU, ${memGB.toFixed(1)} GB RAM.`);
  } else if (cpu >= 4 && memGB >= 8 && diskRatio < 0.7) {
    tier = CapacityTier.HIGH;
    reasons.push(`Healthy host: ${cpu} CPU, ${memGB.toFixed(1)} GB RAM, disk ${(diskRatio * 100).toFixed(0)}%.`);
  } else {
    reasons.push(`Mid-range host: ${cpu} CPU, ${memGB.toFixed(1)} GB RAM, disk ${(diskRatio * 100).toFixed(0)}%.`);
  }

  // Demote on disk pressure regardless of CPU/RAM headroom.
  if (diskRatio >= 0.95) {
    tier = CapacityTier.LOW;
    reasons.push('Disk usage at or above 95% — capacity capped at LOW.');
  } else if (diskRatio >= 0.9 && tier === CapacityTier.HIGH) {
    tier = CapacityTier.MEDIUM;
    reasons.push('Disk usage at or above 90% — capacity capped at MEDIUM.');
  }

  // Demote on heavy load.
  const loadPerCpu = stats.loadAverage1m / Math.max(1, stats.cpuCount);
  if (loadPerCpu > 2 && tier !== CapacityTier.LOW) {
    tier = tier === CapacityTier.HIGH ? CapacityTier.MEDIUM : CapacityTier.LOW;
    reasons.push(`High load (1m avg ${stats.loadAverage1m.toFixed(2)} on ${cpu} CPU) — capacity demoted.`);
  }

  return buildProfileForTier(tier, reasons);
}

function buildProfileForTier(tier: CapacityTier, reasons: string[]): CapacityProfile {
  switch (tier) {
    case CapacityTier.LOW:
      return {
        tier,
        maxVoiceUsersPerRoom: 10,
        maxCameraUsersPerRoom: 2,
        maxScreenSharePerRoom: 1,
        videoDefault: 'off',
        layout: 'active-speaker',
        rationale: reasons,
        guidance: 'With these settings the safe guidance is up to 10 voice users per room. Re-measure under live load before raising the cap.',
      };
    case CapacityTier.MEDIUM:
      return {
        tier,
        maxVoiceUsersPerRoom: 40,
        maxCameraUsersPerRoom: 5,
        maxScreenSharePerRoom: 1,
        videoDefault: 'opt-in',
        layout: 'active-speaker-thumbnails',
        rationale: reasons,
        guidance: 'With these settings the safe guidance is up to 40 voice users per room. Re-measure under live load before raising the cap.',
      };
    case CapacityTier.HIGH:
      return {
        tier,
        maxVoiceUsersPerRoom: 100,
        maxCameraUsersPerRoom: 9,
        maxScreenSharePerRoom: 2,
        videoDefault: 'on',
        layout: 'grid',
        rationale: reasons,
        guidance: 'With these settings the safe guidance is up to 100 voice users per room. Real capacity depends on camera usage and outbound bandwidth — re-measure under live load.',
      };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  uptimeSeconds: number;
  checks: DoctorCheck[];
  capacity: CapacityProfile;
  /**
   * Counts of checks per level — handy for at-a-glance admin banners
   * ("3 warnings, 1 critical").
   */
  summary: {
    info: number;
    warning: number;
    critical: number;
    fatal: number;
    ok: number;
  };
}

/**
 * Run a list of checks against a stats snapshot and bundle the capacity recommendation.
 * A report is "ok" iff no check returned a non-OK status. The caller is expected to
 * decide which alert channel (banner, webhook, email) to use per level.
 */
export function buildDoctorReport(
  checks: DoctorCheck[],
  stats: SystemStats,
  generatedAt: Date = new Date()
): DoctorReport {
  const summary = countLevels(checks);
  const ok = summary.critical === 0 && summary.fatal === 0;
  return {
    ok,
    generatedAt: generatedAt.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((generatedAt.getTime() - stats.startedAt.getTime()) / 1000)),
    checks: sortChecks(checks),
    capacity: recommendCapacityProfile(stats),
    summary,
  };
}

function countLevels(checks: DoctorCheck[]): DoctorReport['summary'] {
  const acc: DoctorReport['summary'] = { info: 0, warning: 0, critical: 0, fatal: 0, ok: 0 };
  for (const c of checks) {
    if (c.ok) {
      acc.ok += 1;
      continue;
    }
    acc[c.level] += 1;
  }
  return acc;
}

/**
 * Stable, predictable order: category first, then id. Makes the report diff-friendly
 * in admin UIs and tests.
 */
function sortChecks(checks: DoctorCheck[]): DoctorCheck[] {
  const categoryOrder: Record<DoctorCategory, number> = {
    [DoctorCategory.SYSTEM]: 0,
    [DoctorCategory.NETWORK]: 1,
    [DoctorCategory.SERVICES]: 2,
    [DoctorCategory.MEDIA]: 3,
  };
  return [...checks].sort((a, b) => {
    const ca = categoryOrder[a.category];
    const cb = categoryOrder[b.category];
    if (ca !== cb) return ca - cb;
    return a.id.localeCompare(b.id);
  });
}
