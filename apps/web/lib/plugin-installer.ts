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
 *  Validates the URL is HTTPS and not pointing at a private/loopback IP (SSRF protection). */
async function downloadWithTimeout(url: string): Promise<ArrayBuffer> {
  // SSRF protection: only allow HTTPS, block private/loopback IPs.
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
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('172.16.') ||
    host.startsWith('172.17.') ||
    host.startsWith('172.18.') ||
    host.startsWith('172.19.') ||
    host.startsWith('172.2') ||
    host.startsWith('172.3') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Manifest URL must not point to a private or loopback address');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error', // No redirects — prevents DNS-rebinding bypass
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
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
