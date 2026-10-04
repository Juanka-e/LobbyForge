import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET, HEAD } from '../route';
import {
  PLUGIN_UI_CSP,
  fetchMetadataRefusal,
  parsePluginUiPath,
} from '@/lib/plugin-ui-assets';

const DIGEST = 'a'.repeat(64);
let root: string;

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** A sandbox-v1 bundle as the installer leaves it: manifest.json + server.js (+ ui/). */
function install(
  pluginId: string,
  version: string,
  manifest: Record<string, unknown> | null,
  files: Record<string, string>
) {
  const dir = join(root, pluginId, version);
  mkdirSync(dir, { recursive: true });
  if (manifest) {
    write(
      join(dir, 'manifest.json'),
      JSON.stringify({ id: pluginId, name: pluginId, version, actionPolicies: {}, ...manifest })
    );
  }
  write(join(dir, 'server.js'), 'globalThis.plugin = { createInitialState() { return {}; }, handleAction(c, s) { return s; } };');
  for (const [rel, content] of Object.entries(files)) write(join(dir, ...rel.split('/')), content);
}

function activate(pluginId: string, version: string) {
  write(join(root, pluginId, 'active.json'), JSON.stringify({ version, digest: DIGEST }));
}

const SANDBOX = { sdk: 'sandbox-v1', ui: true };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-plugin-ui-'));
  install('buzzer', '1.0.0', SANDBOX, {
    'secret.txt': 'not ui',
    'ui/index.html': '<!doctype html><title>Buzzer</title><script type="module" src="app.js"></script>',
    'ui/app.js': 'console.log("buzz")',
    'ui/style.css': 'body{margin:0}',
    'ui/data.json': '{"a":1}',
    'ui/img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'ui/notes.txt': 'not an allowed extension',
    'ui/index.php': '<?php ?>',
  });
  // An older version still on disk, not active.
  install('buzzer', '0.9.0', SANDBOX, { 'ui/index.html': '<p>old</p>' });
  activate('buzzer', '1.0.0');
  // Installed and active, but declares no UI / is a legacy bundle / has no manifest.
  install('noui', '1.0.0', { sdk: 'sandbox-v1', ui: false }, { 'ui/index.html': '<p>x</p>' });
  activate('noui', '1.0.0');
  install('legacy', '1.0.0', { ui: true }, { 'ui/index.html': '<p>x</p>' });
  activate('legacy', '1.0.0');
  // A manifest that does not match its folder (the installer would refuse it).
  install('mismatch', '1.0.0', { sdk: 'sandbox-v1', ui: true, version: '1.0.1' }, { 'ui/index.html': '<p>x</p>' });
  activate('mismatch', '1.0.0');
  install('bare', '1.0.0', null, { 'ui/index.html': '<p>x</p>' });
  activate('bare', '1.0.0');
  // On disk but never activated.
  install('pending', '1.0.0', { sdk: 'sandbox-v1', ui: true }, { 'ui/index.html': '<p>x</p>' });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const saved = { ...process.env };
beforeEach(() => {
  process.env.LOBBYFORGE_PLUGIN_INSTALL_DIR = root;
  process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
});
afterEach(() => {
  process.env = { ...saved };
});

function get(
  pluginId: string,
  version: string,
  path: string[],
  headers: Record<string, string> = {},
  method: 'GET' | 'HEAD' = 'GET'
) {
  const req = new Request(`http://localhost/api/plugin-ui/${pluginId}/${version}/${path.join('/')}`, {
    method,
    headers,
  });
  const ctx = { params: Promise.resolve({ pluginId, version, path }) };
  return method === 'HEAD' ? HEAD(req, ctx) : GET(req, ctx);
}

/** What the lobby's iframe navigation and the frame's own requests look like. */
const AS_IFRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
const FROM_FRAME = (dest: string) => ({ 'sec-fetch-dest': dest, 'sec-fetch-site': 'cross-site' });

