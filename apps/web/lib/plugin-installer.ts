import { gunzipSync } from 'node:zlib';
/**
 * Plugin installer — downloads, extracts, and activates a marketplace
 * plugin bundle.
 *
 * The bundle is a tarball (.tgz) served from the catalog entry's
 * `manifestUrl`, verified against the reviewed SHA-256 pin, extracted
 * into `<root>/<pluginId>/<version>/` (root: LOBBYFORGE_PLUGIN_INSTALL_DIR,
 * see plugin-install-layout.ts) and loaded by the plugin-worker by exact
 * version + digest. Only then is it recorded as active; the superseded
 * version folder is deleted afterwards. Plugin code is never imported here.
 *
 * ADR-007: only `sdk: "sandbox-v1"` bundles install — `manifest.json` and
 * `server.js` at the archive root (checked in the tar scan, before
 * extraction), a valid manifest whose id and version match the catalog
 * entry (checked on the extracted files, plugin-install-layout.ts). Legacy
 * Node bundles (`index.js`) are refused.
 */

import { mkdirSync, rmSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerDynamicPlugin } from './plugin-loader';
import { describeWorkerPlugin, workerRuntimeConfigured } from './plugin-worker-client';
import {
  PLUGIN_ID_RE,
  VERSION_RE,
  activateStagedBundle,
  pluginInstallDir,
  pruneSupersededVersions,
} from './plugin-install-layout';
import { isBlockedNetworkIp } from './ip-ranges';
import { fetchIpPinned } from './ip-pinned-https';

const execFileAsync = promisify(execFile);

const MAX_BUNDLE_BYTES = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_TIMEOUT_MS = 15_000;

export interface InstallResult {
  ok: boolean;
  path?: string;
  /** The version now recorded as active. */
  version?: string;
  /** Digest of the active version's files (what the worker verifies). */
  digest?: string;
  error?: string;
}

/**
 * One install per plugin at a time (the web app is a single process):
 * activation and pruning read and rewrite the plugin's folder.
 */
const installLocks = new Map<string, Promise<unknown>>();

function withPluginLock<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
  const previous = installLocks.get(pluginId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  installLocks.set(pluginId, tail);
  void tail.then(() => {
    if (installLocks.get(pluginId) === tail) installLocks.delete(pluginId);
  });
  return run;
}

/**
 * Download a plugin bundle from `url`, extract it to
 * `<root>/<pluginId>/<version>/`, have the worker load that exact version,
 * record it as active, register it and delete superseded versions.
 */
export async function installPluginBundle(
  pluginId: string,
  url: string,
  version: string,
  /**
   * 13th-audit: the REVIEWED artifact pin (catalog.bundleSha256 /
   * bundleSizeBytes). When provided, the downloaded bytes must match
   * BOTH, compared constant-time — a compromised publisher host can no
   * longer swap the artifact behind an unchanged approved catalog row.
   */
  expectedPin?: { sha256: string; sizeBytes: number }
): Promise<InstallResult> {
  // Both are path segments: the id is a folder name, the version too.
  if (!PLUGIN_ID_RE.test(pluginId)) {
    return { ok: false, error: `Invalid plugin id "${pluginId}".` };
  }
  // LF-004: Validate version as strict semver — it's used as a path segment.
  if (!VERSION_RE.test(version)) {
    return { ok: false, error: `Invalid version "${version}" — must be semver (e.g. 1.0.0).` };
  }
  // Activation needs the worker to load the bundle; without it nothing
  // could run anyway, so refuse before touching the disk.
  if (!workerRuntimeConfigured()) {
    return {
      ok: false,
      error:
        'Dynamic plugins need the isolated plugin-worker: set LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true and LOBBYFORGE_PLUGIN_WORKER_URL.',
    };
  }

  const root = pluginInstallDir();
  const pluginDir = join(root, pluginId);

  // LF-004: Verify the version folder stays inside the root (path traversal guard).
  if (!resolve(pluginDir, version).startsWith(root + sep)) {
    return { ok: false, error: 'Install path escapes the plugin directory. Rejected.' };
  }

  return withPluginLock(pluginId, () => downloadAndActivate(pluginId, url, version, root, expectedPin));
}

