/**
 * Security review PLUG-002: the public asset route must stay cheap.
 *  - the bundle is validated once per installed version (cached per plugin,
 *    version and digest, bounded, emptied by an install), not per request;
 *  - a file is streamed: HEAD reads no body, a Range reads only that range,
 *    and nothing reads a whole file into memory;
 *  - a per-address token bucket in memory answers 429 past a generous burst.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every read the route makes through node:fs/promises, observed. */
const reads = vi.hoisted(() => ({
  readFile: 0,
  streams: [] as Array<{ start?: number; end?: number }>,
  opened: 0,
  closed: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      reads.readFile += 1;
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      reads.opened += 1;
      // Counted once per descriptor, however it is closed (by the route, or
      // by its stream when that ends or is cancelled).
      let closed = false;
      const markClosed = () => {
        if (!closed) reads.closed += 1;
        closed = true;
      };
      // A FileHandle is an EventEmitter at runtime ('close'), not in the types.
      (handle as unknown as NodeJS.EventEmitter).once('close', markClosed);
      const createReadStream = handle.createReadStream.bind(handle);
      handle.createReadStream = ((options?: { start?: number; end?: number }) => {
        reads.streams.push({ start: options?.start, end: options?.end });
        const stream = createReadStream(options);
        stream.once('close', markClosed);
        return stream;
      }) as typeof handle.createReadStream;
      return handle;
    }) as typeof actual.open,
  };
});

const layout = await import('@/lib/plugin-install-layout');
const readManifest = vi.spyOn(layout, 'readInstalledSandboxManifest');
const assets = await import('@/lib/plugin-ui-assets');
const { GET, HEAD } = await import('../route');

let root: string;
const BIG = Buffer.alloc(3 * 1024 * 1024 + 123);
for (let i = 0; i < BIG.length; i++) BIG[i] = i % 251;

