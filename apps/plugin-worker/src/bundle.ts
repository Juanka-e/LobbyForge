/**
 * Bundle resolution for the isolated worker.
 *
 * The web app is the only writer of the install directory. It records which
 * version of each plugin is active (`<root>/<pluginId>/active.json`) and
 * passes that exact version and the digest of its files in every RPC. The
 * worker never picks a version: it resolves `<root>/<pluginId>/<version>/`,
 * recomputes the digest of that folder and refuses anything that does not
 * match. (It used to take the alphabetically last folder, so 1.9.0 won over
 * 1.10.0, and old versions were never removed.)
 *
 * A bundle is `sdk: "sandbox-v1"` (ADR-007): `manifest.json` + `server.js`
 * at the root, optional `ui/`. Once a folder is verified, its manifest and
 * server.js are kept in memory with the folder's identity, so every call
 * runs exactly the bytes that were digested. A legacy Node bundle
 * (`index.js`) is refused.
 *
 * `computeBundleDigest` must stay byte-for-byte identical to the copy in
 * apps/web/lib/plugin-install-layout.ts: both test suites pin the same vector.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseSandboxManifest, type SandboxManifest } from './manifest.js';

/** The path compose mounts (`plugins-data` volume at /app/plugins). */
export const DEFAULT_PLUGIN_INSTALL_DIR = '/app/plugins/installed';
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$/i;
export const DIGEST_RE = /^[0-9a-f]{64}$/;

/** server.js is loaded into a 32 MB VM; a source this large is a mistake or an attack. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_DIGEST_FILES = 1000;
const MAX_DIGEST_BYTES = 64 * 1024 * 1024;
/** Verified bundles kept in memory (one per installed version; superseded ones age out). */
const MAX_VERIFIED_BUNDLES = 64;

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
export function computeBundleDigest(dir: string, capture?: Map<string, Buffer>): string {
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
    // The caller runs exactly these bytes (no second read between hashing
    // and use — see loadVerifiedBundle).
    capture?.set(rel, content);
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

/** A verified bundle: the bytes the worker runs. */
export interface LoadedBundle {
  dir: string;
  manifest: SandboxManifest;
  source: string;
}

export type BundleResolution =
  | ({ ok: true } & LoadedBundle)
  | { ok: false; status: 400 | 404 | 409 | 422; error: string };

/**
 * Verified folders: key `<id>@<version>#<digest>` → the folder's identity
 * (inode + mtime) when it was verified, plus its manifest and server.js.
 * The installer always moves a NEW folder into place, so a replaced folder
 * has a new identity and is verified (and read) again.
 */
export type VerifiedBundles = Map<string, { identity: string; bundle: LoadedBundle }>;

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
    if (!dirStat.isDirectory()) return notInstalled;
    identity = `${dirStat.ino}:${dirStat.mtimeMs}`;
  } catch {
    return notInstalled;
  }
  const isFile = (name: string): boolean => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  };
  if (!isFile('server.js') || !isFile('manifest.json')) {
    if (existsSync(join(dir, 'index.js'))) {
      return {
        ok: false,
        status: 422,
        error: `Plugin "${ref.pluginId}" version ${ref.version} is a legacy Node bundle (index.js): it no longer loads. Install a sandbox-v1 bundle (manifest.json + server.js).`,
      };
    }
    return notInstalled;
  }

  const key = `${ref.pluginId}@${ref.version}#${ref.digest}`;
  const cached = verified.get(key);
  if (cached && cached.identity === identity) {
    // Most recently used goes last: the map's order is the eviction order.
    verified.delete(key);
    verified.set(key, cached);
    return { ok: true, ...cached.bundle };
  }

  let actual: string;
  const read = new Map<string, Buffer>();
  try {
    actual = computeBundleDigest(dir, read);
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

  // The very bytes that were hashed above: re-reading the files here would
  // leave a window in which a swapped server.js runs under a verified digest.
  const sourceBytes = read.get('server.js');
  const manifestBytes = read.get('manifest.json');
  if (!sourceBytes || !manifestBytes) return notInstalled;
  if (sourceBytes.length > MAX_SOURCE_BYTES) {
    return { ok: false, status: 422, error: `Plugin "${ref.pluginId}": server.js is larger than ${MAX_SOURCE_BYTES} bytes` };
  }
  const parsed = parseSandboxManifest(manifestBytes);
  if (!parsed.ok) return { ok: false, status: 422, error: `Plugin "${ref.pluginId}": ${parsed.error}` };
  if (parsed.manifest.id !== ref.pluginId) {
    return {
      ok: false,
      status: 422,
      error: `Bundle manifest id "${parsed.manifest.id}" does not match plugin id "${ref.pluginId}"`,
    };
  }
  if (parsed.manifest.version !== ref.version) {
    return {
      ok: false,
      status: 422,
      error: `Plugin "${ref.pluginId}": manifest version ${parsed.manifest.version} does not match the installed version ${ref.version}`,
    };
  }

  const bundle: LoadedBundle = { dir, manifest: parsed.manifest, source: sourceBytes.toString('utf8') };
  verified.set(key, { identity, bundle });
  while (verified.size > MAX_VERIFIED_BUNDLES) {
    const oldest = verified.keys().next().value;
    if (oldest === undefined) break;
    verified.delete(oldest);
  }
  return { ok: true, ...bundle };
}
