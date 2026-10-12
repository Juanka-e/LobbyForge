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
  MAX_SERVER_JS_BYTES,
  activateStagedBundle,
  checkSandboxBundle,
  computeBundleDigest,
  listActivePlugins,
  pluginInstallDir,
  pruneSupersededVersions,
  readActivePointer,
  readInstalledSandboxBundle,
  readInstalledSandboxManifest,
  writeActivePointer,
} from '../plugin-install-layout';
import { MAX_LOCALE_FILE_BYTES } from '../sandbox-manifest';

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

/** A sdk "sandbox-v1" bundle (ADR-007): manifest.json + server.js. */
function sandboxBundle(
  version: string,
  source = 'globalThis.plugin = {};',
  manifest: Record<string, unknown> = {},
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    'manifest.json': JSON.stringify({
      id: 'game',
      name: 'Game',
      version,
      sdk: 'sandbox-v1',
      ui: false,
      actionPolicies: { go: { role: 'member' } },
      ...manifest,
    }),
    'server.js': source,
    ...extra,
  };
}

describe('activateStagedBundle', () => {
  it('fresh install: moves the bundle into <version>/, describes that exact version, records it', async () => {
    const describe = describeOk();
    const stagingDir = stage('game', sandboxBundle('1.0.0'));
    const digest = computeBundleDigest(stagingDir);
    const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe });
    expect(result).toMatchObject({ ok: true, path: join(root, 'game', '1.0.0'), digest });
    expect(describe).toHaveBeenCalledWith({ pluginId: 'game', version: '1.0.0', digest });
    expect(readActivePointer(root, 'game')).toEqual({ pluginId: 'game', version: '1.0.0', digest });
    expect(readInstalledSandboxManifest(root, 'game', '1.0.0').actionPolicies).toEqual({ go: { role: 'member' } });
  });

  it('upgrade 1.9.0 → 1.10.0: the old version stays active until the new one is recorded, then is pruned', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.9.0', stagingDir: stage('game', sandboxBundle('1.9.0', 'v1.9')), describe: describeOk(),
    });
    const describe = vi.fn(async (ref: { pluginId: string; version: string; digest: string }) => {
      // While the worker loads the candidate, 1.9.0 is still the record and on disk.
      expect(readActivePointer(root, 'game')?.version).toBe('1.9.0');
      expect(existsSync(join(root, 'game', '1.9.0', 'server.js'))).toBe(true);
      return { id: ref.pluginId, name: 'Game' };
    });
    const result = await activateStagedBundle({
      root, pluginId: 'game', version: '1.10.0', stagingDir: stage('game', sandboxBundle('1.10.0', 'v1.10')), describe,
    });
    expect(result.ok).toBe(true);
    expect(readActivePointer(root, 'game')?.version).toBe('1.10.0');
    expect(pruneSupersededVersions(root, 'game', '1.10.0')).toEqual(['1.9.0']);
    expect(readdirSync(join(root, 'game')).sort()).toEqual(['1.10.0', ACTIVE_POINTER_FILE]);
    expect(readFileSync(join(root, 'game', '1.10.0', 'server.js'), 'utf8')).toBe('v1.10');
  });

  it('a worker refusal rolls back: the previous version stays recorded and on disk', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', sandboxBundle('1.0.0', 'good')), describe: describeOk(),
    });
    const result = await activateStagedBundle({
      root,
      pluginId: 'game',
      version: '2.0.0',
      stagingDir: stage('game', sandboxBundle('2.0.0', 'broken')),
      describe: vi.fn(async () => {
        throw new Error('server.js must set globalThis.plugin');
      }),
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('globalThis.plugin');
    expect(readActivePointer(root, 'game')?.version).toBe('1.0.0');
    expect(existsSync(join(root, 'game', '2.0.0'))).toBe(false);
    expect(readFileSync(join(root, 'game', '1.0.0', 'server.js'), 'utf8')).toBe('good');
  });

  it('refuses a worker that reports another plugin id', async () => {
    const result = await activateStagedBundle({
      root,
      pluginId: 'game',
      version: '1.0.0',
      stagingDir: stage('game', sandboxBundle('1.0.0')),
      describe: vi.fn(async () => ({ id: 'someone-else', name: 'X' })),
    });
    expect(result).toMatchObject({ ok: false });
    expect(readActivePointer(root, 'game')).toBeNull();
    expect(existsSync(join(root, 'game', '1.0.0'))).toBe(false);
  });

  it('ADR-007: refuses what is not a sandbox-v1 bundle for this catalog entry, before the worker sees it', async () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ['a legacy Node bundle', { 'index.js': 'export const plugin = {};' }, /legacy Node bundle.*sandbox-v1/],
      ['server.js nested in a folder', { 'manifest.json': sandboxBundle('1.0.0')['manifest.json']!, 'dist/server.js': '' }, /missing server\.js/],
      ['no manifest', { 'server.js': '' }, /missing manifest\.json/],
      ['a manifest without sdk', sandboxBundle('1.0.0', '', { sdk: undefined }), /"sdk" must be "sandbox-v1"/],
      ['a manifest for another plugin', sandboxBundle('1.0.0', '', { id: 'other' }), /does not match the catalog id/],
      ['a manifest for another version', sandboxBundle('9.9.9'), /does not match the catalog version 1\.0\.0/],
      ['an invalid action policy', sandboxBundle('1.0.0', '', { actionPolicies: { go: { role: 'owner' } } }), /role must be/],
      ['ui: true without ui/index.html', sandboxBundle('1.0.0', '', { ui: true }), /no ui\/index\.html/],
      ['a server.js over the cap', sandboxBundle('1.0.0', 'x'.repeat(MAX_SERVER_JS_BYTES + 1)), /larger than/],
    ];
    for (const [name, files, message] of cases) {
      const stagingDir = stage('game', files);
      const describe = describeOk();
      const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe });
      expect(result, name).toMatchObject({ ok: false });
      expect((result as { error: string }).error, name).toMatch(message);
      expect(describe, name).not.toHaveBeenCalled();
      expect(existsSync(stagingDir), name).toBe(false);
    }
    expect(readActivePointer(root, 'game')).toBeNull();
  });

  it('accepts ui: true with ui/index.html', async () => {
    const stagingDir = stage('game', sandboxBundle('1.0.0', '', { ui: true }, { 'ui/index.html': '<!doctype html>' }));
    const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe: describeOk() });
    expect(result.ok).toBe(true);
    expect(checkSandboxBundle(join(root, 'game', '1.0.0'), 'game', '1.0.0')).toMatchObject({ ok: true, manifest: { ui: true } });
  });

  it('reinstalling the active version with the same bytes keeps the folder', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', sandboxBundle('1.0.0')), describe: describeOk(),
    });
    const stagingDir = stage('game', sandboxBundle('1.0.0'));
    const digest = computeBundleDigest(stagingDir);
    const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe: describeOk() });
    expect(result).toMatchObject({ ok: true, digest });
    expect(existsSync(stagingDir)).toBe(false);
    expect(computeBundleDigest(join(root, 'game', '1.0.0'))).toBe(digest);
  });

  it('reinstalling the active version with different bytes restores the old folder on refusal', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', sandboxBundle('1.0.0', 'old')), describe: describeOk(),
    });
    const before = readActivePointer(root, 'game');
    const result = await activateStagedBundle({
      root,
      pluginId: 'game',
      version: '1.0.0',
      stagingDir: stage('game', sandboxBundle('1.0.0', 'new')),
      describe: vi.fn(async () => {
        throw new Error('worker down');
      }),
    });
    expect(result.ok).toBe(false);
    expect(readActivePointer(root, 'game')).toEqual(before);
    expect(readFileSync(join(root, 'game', '1.0.0', 'server.js'), 'utf8')).toBe('old');
    expect(computeBundleDigest(join(root, 'game', '1.0.0'))).toBe(before?.digest);
  });
});

