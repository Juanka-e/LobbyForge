/**
 * Doctor checks + system stats collector for the web app.
 *
 * The checks are deliberately pure functions of a SystemStats snapshot so they
 * can be unit-tested without a real host. The collector (collectSystemStats)
 * uses Node's `os` module and is the only server-only side of this file.
 */
import {
  AlertLevel,
  buildDoctorReport,
  DoctorCategory,
  type DoctorCheck,
  type DoctorReport,
  type SystemStats,
} from '@lobbyforge/core';
import type { InstanceStoredImageBytes } from '@lobbyforge/db';
import { recentClientAddresses } from '@/lib/client-address-sample';

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

export interface DoctorRequestContext {
  /**
   * The client address of the request asking for the report, as the app
   * resolves it (trusted proxy header) — Admin → Health and /api/doctor
   * pass it for the `client_address` check (security-review INFRA-V-01).
   */
  clientAddress?: string | null;
}

/**
 * Run every Doctor check and return a populated report. This is what the
 * /api/doctor endpoint calls.
 */
export async function collectDoctorReport(
  context: DoctorRequestContext = {}
): Promise<{ report: DoctorReport; stats: SystemStats }> {
  const stats = await collectSystemStats();
  const livekitUrl = envUrl('LIVEKIT_URL', 'http://localhost:19580');
  const redisUrl = envUrl('REDIS_URL', 'redis://:lobbyforge_dev@localhost:19579');
  // The app itself is reachable only on its OWN listen port. A published
  // host port (19520, 443, ...) is not routable from inside the container,
  // so probing it would always fail — see `probePublicUrl`.
  const publicUrl = publicBaseUrl();

  const [livekitOk, postgresOk, redisOk, httpsOk] = await Promise.all([
    probeUrl(`${livekitUrl}/`).catch(() => false),
    probePostgres().catch(() => false),
    probeRedis(redisUrl).catch(() => false),
    publicUrl ? probeUrl(publicUrl).catch(() => false) : Promise.resolve(null),
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

  const checks = [
    ...buildChecksFromStats(stats),
    buildTrustedProxyCheck({
      nodeEnv: process.env.NODE_ENV,
      trustedProxy: process.env.LOBBYFORGE_TRUSTED_PROXY,
    }),
    // security-review INFRA-V-01: are the proxied client addresses real
    // visitors, or one Docker bridge gateway?
    buildClientAddressCheck({
      trustedProxy: process.env.LOBBYFORGE_TRUSTED_PROXY,
      requestAddress: context.clientAddress ?? null,
      recentAddresses: recentClientAddresses(),
      gateways: await readDefaultGateways(),
    }),
    // security-review FILE-001: images kept in Postgres, instance-wide.
    ...(await collectImageStorageChecks()),
    buildSecureOriginCheck({
      baseUrl: process.env.NEXT_PUBLIC_BASE_URL,
      appOrigin: process.env.LOBBYFORGE_APP_ORIGIN,
      altchaActive: await altchaActiveForDoctor(),
    }),
    // Bot protection (docs/CAPTCHA.md §8): keys, secret, siteverify, test
    // keys in production, and ALTCHA's replay store (Redis).
    ...(await collectCaptchaDoctorChecks(stats.redisReachable)),
    // Email (docs/EMAIL.md §6): transport, password, last test, send
    // failures, the daily limit, and the port 25 / SPF+DMARC / Gmail hints.
    ...(await collectMailDoctorChecks()),
  ];
  const report = buildDoctorReport(checks, stats);
  return { report, stats };
}

async function altchaActiveForDoctor(): Promise<boolean> {
  try {
    const { isAltchaActive } = await import('@/lib/captcha/doctor');
    return await isAltchaActive();
  } catch {
    return true;
  }
}

async function collectCaptchaDoctorChecks(redisReachable: boolean | null): Promise<DoctorCheck[]> {
  try {
    const { collectCaptchaChecks } = await import('@/lib/captcha/doctor');
    return await collectCaptchaChecks({ redisReachable });
  } catch (err) {
    console.error('[doctor] bot protection checks unavailable:', (err as Error).message);
    return [];
  }
}

async function collectMailDoctorChecks(): Promise<DoctorCheck[]> {
  try {
    const { collectMailChecks } = await import('@/lib/mail/doctor');
    return await collectMailChecks();
  } catch (err) {
    console.error('[doctor] email checks unavailable:', (err as Error).message);
    return [];
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Browsers only give a page Web Crypto (`crypto.subtle` — the built-in
 * ALTCHA bot-protection challenge, docs/CAPTCHA.md) and microphone / camera
 * (voice) in a secure context: HTTPS, or localhost. A declared public origin
 * on plain `http://` with any other host breaks voice for every visitor —
 * a WARNING — and, while ALTCHA is the active provider, makes sign-up and
 * new guests depend on the slow pure-JavaScript fallback solver — CRITICAL.
 * Pure: the caller passes the environment and whether ALTCHA is active.
 */
export function buildSecureOriginCheck(env: { baseUrl?: string; appOrigin?: string; altchaActive?: boolean }): DoctorCheck {
  const base = { id: 'secure_origin', category: DoctorCategory.NETWORK };
  const declared = [env.baseUrl, env.appOrigin].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (declared.length === 0) {
    return { ...base, ok: true, level: AlertLevel.INFO, message: 'No public origin declared (NEXT_PUBLIC_BASE_URL / LOBBYFORGE_APP_ORIGIN) — nothing to check.' };
  }
  const insecure = new Set<string>();
  for (const value of declared) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) insecure.add(url.origin);
    } catch {
      // not a URL; other checks report unusable values
    }
  }
  if (insecure.size === 0) {
    return { ...base, ok: true, level: AlertLevel.INFO, message: 'The public origin is HTTPS (or localhost), a secure context.' };
  }
  const origins = [...insecure].join(', ');
  const fix = 'Serve the instance over HTTPS (or use it on localhost only).';
  if (env.altchaActive) {
    return {
      ...base,
      ok: false,
      level: AlertLevel.CRITICAL,
      message:
        `${origins} is plain HTTP, and the built-in ALTCHA bot protection is active. Browsers allow Web Crypto only on HTTPS or localhost, ` +
        'so every sign-up and new guest has to solve the challenge with the much slower pure-JavaScript fallback, and microphone / camera (voice) ' +
        `do not work at all. ${fix}`,
      detail: { origins: [...insecure], altchaActive: true },
    };
  }
  return {
    ...base,
    ok: false,
    level: AlertLevel.WARNING,
    message:
      `${origins} is plain HTTP. Browsers allow microphone / camera (voice) and Web Crypto only on HTTPS or localhost, ` +
      `so visitors cannot talk. ${fix}`,
    detail: { origins: [...insecure], altchaActive: false },
  };
}

const TRUSTED_PROXY_FIX =
  'Behind the bundled nginx set LOBBYFORGE_TRUSTED_PROXY=x-forwarded-for in .env.prod and recreate the web container ' +
  '(behind Cloudflare, also install infra/nginx/cf-real-ip.conf — see docs/DEPLOY_CLOUDFLARE.md).';

/**
 * Security follow-up (review §7.5): without a trusted proxy the app cannot
 * tell clients apart, so in production every visitor shares ONE rate-limit
 * bucket — a single client can lock everyone out of sign-in. Existing
 * installs keep running; Doctor reports it as a warning with the fix.
 * Pure: the caller passes the environment.
 */
export function buildTrustedProxyCheck(env: { nodeEnv?: string; trustedProxy?: string }): DoctorCheck {
  const mode = env.trustedProxy?.trim() ?? '';
  const production = env.nodeEnv === 'production';
  const base = { id: 'trusted_proxy', category: DoctorCategory.NETWORK, detail: { mode: mode || null } };

  if (mode === 'x-forwarded-for') {
    return {
      ...base,
      ok: true,
      level: AlertLevel.INFO,
      message: 'Client addresses come from X-Forwarded-For, set by the trusted reverse proxy.',
    };
  }
  if (mode === 'cloudflare') {
    return {
      ...base,
      ok: true,
      level: AlertLevel.INFO,
      message:
        'Client addresses come from CF-Connecting-IP. This is only safe when the origin accepts traffic from Cloudflare alone — ' +
        'anyone who reaches it directly can choose their own address. With the bundled nginx, prefer cf-real-ip.conf with x-forwarded-for.',
    };
  }

  const problem = !mode
    ? 'LOBBYFORGE_TRUSTED_PROXY is not set'
    : mode === 'none'
      ? 'LOBBYFORGE_TRUSTED_PROXY is "none"'
      : `LOBBYFORGE_TRUSTED_PROXY="${mode}" is not recognised (use x-forwarded-for or cloudflare)`;
  if (!production) {
    return {
      ...base,
      ok: true,
      level: AlertLevel.INFO,
      message: `${problem} — fine for local development; in production every visitor would share one rate-limit bucket.`,
    };
  }
  return {
    ...base,
    ok: false,
    level: AlertLevel.WARNING,
    message: `${problem}, so every visitor shares one rate-limit bucket and one client can lock everyone out of sign-in. ${TRUSTED_PROXY_FIX}`,
  };
}

/** The dotted IPv4 of a plain or IPv4-mapped IPv6 address, else null. */
function ipv4Of(address: string): string | null {
  const plain = address.trim().replace(/^::ffff:/i, '');
  const parts = plain.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.map(Number).join('.');
}

/**
 * Shaped like a NAT / bridge gateway: a private IPv4 (10/8, 172.16/12,
 * 192.168/16) ending in `.1`. Docker's bridge gateways come from exactly
 * these pools (172.17.0.1, 172.18.0.1, … then 192.168.0.1, 192.168.16.1, …),
 * and it is also the address a router's hairpin NAT shows for every LAN
 * client. A real visitor's address almost never is.
 */
export function isGatewayLikeAddress(address: string): boolean {
  const ip = ipv4Of(address);
  if (!ip) return false;
  const [a, b, , d] = ip.split('.').map(Number) as [number, number, number, number];
  if (d !== 1) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const CLIENT_ADDRESS_FIX =
  'Give the edge network IPv6 (enable_ipv6 on lobbyforge-edge) or turn off Docker’s userland proxy ' +
  '("userland-proxy": false in /etc/docker/daemon.json, with ip6tables enabled) and restart Docker — ' +
  'see docs/DEPLOY_CLOUDFLARE.md#client-addresses-behind-docker.';

/** At least this many sampled requests before the share of gateway addresses means anything. */
const CLIENT_ADDRESS_MIN_SAMPLE = 20;

/**
 * security-review INFRA-V-01: with a trusted proxy configured, are the
 * client addresses the app reads real visitors, or one gateway? Behind
 * Docker's default userland proxy with no IPv6 on the bridge, nginx sees
 * every IPv6 visitor (or every visitor) as the bridge gateway, so they all
 * share one per-address rate-limit bucket — one client can lock the rest
 * out of sign-in, and the per-address upload and guest budgets become
 * instance-wide.
 *
 * Signals: the address of the request asking for this report, and a sample
 * of recent proxied requests (lib/client-address-sample.ts), each compared
 * with the container's default gateways (/proc/net/route — the edge bridge
 * gateway when web shares nginx's network) and with the gateway shape
 * ({@link isGatewayLikeAddress}). Pure: the caller passes everything.
 */
export function buildClientAddressCheck(input: {
  trustedProxy?: string;
  requestAddress?: string | null;
  recentAddresses?: string[];
  gateways?: string[];
}): DoctorCheck {
  const base = { id: 'client_address', category: DoctorCategory.NETWORK };
  const mode = input.trustedProxy?.trim() ?? '';
  if (mode !== 'x-forwarded-for' && mode !== 'cloudflare') {
    return {
      ...base,
      ok: true,
      level: AlertLevel.INFO,
      message: 'Client addresses are not read from a proxy header — see the trusted_proxy check.',
    };
  }
  const gateways = new Set((input.gateways ?? []).map((g) => ipv4Of(g) ?? g.trim()));
  const isShared = (address: string) => gateways.has(ipv4Of(address) ?? address.trim()) || isGatewayLikeAddress(address);
  const known = (address: string | null | undefined): address is string => Boolean(address) && address !== 'unknown';

  const recent = (input.recentAddresses ?? []).filter(known);
  const sharedRecent = recent.filter(isShared);
  const requestShared = known(input.requestAddress) && isShared(input.requestAddress);
  const mostlyShared = recent.length >= CLIENT_ADDRESS_MIN_SAMPLE && sharedRecent.length * 2 >= recent.length;
  const distinct = new Set(recent).size;
  const detail = { sampled: recent.length, sharedInSample: sharedRecent.length, distinct };

  if (requestShared || mostlyShared) {
    const address = requestShared ? input.requestAddress! : mostCommon(sharedRecent);
    const evidence = requestShared
      ? 'this request came from it'
      : `${sharedRecent.length} of the last ${recent.length} requests came from it`;
    return {
      ...base,
      ok: false,
      level: AlertLevel.WARNING,
      message:
        `Requests reach the app from ${address}, a gateway address, instead of each visitor’s own address (${evidence}). ` +
        'Behind Docker’s default userland proxy with no IPv6 on the bridge, nginx sees IPv6 visitors — or all of them — as the bridge gateway, ' +
        `so they share one rate-limit bucket and one client can lock the others out of sign-in. ${CLIENT_ADDRESS_FIX}`,
      detail: { ...detail, address },
    };
  }
  return {
    ...base,
    ok: true,
    level: AlertLevel.INFO,
    message:
      recent.length === 0
        ? 'No proxied requests sampled yet.'
        : `Client addresses look like real visitors (${distinct} distinct among the last ${recent.length} requests).`,
    detail,
  };
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/**
 * The container's default IPv4 gateways from /proc/net/route (Linux;
 * empty elsewhere or on any error). In the production compose web shares
 * the edge network with nginx, so this is the bridge gateway nginx would
 * report for userland-proxied clients.
 */
export async function readDefaultGateways(): Promise<string[]> {
  try {
    const { readFile } = await import('node:fs/promises');
    return parseDefaultGateways(await readFile('/proc/net/route', 'utf8'));
  } catch {
    return [];
  }
}

/** Parse /proc/net/route: default routes (destination 0) with their little-endian hex gateway. */
export function parseDefaultGateways(routeTable: string): string[] {
  const gateways = new Set<string>();
  for (const line of routeTable.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== '00000000' || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway) || gateway === '00000000') continue;
    const n = Number.parseInt(gateway, 16);
    gateways.add([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.'));
  }
  return [...gateways];
}

/** Default threshold for the `image_storage` warning: 1 GiB of images in Postgres. */
export const IMAGE_STORAGE_WARN_BYTES = 1024 * 1024 * 1024;

/** The `image_storage` threshold: LOBBYFORGE_IMAGE_STORAGE_WARN_MB, or 1 GiB. */
export function imageStorageWarnBytes(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.LOBBYFORGE_IMAGE_STORAGE_WARN_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : IMAGE_STORAGE_WARN_BYTES;
}

function mebibytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * security-review FILE-001: avatars, banners and the logo live in Postgres
 * as data URLs, so they grow the database (and every backup). Per-user
 * quotas, the guest refusal and the per-address daily upload budget bound
 * the rate; this warns when the instance-wide total passes the threshold.
 * Pure: the caller passes the totals and the threshold.
 */
export function buildImageStorageCheck(totals: InstanceStoredImageBytes, warnBytes: number): DoctorCheck {
  const base = {
    id: 'image_storage',
    category: DoctorCategory.SYSTEM,
    detail: { ...totals, warnBytes },
  };
  const breakdown =
    `accounts ${mebibytes(totals.userBytes - totals.guestBytes)}, guests ${mebibytes(totals.guestBytes)}, ` +
    `server banners ${mebibytes(totals.serverBytes)}, logo ${mebibytes(totals.logoBytes)}`;
  if (totals.totalBytes < warnBytes) {
    return {
      ...base,
      ok: true,
      level: AlertLevel.INFO,
      message: `Stored images use ${mebibytes(totals.totalBytes)} of the database (${breakdown}).`,
    };
  }
  const guestHint =
    totals.guestBytes > 0
      ? ' Guests can no longer upload images; the ones they stored earlier stay until those guest accounts are removed.'
      : '';
  return {
    ...base,
    ok: false,
    level: AlertLevel.WARNING,
    message:
      `Stored images use ${mebibytes(totals.totalBytes)} of the database, above the ${mebibytes(warnBytes)} warning threshold (${breakdown}). ` +
      'Images are kept in Postgres, so they grow the database and every backup. Check the disk and remove accounts or servers you no longer need.' +
      `${guestHint} Change the threshold with LOBBYFORGE_IMAGE_STORAGE_WARN_MB.`,
  };
}

async function collectImageStorageChecks(): Promise<DoctorCheck[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [{ getInstanceStoredImageBytes }, { getDb }] = await Promise.all([import('@lobbyforge/db'), import('@/lib/db')]);
    const totals = await Promise.race([
      getInstanceStoredImageBytes(getDb()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 3000);
      }),
    ]);
    return [buildImageStorageCheck(totals, imageStorageWarnBytes())];
  } catch (err) {
    // The postgres check already reports an unreachable database.
    console.error('[doctor] image storage check unavailable:', (err as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the app's configured Postgres — the SAME connection every request
 * uses, exactly like `probeRedis` pings the shared client.
 *
 * beta-review: this used to open its own connection to `POSTGRES_URL`,
 * falling back to a host-facing `localhost:<published port>` URL. Nothing
 * sets `POSTGRES_URL` (the app reads `DATABASE_URL`), and inside the
 * container `localhost` is the container itself — so Doctor reported
 * "postgres is not reachable" (critical) on a perfectly healthy stack.
 */
async function probePostgres(): Promise<boolean> {
  try {
    const { getDb } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    await Promise.race([
      getDb().execute(sql`SELECT 1`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return true;
  } catch (err) {
    console.error('[doctor] postgres probe failed:', err);
    return false;
  }
}

/**
 * The externally reachable base URL, or null when the operator hasn't
 * declared one. Only a declared URL is probed: a self-host on plain HTTP
 * behind a LAN address has nothing to check, and guessing a published
 * port would fail from inside the container.
 */
function publicBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_BASE_URL;
  return raw && raw.trim() ? raw.trim() : null;
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
  // beta-review: a self-probe runs INSIDE the app container, where the
  // published host port / public domain often isn't routable even on a
  // perfectly healthy deployment. So an unreachable public URL is a
  // WARNING with an actionable message, never a critical — and when no
  // public URL is configured at all there is simply nothing to check.
  out.push({
    id: 'https',
    category: DoctorCategory.NETWORK,
    ok: stats.httpsReachable !== false,
    level: stats.httpsReachable === false ? AlertLevel.WARNING : AlertLevel.INFO,
    message:
      stats.httpsReachable === false
        ? 'NEXT_PUBLIC_BASE_URL did not answer from inside the app container. Verify it from outside — a reverse proxy that only accepts external traffic can cause this.'
        : stats.httpsReachable === true
          ? 'Public HTTPS URL is reachable.'
          : 'No public base URL configured (NEXT_PUBLIC_BASE_URL) — nothing to probe.',
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
