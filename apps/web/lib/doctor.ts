/**
 * Doctor checks + system stats collector for the web app.
 *
 * The checks are deliberately pure functions of a SystemStats snapshot so they
 * can be unit-tested without a real host. The collector (collectSystemStats)
 * uses Node's `os` module and is the only server-only side of this file.
 */
import postgres from 'postgres';
import {
  AlertLevel,
  buildDoctorReport,
  DoctorCategory,
  type DoctorCheck,
  type DoctorReport,
  type SystemStats,
} from '@lobbyforge/core';

const PROCESS_STARTED_AT = new Date();

/**
 * Probe a URL with a short timeout. Returns true if it answers with 2xx/3xx.
 * This is intentionally permissive — Doctor is a "smell test", not a strict SLA check.
 */
export async function probeUrl(url: string, timeoutMs = 1500): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a SystemStats snapshot from the current Node process.
 *
 * In production the postgres/redis/livekit booleans are filled in by `collectChecks()`,
 * which calls `probeUrl()` against the actual service URLs. Keeping this function
 * Node-`os`-bound means it can never run inside a client bundle.
 */
export async function collectSystemStats(): Promise<SystemStats> {
  const os = await import('node:os');
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const loadAvg = os.loadavg();

  // Best-effort disk snapshot. Resolution order:
  //   1. LOBBYFORGE_DISK_USAGE_RATIO env override (explicit operator input)
  //   2. fs.statfs(process.cwd()) — real filesystem stats on Linux/macOS
  //      (Node 18.15+). Throws ENOSYS on Windows, caught below.
  //   3. Fallback: assume 0.5 (50% used) so capacity math stays sensible.
  const envRatio = readDiskUsageRatioFromEnv();
  let diskUsageRatio: number;
  let totalDisk: number;
  let freeDisk: number;
  if (envRatio != null) {
    diskUsageRatio = envRatio;
    totalDisk = 100 * 1024 * 1024 * 1024;
    freeDisk = totalDisk * (1 - diskUsageRatio);
  } else {
    const disk = await readDiskUsageFromFilesystem();
    diskUsageRatio = disk.ratio;
    totalDisk = disk.totalBytes;
    freeDisk = disk.freeBytes;
  }

  return {
    cpuCount: cpus.length || 1,
    loadAverage1m: loadAvg[0] ?? 0,
    totalMemoryBytes: totalMem,
    freeMemoryBytes: freeMem,
    totalDiskBytes: totalDisk,
    freeDiskBytes: freeDisk,
    diskUsageRatio,
    uptimeSeconds: Math.floor(os.uptime()),
    livekitReachable: null,
    postgresReachable: null,
    redisReachable: null,
    httpsReachable: null,
    udpLikelyOpen: null,
    turnConfigured: hasTurnEnv(),
    startedAt: PROCESS_STARTED_AT,
  };
}

/**
 * Read real disk usage via fs.statfs. Works on Linux/macOS (Node 18.15+);
 * throws ENOSYS on Windows. On any error, falls back to the 100GB/50%
 * placeholder so Doctor never crashes just because it can't read the disk.
 */
async function readDiskUsageFromFilesystem(): Promise<{ ratio: number; totalBytes: number; freeBytes: number }> {
  const fallback = { ratio: 0.5, totalBytes: 100 * 1024 * 1024 * 1024, freeBytes: 50 * 1024 * 1024 * 1024 };
  try {
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(process.cwd());
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bfree;
    if (totalBytes <= 0) return fallback;
    return { ratio: 1 - freeBytes / totalBytes, totalBytes, freeBytes };
  } catch {
    // ENOSYS on Windows, or any other filesystem error — use the fallback.
    return fallback;
  }
}

function readDiskUsageRatioFromEnv(): number | null {
  const raw = process.env.LOBBYFORGE_DISK_USAGE_RATIO;
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isNaN(n)) return null;
  return n;
}

