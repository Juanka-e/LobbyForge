/**
 * The marketplace install layout (plugin-install-layout.ts): one install
 * root shared with the plugin-worker, an `active.json` record of the
 * active version + digest, activation that keeps the previous version
 * until the worker has loaded the new one, and pruning afterwards.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_POINTER_FILE,
  DEFAULT_PLUGIN_INSTALL_DIR,
  activateStagedBundle,
  computeBundleDigest,
  listActivePlugins,
  pluginInstallDir,
  pruneSupersededVersions,
  readActivePointer,
  writeActivePointer,
} from '../plugin-install-layout';

// Same tree + digest as apps/plugin-worker/src/__tests__/bundle.test.ts:
// the worker recomputes this digest, so both implementations must agree.
const VECTOR_FILES: Record<string, string> = {
  'index.js': 'export const plugin = {};\n',
  'lib/util.js': 'export const x = 1;\n',
  'lib/nested/b.txt': 'b',
  README: 'r',
};
const VECTOR_DIGEST = '98ce038a32639a6af6767dce9c54e5878137110e7a6c2f89d55aedc99c6c579b';

let root: string;
let stagingCounter = 0;

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

/** An extracted bundle waiting in the plugin's staging folder. */
function stage(pluginId: string, files: Record<string, string>): string {
  stagingCounter += 1;
  const dir = join(root, pluginId, `.staging-test-${stagingCounter}`);
  writeTree(dir, files);
  return dir;
}

const describeOk = (name = 'Game') =>
  vi.fn(async (ref: { pluginId: string; version: string; digest: string }) => ({ id: ref.pluginId, name, ...ref }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-plugin-layout-'));
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pluginInstallDir — one root for installer, loader and worker', () => {
  it('defaults to the path inside the compose volume, not process.cwd()', () => {
    expect(DEFAULT_PLUGIN_INSTALL_DIR).toBe('/app/plugins/installed');
    expect(pluginInstallDir({})).toBe(resolve('/app/plugins/installed'));
    expect(pluginInstallDir({})).not.toBe(resolve(process.cwd(), 'plugins', 'installed'));
  });

  it('LOBBYFORGE_PLUGIN_INSTALL_DIR overrides it; blank falls back to the default', () => {
    expect(pluginInstallDir({ LOBBYFORGE_PLUGIN_INSTALL_DIR: '/srv/lf/plugins' })).toBe(resolve('/srv/lf/plugins'));
    expect(pluginInstallDir({ LOBBYFORGE_PLUGIN_INSTALL_DIR: '   ' })).toBe(resolve(DEFAULT_PLUGIN_INSTALL_DIR));
  });
});

describe('computeBundleDigest', () => {
  it('matches the vector the plugin-worker pins', () => {
    writeTree(root, VECTOR_FILES);
    expect(computeBundleDigest(root)).toBe(VECTOR_DIGEST);
  });
});

describe('active record', () => {
  it('round-trips and lists only plugins with a valid record', () => {
    writeTree(join(root, 'alpha', '1.0.0'), { 'index.js': 'a' });
    writeActivePointer(root, { pluginId: 'alpha', version: '1.0.0', digest: 'a'.repeat(64) });
    // A folder without a record (e.g. a failed first install) is ignored.
    mkdirSync(join(root, 'beta', '2.0.0'), { recursive: true });
    // A malformed record is ignored.
    mkdirSync(join(root, 'gamma'), { recursive: true });
    writeFileSync(join(root, 'gamma', ACTIVE_POINTER_FILE), '{"version":"latest","digest":"x"}');
    expect(readActivePointer(root, 'alpha')).toEqual({ pluginId: 'alpha', version: '1.0.0', digest: 'a'.repeat(64) });
    expect(readActivePointer(root, 'gamma')).toBeNull();
    expect(listActivePlugins(root).map((p) => p.pluginId)).toEqual(['alpha']);
    // The temp file used for the atomic write is gone.
    expect(readdirSync(join(root, 'alpha')).sort()).toEqual(['1.0.0', ACTIVE_POINTER_FILE]);
  });

  it('a missing root lists nothing', () => {
    expect(listActivePlugins(join(root, 'nope'))).toEqual([]);
  });
});

