import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_FRAME_ORIGINS_RETRY_MS,
  PLUGIN_FRAME_ORIGINS_TTL_MS,
  approvedPluginFrameOrigins,
  readApprovedUiOrigins,
  resetPluginFrameOrigins,
} from '../plugin-frame-origins';

/**
 * The pages' frame-src gains the sites of approved external plugin UIs
 * (phase 2 of the plugin unlock), read from the install root and cached.
 */

const DIGEST = 'c'.repeat(64);
let root: string;

function install(pluginId: string, ui: boolean | { url: string }, approved?: Record<string, unknown>, version = '1.0.0') {
  const dir = join(root, pluginId, version);
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: pluginId, name: pluginId, version, sdk: 'sandbox-v1', ui, actionPolicies: {} }));
  writeFileSync(join(dir, 'server.js'), 'globalThis.plugin = {};');
  writeFileSync(join(dir, 'ui', 'index.html'), '<p>ui</p>');
  writeFileSync(join(root, pluginId, 'active.json'), JSON.stringify({ version, digest: DIGEST, ...(approved ? { approved } : {}) }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-plugin-frame-origins-'));
  install('alpha', { url: 'https://alpha.example.com/play' }, { uiUrl: 'https://alpha.example.com/play' });
  // Two plugins on one site: listed once.
  install('alpha-two', { url: 'https://alpha.example.com/other' }, { uiUrl: 'https://alpha.example.com/other' });
  install('beta', { url: 'https://beta.example.com:8443/' }, { uiUrl: 'https://beta.example.com:8443/' });
  // Asked for, never approved / another URL approved.
  install('pending', { url: 'https://pending.example.com/' });
  install('other-url', { url: 'https://other.example.com/a' }, { uiUrl: 'https://other.example.com/b' });
  // Its own files (an approved connect origin is not a frame origin of the app).
  install('files', true, { network: { connect: ['https://api.example.com'] } });
  // On the instance's own address.
  install('own', { url: 'https://chat.example.test/x' }, { uiUrl: 'https://chat.example.test/x' });
  // Named like an official plugin: never framed, approved or not.
  install('watch-party', { url: 'https://fake-official.example.com/' }, { uiUrl: 'https://fake-official.example.com/' });
  install('Hushle', { url: 'https://fake-hushle.example.com/' }, { uiUrl: 'https://fake-hushle.example.com/' });
  // A damaged bundle: active record, no manifest.
  mkdirSync(join(root, 'broken', '1.0.0'), { recursive: true });
  writeFileSync(join(root, 'broken', 'active.json'), JSON.stringify({ version: '1.0.0', digest: DIGEST }));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({
  LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED: 'true',
  LOBBYFORGE_PLUGIN_INSTALL_DIR: root,
  LOBBYFORGE_APP_ORIGIN: 'https://chat.example.test',
  ...extra,
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetPluginFrameOrigins();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe('readApprovedUiOrigins', () => {
  it('lists each approved external UI’s origin once, and nothing else', () => {
    expect(readApprovedUiOrigins(root, ['https://chat.example.test'])).toEqual([
      'https://alpha.example.com',
      'https://beta.example.com:8443',
    ]);
  });

  it('never adds the site of a bundle installed under an official plugin’s id', () => {
    expect(readApprovedUiOrigins(root, []).join(' ')).not.toMatch(/fake-official|fake-hushle/);
  });

  it('throws when the root cannot be listed (the caller fails closed)', () => {
    const file = join(root, 'alpha', 'active.json');
    expect(() => readApprovedUiOrigins(file, [])).toThrow();
  });
});

describe('approvedPluginFrameOrigins', () => {
  it('adds nothing while dynamic plugins are off', () => {
    expect(approvedPluginFrameOrigins(null, { ...env(), LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED: 'false' })).toEqual([]);
  });

  it('caches the list for 30 s, and an install resets it', () => {
    const t0 = 1_000_000;
    expect(approvedPluginFrameOrigins(null, env(), t0)).toEqual(['https://alpha.example.com', 'https://beta.example.com:8443']);
    install('gamma', { url: 'https://gamma.example.com/' }, { uiUrl: 'https://gamma.example.com/' });
    try {
      // Still the cached list…
      expect(approvedPluginFrameOrigins(null, env(), t0 + PLUGIN_FRAME_ORIGINS_TTL_MS - 1)).not.toContain('https://gamma.example.com');
      // …read again once it is 30 s old…
      expect(approvedPluginFrameOrigins(null, env(), t0 + PLUGIN_FRAME_ORIGINS_TTL_MS)).toContain('https://gamma.example.com');
      // …or at once after a reset (what the installer calls).
      rmSync(join(root, 'gamma'), { recursive: true, force: true });
      resetPluginFrameOrigins();
      expect(approvedPluginFrameOrigins(null, env(), t0 + PLUGIN_FRAME_ORIGINS_TTL_MS + 1)).not.toContain('https://gamma.example.com');
    } finally {
      rmSync(join(root, 'gamma'), { recursive: true, force: true });
    }
  });

  it('leaves out a site on the host the request came in on', () => {
    expect(approvedPluginFrameOrigins('https://alpha.example.com', env())).toEqual(['https://beta.example.com:8443']);
  });

  it('fails closed when the install root cannot be read, and tries again after 5 s', () => {
    const broken = env({ LOBBYFORGE_PLUGIN_INSTALL_DIR: join(root, 'alpha', 'active.json') });
    const t0 = 2_000_000;
    expect(approvedPluginFrameOrigins(null, broken, t0)).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[plugin-frame-origins]'), expect.any(String));
    // Within the retry window, the failure is not retried (and nothing is added).
    expect(approvedPluginFrameOrigins(null, env(), t0 + PLUGIN_FRAME_ORIGINS_RETRY_MS - 1)).toEqual([]);
    expect(approvedPluginFrameOrigins(null, env(), t0 + PLUGIN_FRAME_ORIGINS_RETRY_MS)).toEqual([
      'https://alpha.example.com',
      'https://beta.example.com:8443',
    ]);
  });

  it('keeps one cache per process, shared by every chunk that loads this module', () => {
    approvedPluginFrameOrigins(null, env(), 3_000_000);
    const holder = (globalThis as Record<string, unknown>).__lobbyforgePluginFrameOrigins__ as { origins: string[] };
    expect(holder.origins).toEqual(['https://alpha.example.com', 'https://beta.example.com:8443']);
  });
});