function write(path: string, content: string | Buffer) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function install(pluginId: string, version: string, digest: string, manifest: Record<string, unknown> = {}) {
  const dir = join(root, pluginId, version);
  write(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: pluginId, name: pluginId, version, sdk: 'sandbox-v1', ui: true, actionPolicies: {}, ...manifest })
  );
  write(join(dir, 'server.js'), 'globalThis.plugin = {};');
  write(join(dir, 'ui', 'index.html'), '<!doctype html><p>hi</p>');
  write(join(dir, 'ui', 'big.data'), BIG);
  write(join(dir, 'ui', 'empty.js'), '');
  write(join(root, pluginId, 'active.json'), JSON.stringify({ version, digest }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lf-plugin-ui-cost-'));
  install('game', '1.0.0', 'a'.repeat(64));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const saved = { ...process.env };
beforeEach(() => {
  process.env.LOBBYFORGE_PLUGIN_INSTALL_DIR = root;
  process.env.LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED = 'true';
  delete process.env.LOBBYFORGE_TRUSTED_PROXY;
  assets.resetPluginUiAssetCache();
  assets.resetPluginUiRateLimit();
  readManifest.mockClear();
  reads.readFile = 0;
  reads.streams = [];
  reads.opened = 0;
  reads.closed = 0;
});
afterEach(() => {
  process.env = { ...saved };
});

const FROM_FRAME = (dest: string) => ({ 'sec-fetch-dest': dest, 'sec-fetch-site': 'cross-site' });

function get(path: string[], headers: Record<string, string> = {}, method: 'GET' | 'HEAD' = 'GET', pluginId = 'game') {
  const req = new Request(`http://localhost/api/plugin-ui/${pluginId}/1.0.0/${path.join('/')}`, { method, headers });
  const ctx = { params: Promise.resolve({ pluginId, version: '1.0.0', path }) };
  return method === 'HEAD' ? HEAD(req, ctx) : GET(req, ctx);
}

describe('streaming', () => {
  it('streams a whole file without reading it into memory first', async () => {
    const res = await get(['big.data'], FROM_FRAME('empty'));
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(res.headers.get('content-length')).toBe(String(BIG.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(BIG)).toBe(true);
    expect(reads.readFile).toBe(0);
    expect(reads.streams).toEqual([{ start: 0, end: BIG.length - 1 }]);
    expect(reads.closed).toBe(reads.opened);
  });

  it('a Range reads only that range', async () => {
    const res = await get(['big.data'], { ...FROM_FRAME('empty'), range: 'bytes=1048576-1048585' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 1048576-1048585/${BIG.length}`);
    expect(res.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await res.arrayBuffer()).equals(BIG.subarray(1048576, 1048586))).toBe(true);
    expect(reads.streams).toEqual([{ start: 1048576, end: 1048585 }]);
    expect(reads.readFile).toBe(0);
  });

  it('HEAD reads no body, with or without a Range', async () => {
    const whole = await get(['big.data'], {}, 'HEAD');
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe(String(BIG.length));
    expect(await whole.text()).toBe('');
    const part = await get(['big.data'], { range: 'bytes=0-99' }, 'HEAD');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-length')).toBe('100');
    expect(reads.streams).toEqual([]);
    expect(reads.readFile).toBe(0);
    // The descriptor that was opened for its size is closed again.
    expect(reads.closed).toBe(reads.opened);
  });

  it('an unsatisfiable range and an empty file read nothing and leave nothing open', async () => {
    const past = await get(['big.data'], { range: `bytes=${BIG.length}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${BIG.length}`);
    const empty = await get(['empty.js'], FROM_FRAME('script'));
    expect(empty.status).toBe(200);
    expect(empty.headers.get('content-length')).toBe('0');
    expect(await empty.text()).toBe('');
    expect(reads.streams).toEqual([]);
    expect(reads.closed).toBe(reads.opened);
  });

  it('a request cancelled mid-stream closes the file', async () => {
    const res = await get(['big.data'], FROM_FRAME('empty'));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(reads.closed).toBe(reads.opened));
  });
});

describe('the validated-manifest cache', () => {
  it('validates the bundle once per installed version, not per request', async () => {
    for (let i = 0; i < 5; i++) expect((await get(['index.html'], { 'sec-fetch-dest': 'iframe' })).status).toBe(200);
    await get(['big.data'], {}, 'HEAD');
    expect(readManifest).toHaveBeenCalledTimes(1);
  });

  it('a new digest on the active record is validated again; an install empties the cache', async () => {
    install('swap', '1.0.0', 'b'.repeat(64));
    expect((await get(['index.html'], {}, 'GET', 'swap')).status).toBe(200);
    // The files change under the same record: still served from the cache…
    write(join(root, 'swap', '1.0.0', 'manifest.json'), '{"not":"valid"}');
    expect((await get(['index.html'], {}, 'GET', 'swap')).status).toBe(200);
    // …until the record names other bytes (what every install writes)…
    write(join(root, 'swap', 'active.json'), JSON.stringify({ version: '1.0.0', digest: 'c'.repeat(64) }));
    expect((await get(['index.html'], {}, 'GET', 'swap')).status).toBe(404);
    // …or the installer resets the cache.
    install('swap', '1.0.0', 'b'.repeat(64));
    expect((await get(['index.html'], {}, 'GET', 'swap')).status).toBe(200);
    write(join(root, 'swap', '1.0.0', 'manifest.json'), '{"not":"valid"}');
    assets.resetPluginUiAssetCache();
    expect((await get(['index.html'], {}, 'GET', 'swap')).status).toBe(404);
  });

  it('reads the approval on every request, so a withdrawn approval applies at once', async () => {
    const net = { connect: ['https://api.example.com'] };
    install('net', '1.0.0', 'd'.repeat(64), { network: net });
    write(join(root, 'net', 'active.json'), JSON.stringify({ version: '1.0.0', digest: 'd'.repeat(64), approved: { network: net } }));
    const csp = async () =>
      (await get(['index.html'], { 'sec-fetch-dest': 'iframe' }, 'GET', 'net')).headers.get('content-security-policy');
    expect(await csp()).toContain('https://api.example.com');
    write(join(root, 'net', 'active.json'), JSON.stringify({ version: '1.0.0', digest: 'd'.repeat(64) }));
    expect(await csp()).not.toContain('https://api.example.com');
    expect(readManifest).toHaveBeenCalledTimes(1);
  });

  it('is bounded', async () => {
    const extra = assets.PLUGIN_UI_MANIFEST_CACHE_MAX + 5;
    for (let i = 0; i < extra; i++) {
      write(join(root, 'game', 'active.json'), JSON.stringify({ version: '1.0.0', digest: i.toString(16).padStart(64, '0') }));
      await get(['empty.js'], {}, 'HEAD');
    }
    expect(assets.pluginUiAssetCacheSize()).toBe(assets.PLUGIN_UI_MANIFEST_CACHE_MAX);
    write(join(root, 'game', 'active.json'), JSON.stringify({ version: '1.0.0', digest: 'a'.repeat(64) }));
  });
});

describe('the per-address limit', () => {
  // A still clock: the bucket refills with time.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a generous burst, then answers 429 with Retry-After, touching nothing on disk', async () => {
    const now = Date.now();
    for (let i = 0; i < assets.PLUGIN_UI_RATE_BURST; i++) expect(assets.takePluginUiRequest('unknown', now)).toBe(0);
    const res = await get(['index.html']);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('cdn-cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(readManifest).not.toHaveBeenCalled();
    expect(reads.opened).toBe(0);
  });

  it('refills over time', () => {
    const now = 2_000_000;
    for (let i = 0; i < assets.PLUGIN_UI_RATE_BURST; i++) assets.takePluginUiRequest('203.0.113.9', now);
    expect(assets.takePluginUiRequest('203.0.113.9', now)).toBeGreaterThan(0);
    expect(assets.takePluginUiRequest('203.0.113.9', now + 1000)).toBe(0);
  });

  it('keys on the address the trusted proxy reports, so one client does not block another', async () => {
    process.env.LOBBYFORGE_TRUSTED_PROXY = 'x-forwarded-for';
    for (let i = 0; i < assets.PLUGIN_UI_RATE_BURST; i++) assets.takePluginUiRequest('198.51.100.1');
    expect((await get(['index.html'], { 'x-forwarded-for': '198.51.100.1' })).status).toBe(429);
    expect((await get(['index.html'], { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200);
  });
});
