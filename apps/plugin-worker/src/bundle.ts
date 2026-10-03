/**
 * Bundle resolution for the isolated worker.
 *
 * The web app is the only writer of the install directory. It records which
 * version of each plugin is active (`<root>/<pluginId>/active.json`) and
 * passes that exact version and the digest of its files in every RPC. The
 * worker never picks a version: it resolves `<root>/<pluginId>/<version>/
 * index.js`, recomputes the digest of that folder and refuses anything that
 * does not match. (It used to take the alphabetically last folder, so 1.9.0
 * won over 1.10.0, and old versions were never removed.)
 *
 * `computeBundleDigest` must stay byte-for-byte identical to the copy in
 * apps/web/lib/plugin-install-layout.ts: both test suites pin the same vector.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** The path compose mounts (`plugins-data` volume at /app/plugins). */
export const DEFAULT_PLUGIN_INSTALL_DIR = '/app/plugins/installed';
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$/i;
export const DIGEST_RE = /^[0-9a-f]{64}$/;

const MAX_DIGEST_FILES = 1000;
const MAX_DIGEST_BYTES = 64 * 1024 * 1024;

/**
 * The ONE install root shared with the web app. `PLUGINS_DIR` is the old
 * name of this setting and is still honoured.
 */
export function pluginInstallDir(
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.LOBBYFORGE_PLUGIN_INSTALL_DIR?.trim() || env.PLUGINS_DIR?.trim();
  return resolve(configured || DEFAULT_PLUGIN_INSTALL_DIR);
}

/**
 * SHA-256 over the sorted list of `relativePath \0 sha256(content) \n` for
 * every regular file under `dir` (POSIX separators). Symlinks and other
 * non-regular entries throw.
 */
export function computeBundleDigest(dir: string): string {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(rel ? join(dir, ...rel.split('/')) : dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) files.push(childRel);
      else throw new Error(`bundle contains a non-regular entry: ${childRel}`);
      if (files.length > MAX_DIGEST_FILES) throw new Error('bundle has too many files');
    }
  };
  walk('');
  files.sort();
  const tree = createHash('sha256');
  let total = 0;
  for (const rel of files) {
    const content = readFileSync(join(dir, ...rel.split('/')));
    total += content.length;
    if (total > MAX_DIGEST_BYTES) throw new Error('bundle is too large');
    tree.update(`${rel}\0${createHash('sha256').update(content).digest('hex')}\n`);
  }
  return tree.digest('hex');
}

export interface BundleRef {
  pluginId: string;
  version: string;
  digest: string;
}

export type BundleResolution =
  | { ok: true; indexPath: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Verified folders: key `<id>@<version>#<digest>` → the folder's identity
 * (inode + mtime) when it was verified. The installer always moves a NEW
 * folder into place, so a replaced folder has a new identity and is
 * verified again.
 */
export type VerifiedBundles = Map<string, string>;

/** Read the exact bundle reference from an RPC message (strings only). */
export function readBundleRef(msg: Record<string, unknown>): BundleRef {
  return {
    pluginId: typeof msg.pluginId === 'string' ? msg.pluginId : '',
    version: typeof msg.version === 'string' ? msg.version : '',
    digest: typeof msg.digest === 'string' ? msg.digest : '',
  };
}

export function resolveBundle(rootDir: string, ref: BundleRef, verified: VerifiedBundles): BundleResolution {
  if (!PLUGIN_ID_RE.test(ref.pluginId)) return { ok: false, status: 400, error: 'Invalid plugin id' };
  if (!VERSION_RE.test(ref.version)) {
    return { ok: false, status: 400, error: `Plugin "${ref.pluginId}": an exact semver version is required` };
  }
  if (!DIGEST_RE.test(ref.digest)) {
    return { ok: false, status: 400, error: `Plugin "${ref.pluginId}": a bundle digest is required` };
  }
  const root = resolve(rootDir);
  const dir = resolve(root, ref.pluginId, ref.version);
  if (!dir.startsWith(root + sep)) return { ok: false, status: 400, error: 'Invalid plugin path' };

  const notInstalled = {
    ok: false as const,
    status: 404 as const,
    error: `Plugin "${ref.pluginId}" version ${ref.version} is not installed`,
  };
  let identity: string;
  try {
    const dirStat = statSync(dir);
    if (!dirStat.isDirectory() || !statSync(join(dir, 'index.js')).isFile()) return notInstalled;
    identity = `${dirStat.ino}:${dirStat.mtimeMs}`;
  } catch {
    return notInstalled;
  }

  const key = `${ref.pluginId}@${ref.version}#${ref.digest}`;
  if (verified.get(key) !== identity) {
    let actual: string;
    try {
      actual = computeBundleDigest(dir);
    } catch (err) {
      return { ok: false, status: 409, error: `Plugin "${ref.pluginId}": ${(err as Error).message}` };
    }
    if (actual !== ref.digest) {
      verified.delete(key);
      return {
        ok: false,
        status: 409,
        error: `Plugin "${ref.pluginId}" version ${ref.version}: bundle digest mismatch — refusing to run files the host did not install`,
      };
    }
    verified.set(key, identity);
  }
  return { ok: true, indexPath: join(dir, 'index.js') };
}