describe('activateStagedBundle — what a bundle asks for beyond the sandbox', () => {
  const ASKS = {
    network: { connect: ['https://api.example.com'] },
    permissions: ['timers'],
  };
  const APPROVAL = { network: { connect: ['https://api.example.com'] }, permissions: ['timers' as const] };

  it('refuses until the owner approves, before anything moves or the worker sees it', async () => {
    const describe = describeOk();
    const stagingDir = stage('game', sandboxBundle('1.0.0', undefined, ASKS));
    const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe });
    expect(result).toMatchObject({
      ok: false,
      approvalRequired: { requested: APPROVAL, added: APPROVAL, previous: null },
    });
    expect(describe).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'game', '1.0.0'))).toBe(false);
    expect(existsSync(stagingDir)).toBe(false);
    expect(readActivePointer(root, 'game')).toBeNull();
  });

  it('refuses an approval that is not exactly the request', async () => {
    for (const approve of [{ permissions: ['timers' as const] }, { ...APPROVAL, permissions: ['timers' as const, 'chat' as const] }]) {
      const result = await activateStagedBundle({
        root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', sandboxBundle('1.0.0', undefined, ASKS)), describe: describeOk(), approve,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('installs with the exact approval and records it in active.json', async () => {
    const result = await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', sandboxBundle('1.0.0', undefined, ASKS)), describe: describeOk(),
      approve: { permissions: ['timers'], network: { connect: ['https://api.example.com/'] } },
    });
    expect(result).toMatchObject({ ok: true, approved: APPROVAL });
    const pointer = readActivePointer(root, 'game');
    expect(pointer?.approved).toEqual(APPROVAL);
    expect(typeof pointer?.approvedAt).toBe('string');
  });

  it('an upgrade asking for more asks again, naming only the new part', async () => {
    await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', sandboxBundle('1.0.0', undefined, ASKS)), describe: describeOk(), approve: APPROVAL,
    });
    const more = { network: { connect: ['https://api.example.com', 'https://b.example.com'] }, permissions: ['timers', 'chat'] };
    const result = await activateStagedBundle({
      root, pluginId: 'game', version: '1.1.0', stagingDir: stage('game', sandboxBundle('1.1.0', undefined, more)), describe: describeOk(), approve: APPROVAL,
    });
    expect(result).toMatchObject({
      ok: false,
      approvalRequired: {
        added: { network: { connect: ['https://b.example.com'] }, permissions: ['chat'] },
        previous: APPROVAL,
      },
    });
    // The old version stays active, with its approval.
    expect(readActivePointer(root, 'game')).toMatchObject({ version: '1.0.0', approved: APPROVAL });
  });

  it('a bundle that asks for nothing installs without an approval, and records none', async () => {
    const result = await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0', stagingDir: stage('game', sandboxBundle('1.0.0')), describe: describeOk(),
    });
    expect(result).toMatchObject({ ok: true, approved: null });
    expect(readActivePointer(root, 'game')).not.toHaveProperty('approved');
  });

  it('a malformed approval in active.json approves nothing', () => {
    mkdirSync(join(root, 'game'), { recursive: true });
    writeFileSync(
      join(root, 'game', ACTIVE_POINTER_FILE),
      JSON.stringify({ version: '1.0.0', digest: 'a'.repeat(64), approved: { network: { connect: ['https://localhost'] } } })
    );
    expect(readActivePointer(root, 'game')).toEqual({ pluginId: 'game', version: '1.0.0', digest: 'a'.repeat(64) });
  });

  it('a UI on the author’s own site serves no files from the bundle', async () => {
    const result = await activateStagedBundle({
      root, pluginId: 'game', version: '1.0.0',
      stagingDir: stage('game', sandboxBundle('1.0.0', undefined, { ui: { url: 'https://game.example.com/' } })),
      describe: describeOk(),
      approve: { uiUrl: 'https://game.example.com/' },
    });
    expect(result.ok).toBe(true);
    const m = readInstalledSandboxManifest(root, 'game', '1.0.0');
    expect(m.ui).toBe(false);
    expect(m.uiUrl).toBe('https://game.example.com/');
  });

  it('refuses a UI on this instance’s own address — its host or a subdomain — before asking for approval', async () => {
    const saved = process.env.LOBBYFORGE_APP_ORIGIN;
    process.env.LOBBYFORGE_APP_ORIGIN = 'https://chat.example.com';
    try {
      for (const url of ['https://chat.example.com/evil.html', 'https://chat.example.com:8443/', 'https://play.chat.example.com/']) {
        const describe = describeOk();
        const stagingDir = stage('game', sandboxBundle('1.0.0', undefined, { ui: { url } }));
        const result = await activateStagedBundle({
          root, pluginId: 'game', version: '1.0.0', stagingDir, describe, approve: { uiUrl: url },
        });
        expect(result, url).toMatchObject({ ok: false, error: expect.stringContaining('own address') });
        expect(result).not.toHaveProperty('approvalRequired');
        expect(describe).not.toHaveBeenCalled();
        expect(existsSync(stagingDir)).toBe(false);
      }
      expect(readActivePointer(root, 'game')).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.LOBBYFORGE_APP_ORIGIN;
      else process.env.LOBBYFORGE_APP_ORIGIN = saved;
    }
  });
});

