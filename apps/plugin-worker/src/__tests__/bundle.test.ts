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
  MAX_SOURCE_BYTES,
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

const MANIFEST = (version: string, id = 'game') =>
  JSON.stringify({ id, name: 'Game', version, sdk: 'sandbox-v1', ui: false, actionPolicies: { go: { role: 'member' } } });

describe('resolveBundle (sandbox-v1)', () => {
  const install = (version: string, files: Record<string, string>): string => {
    const dir = join(root, 'game', version);
    writeTree(dir, files);
    return computeBundleDigest(dir);
  };
  const bundleFiles = (version: string, source = 'globalThis.plugin = {};') => ({
    'manifest.json': MANIFEST(version),
    'server.js': source,
  });

  it('resolves the exact folder, returns the manifest and source, and caches the verification', () => {
    const digest = install('1.0.0', bundleFiles('1.0.0', 'globalThis.plugin = 1;'));
    const verified: VerifiedBundles = new Map();
    const first = resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified);
    expect(first).toMatchObject({ ok: true, dir: join(root, 'game', '1.0.0'), source: 'globalThis.plugin = 1;' });
    if (first.ok) expect(first.manifest.actionPolicies).toEqual({ go: { role: 'member' } });
    expect(verified.size).toBe(1);
    // A cache hit runs the bytes that were digested, even if a file changed in place.
    writeFileSync(join(root, 'game', '1.0.0', 'server.js'), 'globalThis.plugin = 2;');
    const second = resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified);
    expect(second).toMatchObject({ ok: true, source: 'globalThis.plugin = 1;' });
  });

  it('re-verifies a folder that was replaced after verification', () => {
    const digest = install('1.0.0', bundleFiles('1.0.0'));
    const verified: VerifiedBundles = new Map();
    expect(resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified).ok).toBe(true);
    // The installer moves a NEW folder into place (staging → version).
    const staging = join(root, 'game', '.staging');
    writeTree(staging, bundleFiles('1.0.0', 'globalThis.plugin = { other: true };'));
    rmSync(join(root, 'game', '1.0.0'), { recursive: true, force: true });
    renameSync(staging, join(root, 'game', '1.0.0'));
    const again = resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, verified);
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses a legacy Node bundle (index.js) with the fix in the message', () => {
    const digest = install('1.0.0', { 'index.js': 'export const plugin = {};' });
    const result = resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, new Map());
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (!result.ok) expect(result.error).toMatch(/legacy Node bundle.*sandbox-v1/);
  });

  it('refuses an invalid manifest, a manifest for another plugin or another version (422)', () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ['1.0.0', { 'manifest.json': '{"sdk":"node"}', 'server.js': '' }, /sdk/],
      ['1.0.1', { 'manifest.json': MANIFEST('1.0.1', 'other-game'), 'server.js': '' }, /does not match plugin id/],
      ['1.0.2', { 'manifest.json': MANIFEST('9.9.9'), 'server.js': '' }, /does not match the installed version/],
    ];
    for (const [version, files, message] of cases) {
      const digest = install(version, files);
      const result = resolveBundle(root, { pluginId: 'game', version, digest }, new Map());
      expect(result).toMatchObject({ ok: false, status: 422 });
      if (!result.ok) expect(result.error).toMatch(message);
    }
  });

  it('refuses a server.js over the size cap (422)', () => {
    const digest = install('1.0.0', bundleFiles('1.0.0', 'x'.repeat(MAX_SOURCE_BYTES + 1)));
    expect(resolveBundle(root, { pluginId: 'game', version: '1.0.0', digest }, new Map())).toMatchObject({ ok: false, status: 422 });
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
