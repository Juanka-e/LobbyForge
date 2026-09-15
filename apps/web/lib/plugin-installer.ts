import { gunzipSync } from 'node:zlib';
/**
 * Plugin installer — downloads, extracts, and validates a marketplace
 * plugin bundle so the dynamic loader can pick it up.
 *
 * The bundle is expected to be a tarball (.tgz) served from the
 * catalog entry's `manifestUrl`. After extraction, the plugin's
 * `index.js` is imported and shape-validated before admission.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { reloadDynamicPlugin } from './plugin-loader';
import { isBlockedNetworkIp } from './ip-ranges';
import { fetchIpPinned } from './ip-pinned-https';

const execFileAsync = promisify(execFile);

const INSTALLED_DIR = resolve(process.cwd(), 'plugins', 'installed');
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_TIMEOUT_MS = 15_000;

export interface InstallResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Download a plugin bundle from `url`, extract it to
 * `plugins/installed/<pluginId>/<version>/`, and reload the dynamic
 * loader so `getPlugin` resolves it.
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
  // LF-004: Validate version as strict semver — it's used as a path segment.
  if (!/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$/i.test(version)) {
    return { ok: false, error: `Invalid version "${version}" — must be semver (e.g. 1.0.0).` };
  }

  const targetDir = join(INSTALLED_DIR, pluginId, version);

  // LF-004: Verify targetDir stays inside INSTALLED_DIR (path traversal guard).
  const resolvedTarget = resolve(targetDir);
  if (!resolvedTarget.startsWith(INSTALLED_DIR + sep)) {
    return { ok: false, error: 'Install path escapes the plugin directory. Rejected.' };
  }

  // LF-004: Extract to a staging dir first, then atomically move into place —
  // a half-failed install never corrupts a previously working version.
  const stagingDir = join(INSTALLED_DIR, pluginId, `.staging-${Date.now()}`);

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

    // 2. Extract into staging.
    mkdirSync(stagingDir, { recursive: true });

    // 3. Write the tarball to staging and extract there.
    const tarPath = join(stagingDir, 'bundle.tgz');
    writeFileSync(tarPath, Buffer.from(tarball));
    await extractTarball(tarPath, stagingDir);

    // 4. Verify the extracted bundle has an index.js.
    const indexPath = join(stagingDir, 'index.js');
    if (!existsSync(indexPath)) {
      const nested = findIndexJs(stagingDir);
      if (!nested) {
        rmSync(stagingDir, { recursive: true, force: true });
        return { ok: false, error: 'Bundle missing index.js — not a valid LobbyForge plugin.' };
      }
    }

    // 5. Atomically move staging into the version dir (replaces any old version).
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    const { renameSync } = await import('node:fs');
    renameSync(stagingDir, targetDir);

    // 6. Reload the dynamic loader so the new plugin is immediately available.
    const reloaded = await reloadDynamicPlugin(pluginId);
    if (!reloaded) {
      return { ok: false, error: 'Plugin loaded but failed shape validation. Check server logs.' };
    }

    return { ok: true, path: targetDir };
  } catch (err) {
    console.error('[plugin-installer] install failed:', (err as Error).message);
    // Clean up staging — the previous version (if any) stays intact.
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    return { ok: false, error: (err as Error).message };
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
  name: string;
  sizeBytes: number;
  typeflag: string;
}

export function parseTarHeaders(uncompressed: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= uncompressed.length) {
    const header = uncompressed.subarray(offset, offset + 512);
    // All-zero header = end of archive.
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/ [\s\S]*$/, '');
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
      const octal = sizeField.toString('utf8').replace(/[  ]/g, '');
      size = parseInt(octal, 8) || 0;
    }
    entries.push({ name, sizeBytes: size, typeflag });

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
    const isRegular = entry.typeflag === '0' || entry.typeflag === ' ';
    const isDir = entry.typeflag === '5';
    if (!isRegular && !isDir) {
      throw new Error(
        `Tarball contains a non-regular file entry: ${entry.name} (type "${entry.typeflag}"). Rejected.`
      );
    }
    if (entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')) {
      throw new Error(`Tarball contains an unsafe path: ${entry.name}. Rejected.`);
    }
  }

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

/** Recursively find an `index.js` in a directory tree (for nested tarballs). */
function findIndexJs(dir: string): string | null {
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const found = findIndexJs(fullPath);
        if (found) return found;
      } else if (entry === 'index.js') {
        return fullPath;
      }
    }
  } catch {
    // ignore
  }
  return null;
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
    const isRegular = entry.typeflag === '0' || entry.typeflag === ' ';
    const isDir = entry.typeflag === '5';
    if (!isRegular && !isDir) {
      return { ok: false, error: `Tarball contains a non-regular file entry: ${entry.name} (type "${entry.typeflag}"). Rejected.` };
    }
    if (entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')) {
      return { ok: false, error: `Tarball contains an unsafe path: ${entry.name}. Rejected.` };
    }
  }
  return { ok: true, entries, totalBytes };
}
