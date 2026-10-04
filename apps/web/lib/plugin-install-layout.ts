/**
 * On-disk layout of marketplace (dynamic) plugin installs.
 *
 *   <root>/<pluginId>/<version>/           one folder per installed version:
 *        manifest.json, server.js, ui/…     a sdk "sandbox-v1" bundle (ADR-007)
 *   <root>/<pluginId>/active.json          { version, digest } of the ACTIVE one
 *
 * `<root>` is LOBBYFORGE_PLUGIN_INSTALL_DIR, default `/app/plugins/installed`:
 * inside the `plugins-data` volume that compose mounts read-write on web and
 * read-only on the plugin-worker (infra/docker/docker-compose.prod.yml). It
 * used to be resolved from process.cwd(), which is /app/apps/web in the
 * image, so the installer wrote where the worker never looked.
 *
 * The installer (web) is the only writer. It records the active version and
 * a digest of its files in active.json; the loader reads that record and
 * passes the exact version + digest in every plugin-worker request. The
 * worker recomputes the digest and refuses anything else. Nothing ever picks
 * "the latest folder on disk".
 *
 * Why a file and not a DB row: the record lives on the same volume as the
 * bytes it describes, so a database restore without the volume (or the
 * reverse) cannot leave it pointing at files that are not there.
 *
 * `computeBundleDigest` must stay byte-for-byte identical to the copy in
 * apps/plugin-worker/src/bundle.ts: both test suites pin the same vector.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseSandboxManifest, type SandboxManifest } from './sandbox-manifest';

export const DEFAULT_PLUGIN_INSTALL_DIR = '/app/plugins/installed';
export const ACTIVE_POINTER_FILE = 'active.json';

/** Same shape the install API accepts (`marketplace/install` InstallSchema). */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
/** Strict semver; the version is a path segment. */
export const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?$/i;
/** Lowercase hex SHA-256. */
export const DIGEST_RE = /^[0-9a-f]{64}$/;

const MAX_DIGEST_FILES = 1000;
const MAX_DIGEST_BYTES = 64 * 1024 * 1024;
/** Same cap as the plugin worker (apps/plugin-worker/src/bundle.ts MAX_SOURCE_BYTES). */
export const MAX_SERVER_JS_BYTES = 2 * 1024 * 1024;

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * ADR-007: is `dir` an installable sdk "sandbox-v1" bundle for exactly
 * this plugin id and catalog version? `manifest.json` and `server.js` at
 * the root, a valid manifest (the action policies the host will enforce),
 * a server.js under the worker's cap, and `ui/index.html` when the
 * manifest says `ui: true`. A legacy Node bundle (`index.js`) is refused
 * with the migration hint.
 */
export function checkSandboxBundle(
  dir: string,
  pluginId: string,
  version: string
): { ok: true; manifest: SandboxManifest } | { ok: false; error: string } {
  const hasManifest = isRegularFile(join(dir, 'manifest.json'));
  const hasServer = isRegularFile(join(dir, 'server.js'));
  if (!hasManifest || !hasServer) {
    if (existsSync(join(dir, 'index.js'))) {
      return {
        ok: false,
        error:
          'This is a legacy Node bundle (index.js). Marketplace plugins now run sandboxed: rebuild it as sdk "sandbox-v1" (manifest.json + server.js, see docs/PLUGIN_PUBLISHING.md).',
      };
    }
    return {
      ok: false,
      error: `Bundle missing ${hasManifest ? 'server.js' : 'manifest.json'} at its root — not a sandbox-v1 LobbyForge plugin.`,
    };
  }
  const parsed = parseSandboxManifest(readFileSync(join(dir, 'manifest.json')));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.manifest.id !== pluginId) {
    return { ok: false, error: `Bundle manifest id "${parsed.manifest.id}" does not match the catalog id "${pluginId}".` };
  }
  if (parsed.manifest.version !== version) {
    return {
      ok: false,
      error: `Bundle manifest version ${parsed.manifest.version} does not match the catalog version ${version}.`,
    };
  }
  if (statSync(join(dir, 'server.js')).size > MAX_SERVER_JS_BYTES) {
    return { ok: false, error: `server.js is larger than ${MAX_SERVER_JS_BYTES} bytes.` };
  }
  if (parsed.manifest.ui && !isRegularFile(join(dir, 'ui', 'index.html'))) {
    return { ok: false, error: 'manifest.json says "ui": true but the bundle has no ui/index.html.' };
  }
  return { ok: true, manifest: parsed.manifest };
}