function hasTurnEnv(): boolean {
  return Boolean(
    process.env.LOBBYFORGE_TURN_URL &&
      process.env.LOBBYFORGE_TURN_STATIC_AUTH_SECRET
  );
}

function envUrl(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

/**
 * Run every Doctor check and return a populated report. This is what the
 * /api/doctor endpoint calls.
 */
export async function collectDoctorReport(): Promise<{ report: DoctorReport; stats: SystemStats }> {
  const stats = await collectSystemStats();
  const livekitUrl = envUrl('LIVEKIT_URL', 'http://localhost:7880');
  const postgresUrl = envUrl('POSTGRES_URL', 'postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge');
  const redisUrl = envUrl('REDIS_URL', 'redis://:lobbyforge_dev@localhost:6379');
  const publicUrl = envUrl('NEXT_PUBLIC_BASE_URL', 'http://localhost:3000');

  const [livekitOk, postgresOk, redisOk, httpsOk] = await Promise.all([
    probeUrl(`${livekitUrl}/`).catch(() => false),
    probePostgres(postgresUrl).catch(() => false),
    probeRedis(redisUrl).catch(() => false),
    probeUrl(publicUrl).catch(() => false),
  ]);

  stats.livekitReachable = livekitOk;
  stats.postgresReachable = postgresOk;
  stats.redisReachable = redisOk;
  stats.httpsReachable = httpsOk;
  // UDP reachability can't be reliably self-tested from the host (it checks
  // inbound reachability for external peers). Leave null and rely on the
  // turn_configured check below, which warns when TURN is missing AND UDP
  // is reported closed. A real STUN-based probe is a deferred item.
  stats.udpLikelyOpen = null;

  const checks = buildChecksFromStats(stats);
  const report = buildDoctorReport(checks, stats);
  return { report, stats };
}

async function probePostgres(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 2 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    console.error('[doctor] postgres probe failed:', err);
    return false;
  } finally {
    await sql.end();
  }
}

/**
 * Probe the app's configured Redis instance via the shared ioredis singleton.
 * A self-health check should test the same connection the app uses, not an
 * arbitrary URL — so we ignore the URL argument and ping the singleton.
 * Times out after 2s so a hung Redis can't stall the whole Doctor report.
 */
async function probeRedis(_url: string): Promise<boolean> {
  try {
    const { redis } = await import('@/lib/redis');
    const result = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return result === 'PONG';
  } catch (err) {
    console.error('[doctor] redis probe failed:', err);
    return false;
  }
}

/**
 * Translate a SystemStats snapshot into the list of DoctorCheck entries.
 * Pure: no I/O, no clock, no env reads. Easy to unit-test.
 */
