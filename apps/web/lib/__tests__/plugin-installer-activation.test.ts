/**
 * installPluginBundle end to end (download and the `tar` binary mocked,
 * everything else real): it writes under LOBBYFORGE_PLUGIN_INSTALL_DIR —
 * the directory the plugin-worker mounts — not under process.cwd(); it
 * records the exact active version + digest; an upgrade removes the
 * superseded version only after the worker has loaded the new one.
 * ADR-007: only sdk "sandbox-v1" bundles install; a legacy Node bundle
 * (index.js) or an archive without manifest.json + server.js at its root
 * is refused before anything is extracted.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const download = vi.hoisted(() => ({ bytes: Buffer.alloc(0) }));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: { ...actual.promises, lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
  };
});

vi.mock('../ip-pinned-https', () => ({
  fetchIpPinned: vi.fn(async () => ({
    ok: true,
    status: 200,
    body: download.bytes,
    arrayBuffer: download.bytes.buffer.slice(
      download.bytes.byteOffset,
      download.bytes.byteOffset + download.bytes.byteLength
    ),
  })),
}));

// Stand-in for `tar -xzf <tgz> -C <dest> --strip-components=1`: the real
// header scan still runs on the same bytes before this is called.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (_file: string, args: string[], _opts: unknown, callback: (err: Error | null, out?: unknown) => void) => {
      try {
        const archive = gunzipSync(readFileSync(args[args.indexOf('-xzf') + 1]!));
        const dest = args[args.indexOf('-C') + 1]!;
        for (let offset = 0; offset + 512 <= archive.length; ) {
          const header = archive.subarray(offset, offset + 512);
          if (header.every((b) => b === 0)) break;
          const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
          const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, ''), 8) || 0;
          const stripped = name.split('/').slice(1).join('/');
          if (header[156] === 0x30 && stripped) {
            const target = join(dest, ...stripped.split('/'));
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, archive.subarray(offset + 512, offset + 512 + size));
          }
          offset += 512 + Math.ceil(size / 512) * 512;
        }
        callback(null, { stdout: '', stderr: '' });
      } catch (err) {
        callback(err as Error);
      }
    },
  };
});

const describeWorkerPlugin = vi.hoisted(() => vi.fn());
vi.mock('../plugin-worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plugin-worker-client')>()),
  describeWorkerPlugin,
}));

const { installPluginBundle } = await import('../plugin-installer');
const { getDynamicPlugin } = await import('../plugin-loader');
const { computeBundleDigest, readActivePointer } = await import('../plugin-install-layout');

function tarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const data = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0);
  data.write(content);
  return Buffer.concat([header, data]);
}

/** A bundle as `tar -czf x.tgz -C bundle .` would produce it. */
function serveBundle(files: Record<string, string>): { sha256: string; sizeBytes: number } {
  const tar = Buffer.concat([...Object.entries(files).map(([n, c]) => tarEntry(`./${n}`, c)), Buffer.alloc(1024, 0)]);
  download.bytes = gzipSync(tar);
  return { sha256: createHash('sha256').update(download.bytes).digest('hex'), sizeBytes: download.bytes.byteLength };
}

/** A sdk "sandbox-v1" bundle for the catalog entry `cool`. */
const bundleFiles = (version: string, source = 'globalThis.plugin = { createInitialState: function () { return {}; }, handleAction: function (c, s) { return s; } };\n') => ({
  'manifest.json': JSON.stringify({
    id: 'cool',
    name: 'Cool',
    version,
    sdk: 'sandbox-v1',
    ui: false,
    actionPolicies: { tap: { role: 'member', actorFields: ['playerId'] } },
  }),
  'server.js': source,
});

