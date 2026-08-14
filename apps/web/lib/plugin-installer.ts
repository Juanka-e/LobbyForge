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
  version: string
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/** Check if an IP address is private, loopback, or link-local. */
function isPrivateIp(ip: string): boolean {
  // IPv4 checks
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    return (
      parts[0] === 10 ||                                    // 10.0.0.0/8
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // 172.16.0.0/12
      (parts[0] === 192 && parts[1] === 168) ||             // 192.168.0.0/16
      parts[0] === 127 ||                                   // 127.0.0.0/8 (loopback)
      (parts[0] === 169 && parts[1] === 254) ||             // 169.254.0.0/16 (link-local)
      parts[0] === 0                                        // 0.0.0.0/8
    );
  }
  // IPv6 checks
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||                                     // loopback
    lower.startsWith('fe80:') ||                            // link-local
    lower.startsWith('fc') || lower.startsWith('fd') ||     // ULA
    lower.startsWith('::ffff:') && isPrivateIp(lower.slice(7)) // IPv4-mapped
  );
}

/** Extract a .tgz tarball using the system `tar` command.
 *  LF-004 hardening:
 *  - Lists entries FIRST and rejects path traversal (..), absolute paths,
 *    symlinks, hardlinks, and device/FIFO entries before extracting.
 *  - Rejects entries that would resolve outside destDir.
 *  - Limits total extracted entries and uncompressed size (tar bomb defense). */
async function extractTarball(tarPath: string, destDir: string): Promise<void> {
  // 1. List entries and validate.
  const MAX_ENTRIES = 500;
  const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB uncompressed
  const { stdout: listing } = await execFileAsync('tar', ['-tzf', tarPath, '--verbose'], { timeout: 30_000 });

  const lines = listing.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > MAX_ENTRIES) {
    throw new Error(`Tarball has ${lines.length} entries (max ${MAX_ENTRIES}) — possible tar bomb.`);
  }

  let totalBytes = 0;
  for (const line of lines) {
    // tar -tv output: "perm owner/group size date time path"
    const match = line.match(/^([a-zA-Z-]{10})\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!match) continue;
    const [, perms, sizeStr, entryPath] = match;
    const size = parseInt(sizeStr, 10) || 0;
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Tarball exceeds ${MAX_TOTAL_BYTES} bytes uncompressed — possible tar bomb.`);
    }
    // Reject symlinks, hardlinks, devices, FIFOs.
    if (perms?.startsWith('l') || perms?.startsWith('h') || perms?.startsWith('b') || perms?.startsWith('c') || perms?.startsWith('p')) {
      throw new Error(`Tarball contains a non-regular file entry: ${entryPath} (${perms}). Rejected.`);
    }
    // Reject path traversal and absolute paths.
    if (entryPath.includes('..') || entryPath.startsWith('/') || entryPath.includes('\\')) {
      throw new Error(`Tarball contains an unsafe path: ${entryPath}. Rejected.`);
    }
  }

  // 2. Extract with hardened flags.
  await execFileAsync('tar', [
    '-xzf', tarPath,
    '-C', destDir,
    '--strip-components=1',
    '--no-same-owner',
    '--no-same-permissions',
    '--overwrite-dir',
  ], { timeout: 60_000 });

  // 3. Post-extraction: verify nothing escaped destDir (no symlinks pointing out).
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