async function downloadAndActivate(
  pluginId: string,
  url: string,
  version: string,
  root: string,
  expectedPin: { sha256: string; sizeBytes: number } | undefined
): Promise<InstallResult> {
  // LF-004: Extract to a staging dir first, then move into place — a
  // half-failed install never corrupts a previously working version. The
  // tarball itself sits next to the staging dir, so it never ends up in
  // the bundle folder.
  const pluginDir = join(root, pluginId);
  const stagingDir = join(pluginDir, `.staging-${Date.now()}-${randomBytes(4).toString('hex')}`);
  const tarPath = `${stagingDir}.tgz`;

  try {
    // 1. Download the tarball.
    const tarball = await downloadWithTimeout(url);
    if (tarball.byteLength > MAX_BUNDLE_BYTES) {
      return { ok: false, error: `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes` };
    }

    // 1b. 13th-audit: verify the bytes against the REVIEWED pin before
    // anything touches the filesystem.
    if (expectedPin) {
      if (tarball.byteLength !== expectedPin.sizeBytes) {
        return {
          ok: false,
          error: `Bundle size ${tarball.byteLength} does not match the reviewed artifact (${expectedPin.sizeBytes}) — the download may have been tampered with.`,
        };
      }
      const { createHash, timingSafeEqual } = await import('node:crypto');
      const actual = createHash('sha256').update(Buffer.from(tarball)).digest();
      const expected = Buffer.from(expectedPin.sha256, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return {
          ok: false,
          error: 'Bundle SHA-256 does not match the reviewed artifact — refusing to install possibly tampered code.',
        };
      }
    }

    // 2. Write the tarball next to staging and extract into staging.
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(tarPath, Buffer.from(tarball));
    await extractTarball(tarPath, stagingDir);
    rmSync(tarPath, { force: true });

    // 3. Move into `<version>/`, have the worker load that exact version +
    // digest, then record it as active. The previous version stays active
    // (and on disk) until that record is written; a refusal restores it.
    const activation = await activateStagedBundle({
      root,
      pluginId,
      version,
      stagingDir,
      describe: describeWorkerPlugin,
    });
    if (!activation.ok) {
      return { ok: false, error: activation.error };
    }

    // 4. New requests use the new version from here on.
    registerDynamicPlugin(activation.info);

    // 5. Delete superseded versions. A failure here leaves stale folders
    // (deleted on the next install), never a broken plugin.
    try {
      pruneSupersededVersions(root, pluginId, version);
    } catch (err) {
      console.warn(`[plugin-installer] could not prune old versions of "${pluginId}":`, (err as Error).message);
    }

    return { ok: true, path: activation.path, version, digest: activation.digest };
  } catch (err) {
    // One line, no control characters: the message can carry catalogue
    // data (plugin ids, versions, URLs) that must not forge log entries.
    console.error('[plugin-installer] install failed:', JSON.stringify((err as Error).message));
    return { ok: false, error: (err as Error).message };
  } finally {
    // No-ops once staging has been moved into place; otherwise the
    // previous version (if any) stays intact.
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(tarPath, { force: true });
  }
}

/** Download a URL with a timeout, returning an ArrayBuffer.
 *  Validates the URL is HTTPS and resolves the hostname to verify the IP
 *  is not private/loopback (SSRF protection with DNS-rebinding mitigation). */