/**
 * The manifest of an installed version, read from the web app's own copy
 * of the files (the worker only confirms what server.js defines). Throws
 * when the folder is not a valid sandbox-v1 bundle for that id + version.
 */
export function readInstalledSandboxManifest(root: string, pluginId: string, version: string): SandboxManifest {
  if (!PLUGIN_ID_RE.test(pluginId) || !VERSION_RE.test(version)) throw new Error('Invalid plugin id or version');
  const dir = resolve(root, pluginId, version);
  if (!dir.startsWith(resolve(root) + sep)) throw new Error('Invalid plugin path');
  const checked = checkSandboxBundle(dir, pluginId, version);
  if (!checked.ok) throw new Error(checked.error);
  return checked.manifest;
}

/** The ONE install root shared by installer, loader and plugin-worker. */
export function pluginInstallDir(
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.LOBBYFORGE_PLUGIN_INSTALL_DIR?.trim();
  return resolve(configured || DEFAULT_PLUGIN_INSTALL_DIR);
}

export interface ActivePluginVersion {
  pluginId: string;
  version: string;
  digest: string;
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

/** The active record for one plugin, or null when absent or malformed. */
export function readActivePointer(root: string, pluginId: string): ActivePluginVersion | null {
  if (!PLUGIN_ID_RE.test(pluginId)) return null;
  const path = join(root, pluginId, ACTIVE_POINTER_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; digest?: unknown };
    if (typeof parsed.version !== 'string' || !VERSION_RE.test(parsed.version)) return null;
    if (typeof parsed.digest !== 'string' || !DIGEST_RE.test(parsed.digest)) return null;
    return { pluginId, version: parsed.version, digest: parsed.digest };
  } catch {
    return null;
  }
}

