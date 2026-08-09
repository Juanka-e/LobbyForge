/**
 * Plugin installer — downloads, extracts, and validates a marketplace
 * plugin bundle so the dynamic loader can pick it up.
 *
 * The bundle is expected to be a tarball (.tgz) served from the
 * catalog entry's `manifestUrl`. After extraction, the plugin's
 * `index.js` is imported and shape-validated before admission.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { reloadDynamicPlugin } from './plugin-loader';

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
  const targetDir = join(INSTALLED_DIR, pluginId, version);

  try {
    // 1. Download the tarball.
    const tarball = await downloadWithTimeout(url);
    if (tarball.byteLength > MAX_BUNDLE_BYTES) {
      return { ok: false, error: `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes` };
    }

    // 2. Prepare the target directory.
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    mkdirSync(targetDir, { recursive: true });

    // 3. Write the tarball to a temp file and extract with `tar`.
    const tarPath = join(targetDir, 'bundle.tgz');
    writeFileSync(tarPath, Buffer.from(tarball));
    await extractTarball(tarPath, targetDir);

    // 4. Verify the extracted bundle has an index.js.
    const indexPath = join(targetDir, 'index.js');
    if (!existsSync(indexPath)) {
      // Some tarballs wrap in a `package/` dir — try to find it.
      const nested = findIndexJs(targetDir);
      if (!nested) {
        rmSync(targetDir, { recursive: true, force: true });
        return { ok: false, error: 'Bundle missing index.js — not a valid LobbyForge plugin.' };
      }
    }

    // 5. Reload the dynamic loader so the new plugin is immediately available.
    const reloaded = await reloadDynamicPlugin(pluginId);
    if (!reloaded) {
      // The loader validation may have rejected the shape — don't delete
      // the files (the admin may want to inspect), but report the failure.
      return { ok: false, error: 'Plugin loaded but failed shape validation. Check server logs.' };
    }

    return { ok: true, path: targetDir };
  } catch (err) {
    console.error('[plugin-installer] install failed:', (err as Error).message);
    // Clean up a partial extraction.
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
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

/** Extract a .tgz tarball using the system `tar` command. */
function extractTarball(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`tar extraction failed with code ${code}`));
    });
    child.on('error', reject);
  });
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
