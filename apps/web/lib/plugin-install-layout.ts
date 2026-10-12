/**
 * On-disk layout of marketplace (dynamic) plugin installs.
 *
 *   <root>/<pluginId>/<version>/           one folder per installed version:
 *        manifest.json, server.js, ui/…     a sdk "sandbox-v1" bundle (ADR-007),
 *        locales/<code>.json                with its optional translation tables
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
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  MAX_LOCALE_FILE_BYTES,
  MAX_LOCALE_FILES,
  parseSandboxBundle,
  type SandboxLocaleFile,
  type SandboxLocaleTable,
  type SandboxManifest,
} from './sandbox-manifest';
import {
  newApprovals,
  parseApprovals,
  requestedApprovals,
  sameApprovals,
  sandboxManifestOptions,
  type PluginApprovals,
} from './plugin-approvals';
import { configuredAppOrigins, externalUiOrigin } from './plugin-frame-target';

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
 * Read a file through ONE descriptor and at most `cap + 1` bytes, so what
 * is checked is what is read: no size-then-read window, and a file that
 * grows past the cap while being read is refused (null). Links are not
 * followed where the platform can refuse them (O_NOFOLLOW).
 */
function readFileCapped(path: string, cap: number): Buffer | null {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(cap + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
    }
    return total > cap ? null : buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/** A path from the bundle as it may appear in an error message: short, printable ASCII. */
function printablePath(path: string): string {
  return path.slice(0, 64).replace(/[^\x20-\x7e]/g, '?');
}

/**
 * The files of a bundle's optional `locales/` folder, for the validator
 * (parseSandboxBundle): every regular file below it, with its path relative
 * to `locales/`. The validator decides what is allowed (only
 * `<code>.json` directly in the folder); this walk refuses what it must
 * never read — links and other non-regular entries, more files than the
 * cap, a file over the per-file cap — before reading anything big.
 */
function readLocaleFiles(dir: string): { ok: true; files: SandboxLocaleFile[] } | { ok: false; error: string } {
  const localesDir = join(dir, 'locales');
  let top: ReturnType<typeof lstatSync>;
  try {
    top = lstatSync(localesDir);
  } catch {
    return { ok: true, files: [] };
  }
  if (!top.isDirectory()) return { ok: false, error: 'locales must be a folder of <language code>.json files.' };
  const files: SandboxLocaleFile[] = [];
  const walk = (rel: string): string | null => {
    for (const entry of readdirSync(rel ? join(localesDir, ...rel.split('/')) : localesDir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const error = walk(childRel);
        if (error) return error;
        continue;
      }
      if (!entry.isFile()) return `locales/${printablePath(childRel)}: not a regular file.`;
      if (files.length >= MAX_LOCALE_FILES) return `locales/: more than ${MAX_LOCALE_FILES} files`;
      const content = readFileCapped(join(localesDir, ...childRel.split('/')), MAX_LOCALE_FILE_BYTES);
      if (!content) return `locales/${printablePath(childRel)}: larger than ${MAX_LOCALE_FILE_BYTES} bytes`;
      files.push([childRel, content]);
    }
    return null;
  };
  const error = walk('');
  return error ? { ok: false, error } : { ok: true, files };
}

/** A valid installed (or staged) bundle: its manifest and its translation tables. */
export interface CheckedSandboxBundle {
  manifest: SandboxManifest;
  /** `locales/<code>.json`, validated; `{}` when the bundle ships none. */
  localeTables: Record<string, SandboxLocaleTable>;
}

/**
 * ADR-007: is `dir` an installable sdk "sandbox-v1" bundle for exactly
 * this plugin id and catalog version? `manifest.json` and `server.js` at
 * the root, a valid manifest (the action policies the host will enforce),
 * valid `locales/<code>.json` tables when it ships any, a server.js under
 * the worker's cap, and `ui/index.html` when the manifest says `ui: true`.
 * A legacy Node bundle (`index.js`) is refused with the migration hint.
 */
export function checkSandboxBundle(
  dir: string,
  pluginId: string,
  version: string
): ({ ok: true } & CheckedSandboxBundle) | { ok: false; error: string } {
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
  const locales = readLocaleFiles(dir);
  if (!locales.ok) return locales;
  const parsed = parseSandboxBundle(readFileSync(join(dir, 'manifest.json')), locales.files, sandboxManifestOptions());
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
  return { ok: true, manifest: parsed.manifest, localeTables: parsed.localeTables };
}

/**
 * An installed version — its manifest and translation tables — read from
 * the web app's own copy of the files (the worker only confirms what
 * server.js defines). Throws when the folder is not a valid sandbox-v1
 * bundle for that id + version.
 */
export function readInstalledSandboxBundle(root: string, pluginId: string, version: string): CheckedSandboxBundle {
  if (!PLUGIN_ID_RE.test(pluginId) || !VERSION_RE.test(version)) throw new Error('Invalid plugin id or version');
  const dir = resolve(root, pluginId, version);
  if (!dir.startsWith(resolve(root) + sep)) throw new Error('Invalid plugin path');
  const checked = checkSandboxBundle(dir, pluginId, version);
  if (!checked.ok) throw new Error(checked.error);
  return { manifest: checked.manifest, localeTables: checked.localeTables };
}

/** The manifest of an installed version (see readInstalledSandboxBundle). */
export function readInstalledSandboxManifest(root: string, pluginId: string, version: string): SandboxManifest {
  return readInstalledSandboxBundle(root, pluginId, version).manifest;
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
  /** What the owner approved at install (plugin-approvals.ts); absent when the bundle asked for nothing. */
  approved?: PluginApprovals;
  approvedAt?: string;
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
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: unknown;
      digest?: unknown;
      approved?: unknown;
      approvedAt?: unknown;
    };
    if (typeof parsed.version !== 'string' || !VERSION_RE.test(parsed.version)) return null;
    if (typeof parsed.digest !== 'string' || !DIGEST_RE.test(parsed.digest)) return null;
    const pointer: ActivePluginVersion = { pluginId, version: parsed.version, digest: parsed.digest };
    // A malformed approval approves nothing (the plugin then asks again).
    const approved = parseApprovals(parsed.approved, sandboxManifestOptions());
    if (approved && Object.keys(approved).length > 0) {
      pointer.approved = approved;
      if (typeof parsed.approvedAt === 'string') pointer.approvedAt = parsed.approvedAt;
    }
    return pointer;
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
  const record: Record<string, unknown> = {
    version: pointer.version,
    digest: pointer.digest,
    activatedAt: new Date().toISOString(),
  };
  if (pointer.approved) {
    record.approved = pointer.approved;
    record.approvedAt = pointer.approvedAt ?? new Date().toISOString();
  }
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
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

/**
 * The bundle asks for more than the sandbox and the install did not approve
 * exactly that. `requested` is everything it asks for; `added` the part the
 * active version had not approved (an upgrade asks only about that).
 */
export interface ApprovalRequired {
  requested: PluginApprovals;
  added: PluginApprovals | null;
  previous: PluginApprovals | null;
}

export type ActivationResult<T extends DescribedPlugin> =
  | { ok: true; path: string; digest: string; info: T; approved: PluginApprovals | null }
  | { ok: false; error: string; approvalRequired?: ApprovalRequired };

/**
 * Compare what the staged bundle asks for with what the install approved.
 * The approval must name the request exactly — not more (nothing to grant
 * that the bundle does not use), not less.
 */
export function checkApproval(
  manifest: SandboxManifest,
  approve: PluginApprovals | null | undefined,
  previous: ActivePluginVersion | null
): { ok: true; approved: PluginApprovals | null } | { ok: false; approvalRequired: ApprovalRequired } {
  const requested = requestedApprovals(manifest);
  if (!requested) return { ok: true, approved: null };
  // Read with the manifest's rules, so a hand-written approval compares like the request.
  if (sameApprovals(requested, parseApprovals(approve, sandboxManifestOptions()))) return { ok: true, approved: requested };
  const prior = previous?.approved ?? null;
  return { ok: false, approvalRequired: { requested, added: newApprovals(prior, requested), previous: prior } };
}

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
  /** What the owner approved for this install (the `approve` of the request). */
  approve?: PluginApprovals | null;
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
  // The lobby frames a `ui: { url }` page with allow-same-origin, which is
  // safe only for another site (plugin-frame-target.ts): never one on this
  // instance's own address. Checked again whenever the lobby frames it.
  const uiUrl = bundleCheck.manifest.uiUrl;
  if (uiUrl && !externalUiOrigin(uiUrl, configuredAppOrigins())) {
    rmSync(stagingDir, { recursive: true, force: true });
    return {
      ok: false,
      error: 'manifest.json: "ui.url" is on this instance\'s own address (its host or a subdomain of it); the lobby only frames a page on another site.',
    };
  }
  const previous = readActivePointer(root, pluginId);
  // Nothing moves before the owner has approved what the bundle asks for.
  const approval = checkApproval(bundleCheck.manifest, input.approve, previous);
  if (!approval.ok) {
    rmSync(stagingDir, { recursive: true, force: true });
    return {
      ok: false,
      error: 'This plugin asks for access beyond the sandbox; the instance owner must approve it.',
      approvalRequired: approval.approvalRequired,
    };
  }
  const digest = computeBundleDigest(stagingDir);

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
    // With what this install approved: the loaded plugin grants exactly that.
    info = await input.describe({ pluginId, version, digest, ...(approval.approved ? { approved: approval.approved } : {}) });
  } catch (err) {
    rollback();
    return { ok: false, error: `The plugin-worker could not load the bundle: ${(err as Error).message}` };
  }
  if (info.id !== pluginId) {
    rollback();
    return { ok: false, error: `Bundle manifest id "${info.id}" does not match the catalog id "${pluginId}".` };
  }
  try {
    const pointer: ActivePluginVersion = { pluginId, version, digest };
    if (approval.approved) pointer.approved = approval.approved;
    writeActivePointer(root, pointer);
  } catch (err) {
    rollback();
    return { ok: false, error: `Could not record the active version: ${(err as Error).message}` };
  }
  return { ok: true, path: targetDir, digest, info, approved: approval.approved };
}

function safeDigest(dir: string): string | null {
  try {
    return statSync(dir).isDirectory() ? computeBundleDigest(dir) : null;
  } catch {
    return null;
  }
}