/** What the worker-backed describe returns once the bundle loads. */
const infoFor = (ref: { pluginId: string; version: string; digest: string }) => ({
  id: ref.pluginId,
  name: 'Cool',
  version: ref.version,
  digest: ref.digest,
  sdk: 'sandbox-v1' as const,
  actionPolicies: { tap: { role: 'member' as const, actorFields: ['playerId'] } },
  locales: ['en'],
  ui: false,
  hasValidateAction: false,
  hasProjection: false,
  hasMigrateState: false,
});

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `lf-plugin-install-${process.pid}-${Date.now()}`);
  vi.stubEnv('LOBBYFORGE_PLUGIN_INSTALL_DIR', root);
  vi.stubEnv('LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED', 'true');
  vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_URL', 'http://plugin-worker:7101');
  describeWorkerPlugin.mockReset().mockImplementation(async (ref: { pluginId: string; version: string; digest: string }) => infoFor(ref));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('installPluginBundle', () => {
  it('writes under LOBBYFORGE_PLUGIN_INSTALL_DIR (not process.cwd()) and records the active version', async () => {
    const pin = serveBundle(bundleFiles('1.0.0'));
    const result = await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.0.0.tgz', '1.0.0', pin);
    expect(result).toMatchObject({ ok: true, path: join(root, 'cool', '1.0.0'), version: '1.0.0' });
    const digest = computeBundleDigest(join(root, 'cool', '1.0.0'));
    expect(result.digest).toBe(digest);
    expect(readActivePointer(root, 'cool')).toEqual({ pluginId: 'cool', version: '1.0.0', digest });
    expect(describeWorkerPlugin).toHaveBeenCalledWith({ pluginId: 'cool', version: '1.0.0', digest });
    // Only the bundle's files: the downloaded tarball is not left behind.
    expect(readdirSync(join(root, 'cool', '1.0.0')).sort()).toEqual(['manifest.json', 'server.js']);
    expect(readdirSync(join(root, 'cool')).sort()).toEqual(['1.0.0', 'active.json']);
    expect(existsSync(resolve(process.cwd(), 'plugins', 'installed', 'cool'))).toBe(false);
    expect(getDynamicPlugin('cool')?.manifest.version).toBe('1.0.0');
    // The member policy from the manifest is what the actions route enforces.
    expect(getDynamicPlugin('cool')?.actionPolicies).toEqual({ tap: { role: 'member', actorFields: ['playerId'] } });
  });

  it('upgrade 1.9.0 → 1.10.0: serves 1.10.0 and removes 1.9.0 afterwards', async () => {
    await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.9.0.tgz', '1.9.0', serveBundle(bundleFiles('1.9.0')));
    const result = await installPluginBundle(
      'cool',
      'https://cdn.example.dev/cool-1.10.0.tgz',
      '1.10.0',
      serveBundle(bundleFiles('1.10.0'))
    );
    expect(result.ok).toBe(true);
    expect(readActivePointer(root, 'cool')?.version).toBe('1.10.0');
    expect(readdirSync(join(root, 'cool')).sort()).toEqual(['1.10.0', 'active.json']);
    expect(getDynamicPlugin('cool')?.manifest.version).toBe('1.10.0');
  });

  it('a refused upgrade leaves the previous version active and on disk', async () => {
    await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.0.0.tgz', '1.0.0', serveBundle(bundleFiles('1.0.0')));
    describeWorkerPlugin.mockRejectedValueOnce(new Error('server.js must set globalThis.plugin'));
    const result = await installPluginBundle(
      'cool',
      'https://cdn.example.dev/cool-2.0.0.tgz',
      '2.0.0',
      serveBundle(bundleFiles('2.0.0', 'var nothing = 42;\n'))
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('globalThis.plugin');
    expect(readActivePointer(root, 'cool')?.version).toBe('1.0.0');
    // Staging and the tarball are cleaned up; 2.0.0 never stays.
    expect(readdirSync(join(root, 'cool')).sort()).toEqual(['1.0.0', 'active.json']);
  });

  it('refuses before touching the disk when the isolated worker is not configured', async () => {
    vi.stubEnv('LOBBYFORGE_PLUGIN_WORKER_URL', '');
    const result = await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.0.0.tgz', '1.0.0', serveBundle(bundleFiles('1.0.0')));
    expect(result.ok).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it('refuses bytes that do not match the reviewed pin, writing nothing', async () => {
    const pin = serveBundle(bundleFiles('1.0.0'));
    serveBundle(bundleFiles('1.0.0', 'swapped'));
    const result = await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.0.0.tgz', '1.0.0', pin);
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, 'cool', '1.0.0'))).toBe(false);
    expect(readActivePointer(root, 'cool')).toBeNull();
  });

  it('ADR-007: a legacy Node bundle (index.js) is refused before extraction, with the migration hint', async () => {
    const pin = serveBundle({ 'index.js': 'export const plugin = {};\n' });
    const result = await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.0.0.tgz', '1.0.0', pin);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/legacy Node bundle.*sandbox-v1/);
    expect(describeWorkerPlugin).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'cool', '1.0.0'))).toBe(false);
  });

  it('ADR-007: an archive without server.js at its root is refused before extraction', async () => {
    const files = bundleFiles('1.0.0');
    const pin = serveBundle({ 'manifest.json': files['manifest.json'], 'src/server.js': files['server.js'] });
    const result = await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.0.0.tgz', '1.0.0', pin);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/manifest\.json and server\.js at the archive root/);
    expect(describeWorkerPlugin).not.toHaveBeenCalled();
  });

  it('ADR-007: a manifest whose version is not the catalog version is refused', async () => {
    const pin = serveBundle(bundleFiles('1.0.1'));
    const result = await installPluginBundle('cool', 'https://cdn.example.dev/cool-1.0.0.tgz', '1.0.0', pin);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match the catalog version 1\.0\.0/);
    expect(describeWorkerPlugin).not.toHaveBeenCalled();
    expect(readActivePointer(root, 'cool')).toBeNull();
  });
});