describe('GET /api/plugin-ui — what is served', () => {
  it('serves the active version’s index.html with the sandbox headers', async () => {
    const res = await get('buzzer', '1.0.0', ['index.html'], AS_IFRAME);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Buzzer</title>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(PLUGIN_UI_CSP);
    const csp = PLUGIN_UI_CSP.split('; ');
    expect(csp).toEqual([
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'none'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      'sandbox allow-scripts',
    ]);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('vary')).toBe('Sec-Fetch-Dest, Sec-Fetch-Site');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    // Framing is governed by frame-ancestors 'self'; DENY would kill the frame.
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('serves scripts, styles, data and images with fixed types', async () => {
    const js = await get('buzzer', '1.0.0', ['app.js'], FROM_FRAME('script'));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await js.text()).toBe('console.log("buzz")');
    const css = await get('buzzer', '1.0.0', ['style.css'], FROM_FRAME('style'));
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const json = await get('buzzer', '1.0.0', ['data.json'], FROM_FRAME('empty'));
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const svg = await get('buzzer', '1.0.0', ['img', 'logo.svg'], FROM_FRAME('image'));
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-disposition')).toBe('inline');
    expect(svg.headers.get('content-security-policy')).toBe(PLUGIN_UI_CSP);
    expect(js.headers.get('content-disposition')).toBeNull();
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await get('buzzer', '1.0.0', ['app.js'], {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String('console.log("buzz")'.length));
    expect(await res.text()).toBe('');
  });

  it('serves browsers that send no Fetch Metadata (the CSP sandbox still holds)', async () => {
    const res = await get('buzzer', '1.0.0', ['index.html']);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/plugin-ui — 404s', () => {
  it('serves only the ACTIVE version', async () => {
    expect((await get('buzzer', '0.9.0', ['index.html'], AS_IFRAME)).status).toBe(404);
    expect((await get('buzzer', '2.0.0', ['index.html'], AS_IFRAME)).status).toBe(404);
  });

  it('refuses plugins without a declared UI, legacy bundles and anything not activated', async () => {
    for (const id of ['noui', 'legacy', 'mismatch', 'bare', 'pending', 'missing']) {
      const res = await get(id, '1.0.0', ['index.html'], AS_IFRAME);
      expect(res.status, id).toBe(404);
      expect(res.headers.get('cache-control'), id).toBe('no-store');
      expect(res.headers.get('x-content-type-options'), id).toBe('nosniff');
    }
  });

  it('serves nothing while dynamic plugins are disabled', async () => {
    process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'false';
    expect((await get('buzzer', '1.0.0', ['index.html'], AS_IFRAME)).status).toBe(404);
  });

  it('only serves allowlisted extensions, even when the file exists', async () => {
    for (const name of ['notes.txt', 'index.php', 'app.js.map', 'README', 'index']) {
      expect((await get('buzzer', '1.0.0', [name])).status, name).toBe(404);
    }
  });

  it('makes path traversal impossible', async () => {
    const attempts: string[][] = [
      ['..', 'server.js'],
      ['..', 'manifest.json'],
      ['..', '..', 'active.json'],
      ['..', 'secret.txt'],
      ['..', '..', '0.9.0', 'ui', 'index.html'],
      ['..', '..', '..', 'noui', '1.0.0', 'ui', 'index.html'],
      ['.', 'index.html'],
      ['img', '..', 'app.js'],
      ['..%2fserver.js'],
      ['../server.js'],
      ['..\\server.js'],
      ['img\\logo.svg'],
      ['/etc', 'passwd.json'],
      ['C:', 'Windows', 'win.ini.json'],
      ['app.js\u0000.png'],
      ['.hidden.js'],
      ['index.html.'],
      ['app..js'],
      ['a b.js'],
      ['app.js:stream.js'],
      [''],
      [],
      Array.from({ length: 13 }, () => 'a').concat('x.js'),
    ];
    for (const path of attempts) {
      const res = await get('buzzer', '1.0.0', path);
      expect(res.status, JSON.stringify(path)).toBe(404);
    }
  });

  it('refuses malformed plugin ids and versions', async () => {
    expect((await get('../buzzer', '1.0.0', ['index.html'])).status).toBe(404);
    expect((await get('buzzer', '1.0.0/../0.9.0', ['index.html'])).status).toBe(404);
    expect((await get('buzzer', '../1.0.0', ['index.html'])).status).toBe(404);
    expect((await get('buzzer', 'latest', ['index.html'])).status).toBe(404);
  });

  it('does not follow a symlink out of ui/', async () => {
    const link = join(root, 'buzzer', '1.0.0', 'ui', 'escape.js');
    try {
      symlinkSync(join(root, 'buzzer', '1.0.0', 'server.js'), link);
    } catch {
      return; // Creating symlinks needs a privilege on Windows; covered on Linux CI.
    }
    try {
      expect((await get('buzzer', '1.0.0', ['escape.js'])).status).toBe(404);
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe('GET /api/plugin-ui — Fetch Metadata', () => {
  it('serves the HTML only as an iframe document', async () => {
    expect((await get('buzzer', '1.0.0', ['index.html'], AS_IFRAME)).status).toBe(200);
    // The frame reloading itself or opening another of its pages.
    expect((await get('buzzer', '1.0.0', ['index.html'], FROM_FRAME('iframe'))).status).toBe(200);
    for (const dest of ['document', 'object', 'embed', 'empty', 'script']) {
      const res = await get('buzzer', '1.0.0', ['index.html'], { 'sec-fetch-dest': dest, 'sec-fetch-site': 'none' });
      expect(res.status, dest).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('never serves the app’s own pages a plugin script (no same-origin gadget)', async () => {
    for (const site of ['same-origin', 'same-site']) {
      expect((await get('buzzer', '1.0.0', ['app.js'], { 'sec-fetch-dest': 'script', 'sec-fetch-site': site })).status).toBe(403);
      expect((await get('buzzer', '1.0.0', ['style.css'], { 'sec-fetch-dest': 'style', 'sec-fetch-site': site })).status).toBe(403);
    }
  });

  it('never serves anything as a worker, nor a non-HTML file as a document', async () => {
    for (const dest of ['worker', 'sharedworker', 'serviceworker']) {
      expect((await get('buzzer', '1.0.0', ['app.js'], FROM_FRAME(dest))).status, dest).toBe(403);
    }
    for (const dest of ['document', 'iframe', 'object', 'embed']) {
      expect((await get('buzzer', '1.0.0', ['img', 'logo.svg'], FROM_FRAME(dest))).status, dest).toBe(403);
    }
  });

  it('refuses before looking at the disk, so a refusal reveals nothing', async () => {
    const res = await get('missing', '9.9.9', ['app.js'], { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(403);
  });
});

describe('parsePluginUiPath / fetchMetadataRefusal', () => {
  it('parses a clean nested path and its type', () => {
    expect(parsePluginUiPath(['assets', 'img', 'Logo-2x.PNG'])).toEqual({
      segments: ['assets', 'img', 'Logo-2x.PNG'],
      contentType: 'image/png',
      kind: 'image',
    });
    expect(parsePluginUiPath('index.html')).toBeNull();
    expect(parsePluginUiPath([1, 'x.js'])).toBeNull();
  });

  it('allows the frame’s own requests', () => {
    const req = (h: Record<string, string>) => new Request('http://x/', { headers: h });
    expect(fetchMetadataRefusal(req(FROM_FRAME('script')), 'script')).toBeNull();
    expect(fetchMetadataRefusal(req(FROM_FRAME('image')), 'image')).toBeNull();
    expect(fetchMetadataRefusal(req(FROM_FRAME('font')), 'font')).toBeNull();
    expect(fetchMetadataRefusal(req(AS_IFRAME), 'document')).toBeNull();
    expect(fetchMetadataRefusal(req({}), 'script')).toBeNull();
  });
});