/** Atomic (write a temp file, then rename over the old record). */
export function writeActivePointer(root: string, pointer: ActivePluginVersion): void {
  const dir = join(root, pointer.pluginId);
  const tmp = join(dir, `.${ACTIVE_POINTER_FILE}.${process.pid}.${Date.now()}`);
  // `wx`: create exclusively (never follow or overwrite something already
  // at that name); 0600 — only the web process reads it back.
  writeFileSync(
    tmp,
    `${JSON.stringify({ version: pointer.version, digest: pointer.digest, activatedAt: new Date().toISOString() })}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  renameSync(tmp, join(dir, ACTIVE_POINTER_FILE));
}

/** Every plugin under `root` that has a valid active record. */
export function listActivePlugins(root: string): ActivePluginVersion[] {
  if (!existsSync(root)) return [];
  const active: ActivePluginVersion[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PLUGIN_ID_RE.test(entry.name)) continue;
    const pointer = readActivePointer(root, entry.name);
    if (pointer) active.push(pointer);
  }
  return active.sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
}

/**
 * After an activation: delete every other entry in the plugin's folder
 * (superseded versions, staging leftovers). Refuses unless `keepVersion` is
 * the recorded active version, so it can never delete what is running.
 * Callers hold the per-plugin install lock.
 */
export function pruneSupersededVersions(root: string, pluginId: string, keepVersion: string): string[] {
  const pointer = readActivePointer(root, pluginId);
  if (!pointer || pointer.version !== keepVersion) return [];
  const pluginDir = join(root, pluginId);
  const removed: string[] = [];
  for (const name of readdirSync(pluginDir)) {
    if (name === keepVersion || name === ACTIVE_POINTER_FILE) continue;
    rmSync(join(pluginDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export interface DescribedPlugin {
  id: string;
  name: string;
}

export type ActivationResult<T extends DescribedPlugin> =
  | { ok: true; path: string; digest: string; info: T }
  | { ok: false; error: string };

/**
 * Move an extracted bundle into `<root>/<pluginId>/<version>`, have the
 * plugin-worker load that exact version + digest, and only then record it
 * as active. Until the record is written the previous version stays active
 * and on disk; on any failure the folder is restored and the record is
 * left alone. Pruning the superseded version is the caller's next step.
 */
export async function activateStagedBundle<T extends DescribedPlugin>(input: {
  root: string;
  pluginId: string;
  version: string;
  stagingDir: string;
  describe: (ref: ActivePluginVersion) => Promise<T>;
}): Promise<ActivationResult<T>> {
  const { root, pluginId, version, stagingDir } = input;
  const pluginDir = join(root, pluginId);
  const targetDir = join(pluginDir, version);
  if (!resolve(targetDir).startsWith(resolve(root) + sep)) {
    return { ok: false, error: 'Install path escapes the plugin directory. Rejected.' };
  }
  // ADR-007: only sdk "sandbox-v1" bundles (manifest.json + server.js at
  // the root, checked before the worker ever sees them).
  const bundleCheck = checkSandboxBundle(stagingDir, pluginId, version);
  if (!bundleCheck.ok) {
    rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, error: bundleCheck.error };
  }
  const digest = computeBundleDigest(stagingDir);
  const previous = readActivePointer(root, pluginId);

  let createdTarget = false;
  let setAside: string | null = null;
  try {
    mkdirSync(pluginDir, { recursive: true });
    if (existsSync(targetDir)) {
      if (previous?.version === version && previous.digest === digest && safeDigest(targetDir) === digest) {
        // The same bytes are already installed and active: keep them.
        rmSync(stagingDir, { recursive: true, force: true });
      } else if (previous?.version === version) {
        // Reinstall of the active version with different bytes: set the old
        // folder aside so a refusal can put it back.
        setAside = join(pluginDir, `.replaced-${Date.now()}`);
        renameSync(targetDir, setAside);
        renameSync(stagingDir, targetDir);
        createdTarget = true;
      } else {
        // A leftover of a version that is not active.
        rmSync(targetDir, { recursive: true, force: true });
        renameSync(stagingDir, targetDir);
        createdTarget = true;
      }
    } else {
      renameSync(stagingDir, targetDir);
      createdTarget = true;
    }
  } catch (err) {
    // Never leave the active version set aside.
    if (setAside && !existsSync(targetDir)) renameSync(setAside, targetDir);
    rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, error: `Could not move the bundle into place: ${(err as Error).message}` };
  }

  const rollback = (): void => {
    if (createdTarget) rmSync(targetDir, { recursive: true, force: true });
    if (setAside) renameSync(setAside, targetDir);
  };

  let info: T;
  try {
    info = await input.describe({ pluginId, version, digest });
  } catch (err) {
    rollback();
    return { ok: false, error: `The plugin-worker could not load the bundle: ${(err as Error).message}` };
  }
  if (info.id !== pluginId) {
    rollback();
    return { ok: false, error: `Bundle manifest id "${info.id}" does not match the catalog id "${pluginId}".` };
  }
  try {
    writeActivePointer(root, { pluginId, version, digest });
  } catch (err) {
    rollback();
    return { ok: false, error: `Could not record the active version: ${(err as Error).message}` };
  }
  return { ok: true, path: targetDir, digest, info };
}

function safeDigest(dir: string): string | null {
  try {
    return statSync(dir).isDirectory() ? computeBundleDigest(dir) : null;
  } catch {
    return null;
  }
}