export function buildChecksFromStats(stats: SystemStats): DoctorCheck[] {
  const out: DoctorCheck[] = [];

  // System checks
  out.push({
    id: 'cpu_count',
    category: DoctorCategory.SYSTEM,
    ok: stats.cpuCount >= 1,
    level: AlertLevel.INFO,
    message: `${stats.cpuCount} logical CPU core(s) reported.`,
    detail: { loadAverage1m: stats.loadAverage1m },
  });

  const freeRatio = stats.totalMemoryBytes > 0 ? stats.freeMemoryBytes / stats.totalMemoryBytes : 0;
  out.push({
    id: 'memory_free',
    category: DoctorCategory.SYSTEM,
    ok: true,
    level: freeRatio < 0.1 ? AlertLevel.CRITICAL : freeRatio < 0.2 ? AlertLevel.WARNING : AlertLevel.INFO,
    message:
      freeRatio < 0.1
        ? 'Less than 10% of RAM is free.'
        : freeRatio < 0.2
          ? 'Less than 20% of RAM is free.'
          : `${Math.round(freeRatio * 100)}% of RAM is free.`,
    detail: { freeBytes: stats.freeMemoryBytes, totalBytes: stats.totalMemoryBytes },
  });

  out.push({
    id: 'disk_usage',
    category: DoctorCategory.SYSTEM,
    ok: stats.diskUsageRatio < 0.9,
    level:
      stats.diskUsageRatio >= 0.95
        ? AlertLevel.FATAL
        : stats.diskUsageRatio >= 0.9
          ? AlertLevel.CRITICAL
          : stats.diskUsageRatio >= 0.8
            ? AlertLevel.WARNING
            : AlertLevel.INFO,
    message:
      stats.diskUsageRatio >= 0.95
        ? 'Disk usage at or above 95% — clean up before continuing.'
        : stats.diskUsageRatio >= 0.9
          ? 'Disk usage at or above 90% — expand storage or purge old data.'
          : `Disk usage ${Math.round(stats.diskUsageRatio * 100)}%.`,
    detail: { diskUsageRatio: stats.diskUsageRatio },
  });

  const loadPerCpu = stats.loadAverage1m / Math.max(1, stats.cpuCount);
  out.push({
    id: 'load_average',
    category: DoctorCategory.SYSTEM,
    ok: loadPerCpu < 2,
    level: loadPerCpu >= 4 ? AlertLevel.CRITICAL : loadPerCpu >= 2 ? AlertLevel.WARNING : AlertLevel.INFO,
    message:
      loadPerCpu >= 4
        ? `Load average ${stats.loadAverage1m.toFixed(2)} is well above CPU count.`
        : loadPerCpu >= 2
          ? `Load average ${stats.loadAverage1m.toFixed(2)} exceeds CPU count.`
          : `Load average ${stats.loadAverage1m.toFixed(2)}.`,
    detail: { loadPerCpu },
  });

  // Network checks
  out.push({
    id: 'https',
    category: DoctorCategory.NETWORK,
    ok: stats.httpsReachable !== false,
    level: stats.httpsReachable === false ? AlertLevel.CRITICAL : AlertLevel.INFO,
    message:
      stats.httpsReachable === false
        ? 'Public HTTPS URL is not reachable.'
        : stats.httpsReachable === true
          ? 'Public HTTPS URL is reachable.'
          : 'Public HTTPS not yet probed.',
  });

  out.push({
    id: 'udp_range',
    category: DoctorCategory.NETWORK,
    ok: stats.udpLikelyOpen !== false,
    level: stats.udpLikelyOpen === false ? AlertLevel.WARNING : AlertLevel.INFO,
    message:
      stats.udpLikelyOpen === false
        ? 'UDP range may be blocked — voice/video will fall back to TURN.'
        : stats.udpLikelyOpen === true
          ? 'UDP range looks open.'
          : 'UDP reachability has not been probed yet.',
  });

  // Services checks
  pushReachability(out, 'postgres', DoctorCategory.SERVICES, stats.postgresReachable);
  pushReachability(out, 'redis', DoctorCategory.SERVICES, stats.redisReachable);
  pushReachability(out, 'livekit_signaling', DoctorCategory.SERVICES, stats.livekitReachable);

  // Media checks
  out.push({
    id: 'turn_configured',
    category: DoctorCategory.MEDIA,
    ok: stats.turnConfigured === true || stats.udpLikelyOpen !== false,
    level:
      stats.turnConfigured === false && stats.udpLikelyOpen === false
        ? AlertLevel.WARNING
        : AlertLevel.INFO,
    message:
      stats.turnConfigured === true
        ? 'TURN server is configured.'
        : 'TURN server is not configured — only required if UDP is blocked.',
  });

  return out;
}

function pushReachability(
  out: DoctorCheck[],
  id: string,
  category: DoctorCategory,
  reachable: boolean | null
): void {
  out.push({
    id,
    category,
    ok: reachable !== false,
    level: reachable === false ? AlertLevel.CRITICAL : AlertLevel.INFO,
    message:
      reachable === false
        ? `${id} is not reachable.`
        : reachable === true
          ? `${id} is reachable.`
          : `${id} has not been probed yet.`,
  });
}
