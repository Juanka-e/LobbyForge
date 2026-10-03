/**
 * Exact-version bundle resolution in the worker (bundle.ts): the install
 * root setting, the digest (pinned to the same vector as the web app's
 * plugin-install-layout.ts) and the refusal rules.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PLUGIN_INSTALL_DIR,
  computeBundleDigest,
  pluginInstallDir,
  resolveBundle,
  type VerifiedBundles,
} from '../bundle.js';

// Same tree + digest as apps/web/lib/__tests__/plugin-install-layout.test.ts.
const VECTOR_FILES: Record<string, string> = {
  'index.js': 'export const plugin = {};\n',
  'lib/util.js': 'export const x = 1;\n',
  'lib/nested/b.txt': 'b',
  README: 'r',
};
const VECTOR_DIGEST = '98ce038a32639a6af6767dce9c54e5878137110e7a6c2f89d55aedc99c6c579b';

let root: string;

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}

beforeEach(() => {
  root = resolve(__dirname, '..', '..', '.plugin-fixtures', 'bundle');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pluginInstallDir', () => {
  it('defaults to the path compose mounts', () => {
    expect(pluginInstallDir({})).toBe(resolve(DEFAULT_PLUGIN_INSTALL_DIR));
    expect(DEFAULT_PLUGIN_INSTALL_DIR).toBe('/app/plugins/installed');
  });

  it('LOBBYFORGE_PLUGIN_INSTALL_DIR wins; PLUGINS_DIR is the old name and still works', () => {
    expect(pluginInstallDir({ LOBBYFORGE_PLUGIN_INSTALL_DIR: '/srv/a', PLUGINS_DIR: '/srv/b' })).toBe(resolve('/srv/a'));
    expect(pluginInstallDir({ PLUGINS_DIR: '/srv/b' })).toBe(resolve('/srv/b'));
    expect(pluginInstallDir({ LOBBYFORGE_PLUGIN_INSTALL_DIR: '  ' })).toBe(resolve(DEFAULT_PLUGIN_INSTALL_DIR));
  });
});

describe('computeBundleDigest', () => {
  it('matches the vector shared with the web installer', () => {
    writeTree(root, VECTOR_FILES);
    expect(computeBundleDigest(root)).toBe(VECTOR_DIGEST);
  });

  it('changes when any file changes', () => {
    writeTree(root, { ...VECTOR_FILES, 'lib/nested/b.txt': 'B' });
    expect(computeBundleDigest(root)).not.toBe(VECTOR_DIGEST);
  });
});

describe('resolveBundle', () => {
  const install = (version: string, body: string): string => {
    const dir = join(root, 'game', version);
    writeTree(dir, { 'index.js': body });
    return computeBundleDigest(dir);
  };

  it('resolves the exact folder and caches the verification', () => {
    const digest = install('1.0.0', 'export const plugin = 1;');
    const verified: VerifiedBundles = new Map();
    const first = resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified);
    expect(first).toEqual({ ok: true, indexPath: join(root, 'game', '1.0.0', 'index.js') });
    expect(verified.size).toBe(1);
  });

  it('re-verifies a folder that was replaced after verification', () => {
    const digest = install('1.0.0', 'export const plugin = 1;');
    const verified: VerifiedBundles = new Map();
    expect(resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified).ok).toBe(true);
    // The installer moves a NEW folder into place (staging → version).
    const staging = join(root, 'game', '.staging');
    writeTree(staging, { 'index.js': 'export const plugin = 2;' });
    rmSync(join(root, 'game', '1.0.0'), { recursive: true, force: true });
    renameSync(staging, join(root, 'game', '1.0.0'));
    const again = resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified);
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses malformed refs before touching the disk', () => {
    const verified: VerifiedBundles = new Map();
    const digest = 'a'.repeat(64);
    expect(resolveBundle(root, { pluginId: '..', version: '1.0.0', digest }, verified)).toMatchObject({ status: 400 });
    expect(resolveBundle(root, { pluginId: 'game', version: '1.0', digest }, verified)).toMatchObject({ status: 400 });
    expect(resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest: 'xyz' }, verified)).toMatchObject({ status: 400 });
    expect(resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified)).toMatchObject({ status: 404 });
  });
});