async function downloadWithTimeout(url: string): Promise<ArrayBuffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid manifest URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Manifest URL must use HTTPS');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Quick hostname string check (catches obvious cases before DNS).
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Manifest URL must not point to a private address');
  }

  // DNS resolve the hostname and check each resolved IP against private ranges.
  // This catches DNS-rebinding attacks where the hostname passes the string
  // check but resolves to an internal IP at fetch time.
  const { lookup } = await import('node:dns').then((m) => m.promises);
  let addresses: string[];
  try {
    const result = await lookup(host, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    throw new Error(`Could not resolve hostname: ${host}`);
  }
  for (const ip of addresses) {
    if (isPrivateIp(ip)) {
      throw new Error(`Manifest URL resolves to private address: ${ip}`);
    }
  }

  // SEC-009: PIN the connection to the verified IP via https.request with
  // a custom `lookup` — a plain fetch(url) re-resolves DNS, so a rebind
  // between the check above and the fetch would reach an internal
  // address. The custom lookup serves ONLY the pre-verified address;
  // SNI + certificate validation keep using the ORIGINAL hostname
  // (serverName option), so TLS stays correct.
  // 14th-audit: shared IP-pinned transport (same code path as the
  // marketplace review-time bundle fetch and the directory verifier).
  const res = await fetchIpPinned(url, parsed.hostname, addresses, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return res.arrayBuffer;
}

/**
 * LF-SEC-013: SSRF boundary decisions go through the canonical IP/CIDR
 * classifier (lib/ip-ranges.ts) — the old prefix/regex checks mishandled
 * compressed IPv6 notation and IPv4-mapped forms. Unparseable addresses
 * are refused (fail closed).
 */
function isPrivateIp(ip: string): boolean {
  return isBlockedNetworkIp(ip);
}

/**
 * 14th-audit: PROGRAMMATIC tar header scan. The old approach parsed
 * `tar -tv` human output with a regex; real GNU tar verbose lines did
 * NOT match, so the size-bomb check, symlink/hardlink/device/FIFO
 * checks and traversal pre-check silently skipped EVERY entry. We now
 * walk the uncompressed archive's 512-byte header blocks directly —
 * the POSIX ustar format is stable and parsing it ourselves is exact.
 */
interface TarEntry {
  /** The path tar extracts to: ustar `prefix` + '/' + `name` when a prefix is set. */
  name: string;
  /** The raw path fields (`name`, and `prefix` when set) - each is checked on its own too. */
  pathFields: string[];
  sizeBytes: number;
  typeflag: string;
}

/**
 * Security follow-up: a ustar header splits a long path across `prefix`
 * (offset 345, 155 bytes) and `name`; tar extracts to `prefix/name`. The
 * scan used to look at `name` alone, so a `../` hidden in the prefix
 * passed. Check the joined path and every raw field.
 */
function isUnsafeTarPath(entry: TarEntry): boolean {
  return [entry.name, ...entry.pathFields].some(
    (path) => path.includes('..') || path.startsWith('/') || path.includes('\\')
  );
}

/**
 * The regular files that land at the bundle root once tar strips the first
 * path component (`--strip-components=1`): `./server.js` and
 * `bundle/server.js` both become `server.js`; a bare `server.js` is dropped.
 */
export function bundleRootFiles(entries: TarEntry[]): Set<string> {
  const root = new Set<string>();
  for (const entry of entries) {
    // '0' and NUL (old tar) are regular files, as in the scan below.
    if (entry.typeflag !== '0' && entry.typeflag !== '\0') continue;
    const parts = entry.name.split('/').filter((part) => part !== '');
    if (parts.length === 2) root.add(parts[1]!);
  }
  return root;
}

/** Why a scanned archive is not a sandbox-v1 bundle, or null when it has the root files. */
export function missingSandboxRootFiles(entries: TarEntry[]): string | null {
  const root = bundleRootFiles(entries);
  if (root.has('manifest.json') && root.has('server.js')) return null;
  if (root.has('index.js')) {
    return 'This is a legacy Node bundle (index.js). Marketplace plugins now run sandboxed: rebuild it as sdk "sandbox-v1" (manifest.json + server.js at the archive root, see docs/PLUGIN_PUBLISHING.md).';
  }
  return 'Bundle must contain manifest.json and server.js at the archive root (entries ./manifest.json and ./server.js) — not a sandbox-v1 LobbyForge plugin.';
}

export function parseTarHeaders(uncompressed: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= uncompressed.length) {
    const header = uncompressed.subarray(offset, offset + 512);
    // All-zero header = end of archive.
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\x00[\s\S]*$/, '');
    // ustar (POSIX "ustar\0" and GNU "ustar ") carries a path prefix at offset 345.
    const isUstar = header.subarray(257, 262).toString('latin1') === 'ustar';
    const prefix = isUstar ? header.subarray(345, 500).toString('utf8').replace(/\x00[\s\S]*$/, '') : '';
    const sizeField = header.subarray(124, 136);
    const typeflag = String.fromCharCode(header[156]!);
    let size: number;
    if (sizeField[0]! & 0x80) {
      // GNU base-256 size encoding.
      size = 0;
      for (let i = 1; i < sizeField.length; i++) {
        size = size * 256 + sizeField[i]!;
      }
    } else {
      const octal = sizeField.toString('utf8').replace(/[\x00 ]/g, '');
      size = parseInt(octal, 8) || 0;
    }
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      pathFields: prefix ? [prefix, name] : [name],
      sizeBytes: size,
      typeflag,
    });

    const dataBlocks = Math.ceil(size / 512);
    offset += 512 + dataBlocks * 512;
  }
  return entries;
}

/** Extract a .tgz tarball using the system `tar` command.
 *  LF-004 + 14th-audit: decompress in-memory (bounded), scan tar
 *  headers PROGRAMATICALLY, reject traversal/absolute paths, non-regular
 *  entries and bombs BEFORE extraction; post-extraction symlink walk
 *  stays as defense-in-depth. */