describe('activateStagedBundle', () => {
  it('fresh install: moves the bundle into <version>/, describes that exact version, records it', async () => {
    const describe = describeOk();
    const result = await activateStagedBundle({
      root,
      pluginId: 'game',
      version: '1.0.0',
      stagingDir: stage('game', VECTOR_FILES),
      describe,
    });
    expect(result).toMatchObject({ ok: true, path: join(root, 'game', '1.0.0'), digest: VECTOR_DIGEST });
    expect(describe).toHaveBeenCalledWith({ pluginId: 'game', version: '1.0.0', digest: VECTOR_DIGEST });
    expect(readActivePointer(root, 'game')).toEqual({ pluginId: 'game', version: '1.0.0', digest: VECTOR_DIGEST });
  });

  it('upgrade 1.9.0 → 1.10.0: the old version stays active until the new one is recorded, then is pruned', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.9.0', stagingDir: stage('game', { 'index.js': 'v1.9' }), describe: describeOk(),
    });
    const describe = vi.fn(async (ref: { pluginId: string; version: string; digest: string }) => {
      // While the worker loads the candidate, 1.9.0 is still the record and on disk.
      expect(readActivePointer(root, 'game')?.version).toBe('1.9.0');
      expect(existsSync(join(root, 'game', '1.9.0', 'index.js'))).toBe(true);
      return { id: ref.pluginId, name: 'Game' };
    });
    const result = await activateStagedBundle({
      root, pluginId: 'game', version: '1.10.0', stagingDir: stage('game', { 'index.js': 'v1.10' }), describe,
    });
    expect(result.ok).toBe(true);
    expect(readActivePointer(root, 'game')?.version).toBe('1.10.0');
    expect(pruneSupersededVersions(root, 'game', '1.10.0')).toEqual(['1.9.0']);
    expect(readdirSync(join(root, 'game')).sort()).toEqual(['1.10.0', ACTIVE_POINTER_FILE]);
    expect(readFileSync(join(root, 'game', '1.10.0', 'index.js'), 'utf8')).toBe('v1.10');
  });

  it('a worker refusal rolls back: the previous version stays recorded and on disk', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', { 'index.js': 'good' }), describe: describeOk(),
    });
    const result = await activateStagedBundle({
      root,
      pluginId: 'game',
      version: '2.0.0',
      stagingDir: stage('game', { 'index.js': 'broken' }),
      describe: vi.fn(async () => {
        throw new Error('plugin bundle does not export a valid plugin');
      }),
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('does not export a valid plugin');
    expect(readActivePointer(root, 'game')?.version).toBe('1.0.0');
    expect(existsSync(join(root, 'game', '2.0.0'))).toBe(false);
    expect(readFileSync(join(root, 'game', '1.0.0', 'index.js'), 'utf8')).toBe('good');
  });

  it('refuses a manifest id that is not the catalog id', async () => {
    const result = await activateStagedBundle({
      root,
      pluginId: 'game',
      version: '1.0.0',
      stagingDir: stage('game', { 'index.js': 'x' }),
      describe: vi.fn(async () => ({ id: 'someone-else', name: 'X' })),
    });
    expect(result).toMatchObject({ ok: false });
    expect(readActivePointer(root, 'game')).toBeNull();
    expect(existsSync(join(root, 'game', '1.0.0'))).toBe(false);
  });

  it('refuses a bundle whose index.js is not at its root (the worker could never load it)', async () => {
    const stagingDir = stage('game', { 'dist/index.js': 'nested' });
    const describe = describeOk();
    const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe });
    expect(result).toMatchObject({ ok: false });
    expect(describe).not.toHaveBeenCalled();
    expect(existsSync(stagingDir)).toBe(false);
  });

  it('reinstalling the active version with the same bytes keeps the folder', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', VECTOR_FILES), describe: describeOk(),
    });
    const stagingDir = stage('game', VECTOR_FILES);
    const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe: describeOk() });
    expect(result).toMatchObject({ ok: true, digest: VECTOR_DIGEST });
    expect(existsSync(stagingDir)).toBe(false);
    expect(computeBundleDigest(join(root, 'game', '1.0.0'))).toBe(VECTOR_DIGEST);
  });

  it('reinstalling the active version with different bytes restores the old folder on refusal', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', { 'index.js': 'old' }), describe: describeOk(),
    });
    const before = readActivePointer(root, 'game');
    const result = await activateStagedBundle({
      root,
      pluginId: 'game',
      version: '1.0.0',
      stagingDir: stage('game', { 'index.js': 'new' }),
      describe: vi.fn(async () => {
        throw new Error('worker down');
      }),
    });
    expect(result.ok).toBe(false);
    expect(readActivePointer(root, 'game')).toEqual(before);
    expect(readFileSync(join(root, 'game', '1.0.0', 'index.js'), 'utf8')).toBe('old');
    expect(computeBundleDigest(join(root, 'game', '1.0.0'))).toBe(before?.digest);
  });
});

describe('pruneSupersededVersions', () => {
  it('never deletes anything unless the version to keep is the recorded one', () => {
    writeTree(join(root, 'game', '1.0.0'), { 'index.js': 'a' });
    writeTree(join(root, 'game', '2.0.0'), { 'index.js': 'b' });
    writeActivePointer(root, { pluginId: 'game', version: '1.0.0', digest: 'a'.repeat(64) });
    expect(pruneSupersededVersions(root, 'game', '2.0.0')).toEqual([]);
    expect(readdirSync(join(root, 'game')).sort()).toEqual(['1.0.0', '2.0.0', ACTIVE_POINTER_FILE]);
  });
});