describe('readInstalledSandboxManifest', () => {
  it('reads the validated manifest of an installed version, and throws on anything else', () => {
    writeTree(join(root, 'game', '1.0.0'), sandboxBundle('1.0.0'));
    expect(readInstalledSandboxManifest(root, 'game', '1.0.0')).toMatchObject({ id: 'game', sdk: 'sandbox-v1' });
    writeTree(join(root, 'game', '2.0.0'), { 'index.js': '' });
    expect(() => readInstalledSandboxManifest(root, 'game', '2.0.0')).toThrow(/legacy Node bundle/);
    expect(() => readInstalledSandboxManifest(root, '../game', '1.0.0')).toThrow();
    expect(() => readInstalledSandboxManifest(root, 'game', '1.0')).toThrow();
  });
});

describe('locales/<code>.json in a bundle', () => {
  const EN = JSON.stringify({ 'catalog.name': 'Game', 'catalog.summary': 'A game.' });
  const TR = JSON.stringify({ 'catalog.name': 'Oyun', 'catalog.summary': 'Bir oyun.' });

  it('reads and validates the tables, and takes the languages from them', () => {
    writeTree(join(root, 'game', '1.0.0'), sandboxBundle('1.0.0', undefined, {}, { 'locales/en.json': EN, 'locales/tr.json': TR }));
    const bundle = readInstalledSandboxBundle(root, 'game', '1.0.0');
    expect(bundle.manifest.locales).toEqual(['en', 'tr']);
    expect(bundle.localeTables).toEqual({ en: JSON.parse(EN), tr: JSON.parse(TR) });
    expect(readInstalledSandboxManifest(root, 'game', '1.0.0').locales).toEqual(['en', 'tr']);
  });

  it('a bundle without locales/ has no tables and keeps the manifest list', () => {
    writeTree(join(root, 'game', '1.0.0'), sandboxBundle('1.0.0', undefined, { locales: ['en', 'tr'] }));
    expect(readInstalledSandboxBundle(root, 'game', '1.0.0')).toMatchObject({ manifest: { locales: ['en', 'tr'] }, localeTables: {} });
  });

  it('activation refuses a bundle with a malformed locale file, before the worker sees it', async () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ['a non-string value', { 'locales/tr.json': '{"catalog.name": ["Oyun"]}' }, /locales\/tr\.json: "catalog\.name" must be a string/],
      ['invalid JSON', { 'locales/tr.json': '{' }, /locales\/tr\.json: not valid JSON/],
      ['a stray file', { 'locales/en.json': EN, 'locales/notes.txt': 'x' }, /locales\/notes\.txt: only <language code>\.json/],
      ['a sub-folder', { 'locales/old/en.json': EN }, /locales\/old\/en\.json/],
      ['locales as a file', { locales: 'x' }, /locales must be a folder/],
      ['an oversized file (refused before it is read)', { 'locales/en.json': 'x'.repeat(MAX_LOCALE_FILE_BYTES + 1) }, /larger than/],
      ['a manifest list that misses a shipped language', { 'locales/en.json': EN, 'locales/tr.json': TR }, /"tr" is missing from "locales"/],
    ];
    for (const [name, files, message] of cases) {
      const manifest = name.startsWith('a manifest list') ? { locales: ['en'] } : {};
      const stagingDir = stage('game', sandboxBundle('1.0.0', undefined, manifest, files));
      const describe = describeOk();
      const result = await activateStagedBundle({ root, pluginId: 'game', version: '1.0.0', stagingDir, describe });
      expect(result, name).toMatchObject({ ok: false });
      expect((result as { error: string }).error, name).toMatch(message);
      expect(describe, name).not.toHaveBeenCalled();
    }
    expect(readActivePointer(root, 'game')).toBeNull();
  });

  it('activation accepts the example plugin with its English and Turkish tables (and its approved permissions)', async () => {
    const example = resolve(__dirname, '..', '..', '..', '..', 'examples', 'plugins', 'sandbox-buzzer');
    const files: Record<string, string> = {
      'manifest.json': readFileSync(join(example, 'manifest.json'), 'utf8'),
      'server.js': readFileSync(join(example, 'server.js'), 'utf8'),
      'ui/index.html': readFileSync(join(example, 'ui', 'index.html'), 'utf8'),
    };
    for (const name of readdirSync(join(example, 'locales'))) {
      files[`locales/${name}`] = readFileSync(join(example, 'locales', name), 'utf8');
    }
    const version = (JSON.parse(files['manifest.json']!) as { version: string }).version;
    const stagingDir = stage('sandbox-buzzer', files);
    // The example asks for host effects (timers, storage): the owner approves them.
    const describe = describeOk('Sandbox Buzzer');
    const result = await activateStagedBundle({
      root,
      pluginId: 'sandbox-buzzer',
      version,
      stagingDir,
      describe,
      approve: { permissions: ['timers', 'storage'] },
    });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    // The worker-backed plugin is described WITH the approval, so it grants exactly that.
    expect(describe).toHaveBeenCalledWith(expect.objectContaining({ approved: { permissions: ['storage', 'timers'] } }));
    expect(readActivePointer(root, 'sandbox-buzzer')?.approved).toEqual({ permissions: ['storage', 'timers'] });
    const bundle = readInstalledSandboxBundle(root, 'sandbox-buzzer', version);
    expect(Object.keys(bundle.localeTables)).toEqual(['en', 'tr']);
    expect(bundle.localeTables.tr?.['catalog.name']).toBe('Buzzer');
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