async function extractTarball(tarPath: string, destDir: string): Promise<void> {
  const MAX_ENTRIES = 500;
  const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB uncompressed
  const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024; // scan-buffer cap

  // 1. Bounded decompress.
  const { createGunzip } = await import('node:zlib');
  const fsp = await import('node:fs').then((m) => m.promises);
  const compressed = await fsp.readFile(tarPath);
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error(`Tarball exceeds the ${MAX_COMPRESSED_BYTES} byte compressed cap.`);
  }
  const uncompressed: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const gunzip = createGunzip();
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      // Header+data upper bound; the exact data cap is enforced in the scan.
      if (total > MAX_TOTAL_BYTES + 512 * (MAX_ENTRIES + 4)) {
        gunzip.destroy(new Error(`Tarball exceeds ${MAX_TOTAL_BYTES} bytes uncompressed — possible tar bomb.`));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    gunzip.end(compressed);
  });

  // 2. Programmatic header scan — every rule now counts every entry.
  const entries = parseTarHeaders(uncompressed);
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Tarball has ${entries.length} entries (max ${MAX_ENTRIES}) — possible tar bomb.`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += entry.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Tarball exceeds ${MAX_TOTAL_BYTES} bytes uncompressed — possible tar bomb.`);
    }
    const isRegular = entry.typeflag === '0' || entry.typeflag === '\x00';
    const isDir = entry.typeflag === '5';
    if (!isRegular && !isDir) {
      throw new Error(
        `Tarball contains a non-regular file entry: ${entry.name} (type "${entry.typeflag}"). Rejected.`
      );
    }
    if (isUnsafeTarPath(entry)) {
      throw new Error(`Tarball contains an unsafe path: ${entry.name}. Rejected.`);
    }
  }
  // ADR-007: refuse anything but a sandbox-v1 bundle before extracting it
  // (activation re-checks the extracted files and the manifest).
  const rootError = missingSandboxRootFiles(entries);
  if (rootError) throw new Error(rootError);

  // 3. Extract with hardened flags.
  await execFileAsync('tar', [
    '-xzf', tarPath,
    '-C', destDir,
    '--strip-components=1',
    '--no-same-owner',
    '--no-same-permissions',
    '--overwrite-dir',
  ], { timeout: 60_000 });

  // 4. Post-extraction: verify nothing escaped destDir.
  assertNoEscapingSymlinks(destDir);
}

/** Walk destDir and reject any symlink whose target resolves outside it. */
function assertNoEscapingSymlinks(dir: string, depth = 0): void {
  if (depth > 10) return; // depth cap
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Extracted bundle contains a symlink: ${fullPath}. Rejected.`);
      }
      if (stat.isDirectory()) {
        assertNoEscapingSymlinks(fullPath, depth + 1);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Rejected')) throw err;
    // ignore walk errors
  }
}

export async function downloadBundleForReview(url: string): Promise<ArrayBuffer> {
  return downloadWithTimeout(url);
}

/**
 * 14th-audit: scan a gzip'd tarball against every security rule
 * (entries, total size, non-regular types, traversal) WITHOUT
 * extracting. Exported for regression tests.
 */
export function scanTarEntries(
  compressed: Buffer
): { ok: true; entries: TarEntry[]; totalBytes: number } | { ok: false; error: string } {
  const MAX_ENTRIES = 500;
  const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    return { ok: false, error: `Tarball exceeds the ${MAX_COMPRESSED_BYTES} byte compressed cap.` };
  }
  let uncompressed: Buffer;
  try {
    uncompressed = gunzipSync(compressed);
  } catch {
    return { ok: false, error: 'Not a valid gzip stream' };
  }
  if (uncompressed.length > MAX_TOTAL_BYTES + 512 * (MAX_ENTRIES + 4)) {
    return { ok: false, error: `Tarball exceeds ${MAX_TOTAL_BYTES} bytes uncompressed — possible tar bomb.` };
  }
  const entries = parseTarHeaders(uncompressed);
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: `Tarball has ${entries.length} entries (max ${MAX_ENTRIES}) — possible tar bomb.` };
  }
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += entry.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: `Tarball exceeds ${MAX_TOTAL_BYTES} bytes uncompressed — possible tar bomb.` };
    }
    const isRegular = entry.typeflag === '0' || entry.typeflag === '\x00';
    const isDir = entry.typeflag === '5';
    if (!isRegular && !isDir) {
      return { ok: false, error: `Tarball contains a non-regular file entry: ${entry.name} (type "${entry.typeflag}"). Rejected.` };
    }
    if (isUnsafeTarPath(entry)) {
      return { ok: false, error: `Tarball contains an unsafe path: ${entry.name}. Rejected.` };
    }
  }
  return { ok: true, entries, totalBytes };
}
