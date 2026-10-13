/**
 * ADR-007: approving a marketplace plugin pins its bundle digest — and now
 * refuses bundles that could never be installed (anything but sdk
 * "sandbox-v1": manifest.json + server.js at the archive root). A legacy
 * Node bundle (index.js) is turned away at review, not at install time.
 */
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reviewPlugin = vi.fn();
const getCatalogEntry = vi.fn();
const downloadBundleForReview = vi.fn();

vi.mock('@lobbyforge/db', () => ({ reviewPlugin, getCatalogEntry }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __db: true }) }));
vi.mock('@/lib/admin-auth', () => ({ requireAdminHealthToken: async () => null }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/plugin-bundle-download', () => ({ downloadBundleForReview }));

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(size.toString(8).padStart(11, '0'), 124, 11, 'utf8');
  h[156] = '0'.charCodeAt(0);
  h.write('ustar', 257, 5, 'utf8');
  h.fill(0x20, 148, 156);
  const sum = h.reduce((acc, b) => acc + b, 0);
  h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'utf8');
  return h;
}

function tgz(files: Record<string, string>): ArrayBuffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    blocks.push(tarHeader(name, data.length), data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(blocks));
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer;
}

async function review(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../route');
  return (POST as unknown as (req: Request) => Promise<Response>)(
    new Request('http://localhost/api/marketplace/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'buzzer', ...body }),
    })
  );
}

const approve = (extra: Record<string, unknown> = {}) => review({ decision: 'approved', ...extra });

const URL_1 = 'https://plugins.example.com/buzzer.tgz';

beforeEach(() => {
  reviewPlugin.mockReset().mockResolvedValue(true);
  getCatalogEntry.mockReset().mockResolvedValue({ pluginId: 'buzzer', version: '1.0.0', manifestUrl: URL_1 });
  downloadBundleForReview.mockReset();
});

describe('POST /api/marketplace/review — approval checks the bundle format', () => {
  it('approves and pins a sandbox-v1 bundle', async () => {
    downloadBundleForReview.mockResolvedValue(
      tgz({ 'package/manifest.json': '{"id":"buzzer"}', 'package/server.js': 'globalThis.plugin = {};' })
    );
    const res = await approve();
    expect(res.status).toBe(200);
    expect(reviewPlugin).toHaveBeenCalledWith(
      { __db: true },
      'buzzer',
      'approved',
      null,
      null,
      expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      // Written only while the row still has what was downloaded and pinned.
      { version: '1.0.0', manifestUrl: URL_1 }
    );
  });

  it('refuses a legacy Node bundle and pins nothing', async () => {
    downloadBundleForReview.mockResolvedValue(tgz({ 'package/index.js': 'module.exports = {};' }));
    const res = await approve();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error: string };
    expect(body.code).toBe('not_sandbox_bundle');
    expect(body.error).toContain('legacy Node bundle');
    expect(reviewPlugin).not.toHaveBeenCalled();
  });

  it('refuses a bundle without server.js', async () => {
    downloadBundleForReview.mockResolvedValue(tgz({ 'package/manifest.json': '{"id":"buzzer"}' }));
    const res = await approve();
    expect(res.status).toBe(400);
    expect(reviewPlugin).not.toHaveBeenCalled();
  });

  it('refuses something that is not a gzip tarball', async () => {
    downloadBundleForReview.mockResolvedValue(new TextEncoder().encode('<html>not a bundle</html>').buffer);
    const res = await approve();
    expect(res.status).toBe(400);
    expect(reviewPlugin).not.toHaveBeenCalled();
  });

  it('PLUG-001: refuses a small gzip that inflates past the cap, without inflating it', async () => {
    // 128 gzip members of 1 MiB of zeros each: ~130 KB that inflates to 128 MiB.
    const member = gzipSync(Buffer.alloc(1024 * 1024), { level: 9 });
    const bomb = Buffer.concat(Array.from({ length: 128 }, () => member));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    downloadBundleForReview.mockResolvedValue(bomb.buffer.slice(bomb.byteOffset, bomb.byteOffset + bomb.byteLength));
    const res = await approve();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('tar bomb');
    expect(reviewPlugin).not.toHaveBeenCalled();
  });

  it('PLUG-001: refuses a download over the installer’s 10 MB bundle cap before scanning it', async () => {
    downloadBundleForReview.mockResolvedValue(new ArrayBuffer(10 * 1024 * 1024 + 1));
    const res = await approve();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Bundle exceeds 10485760 bytes');
    expect(reviewPlugin).not.toHaveBeenCalled();
  });
});

describe('POST /api/marketplace/review — the version the reviewer saw', () => {
  const sandbox = () =>
    tgz({ 'package/manifest.json': '{"id":"buzzer"}', 'package/server.js': 'globalThis.plugin = {};' });

  it('approves when the version on screen is still the catalogue’s', async () => {
    downloadBundleForReview.mockResolvedValue(sandbox());
    const res = await approve({ version: '1.0.0' });
    expect(res.status).toBe(200);
    expect(reviewPlugin).toHaveBeenCalledWith(
      { __db: true }, 'buzzer', 'approved', null, null,
      expect.objectContaining({ sizeBytes: expect.any(Number) }),
      { version: '1.0.0', manifestUrl: URL_1 }
    );
  });

  it('refuses with 409 when the publisher resubmitted since — before downloading anything', async () => {
    getCatalogEntry.mockResolvedValue({ pluginId: 'buzzer', version: '1.1.0', manifestUrl: URL_1 });
    const res = await approve({ version: '1.0.0' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'version_changed', version: '1.1.0' });
    expect(downloadBundleForReview).not.toHaveBeenCalled();
    expect(reviewPlugin).not.toHaveBeenCalled();
  });

  it('checks a rejection’s version too', async () => {
    getCatalogEntry.mockResolvedValue({ pluginId: 'buzzer', version: '2.0.0', manifestUrl: URL_1 });
    expect((await review({ decision: 'rejected', version: '1.0.0' })).status).toBe(409);
    expect(reviewPlugin).not.toHaveBeenCalled();

    getCatalogEntry.mockResolvedValue({ pluginId: 'buzzer', version: '1.0.0', manifestUrl: URL_1 });
    expect((await review({ decision: 'rejected', version: '1.0.0' })).status).toBe(200);
    expect(reviewPlugin).toHaveBeenCalledWith({ __db: true }, 'buzzer', 'rejected', null, null, undefined, { version: '1.0.0' });
  });

  it('a resubmission that lands while the bundle downloads is refused too (the guarded update matches nothing)', async () => {
    downloadBundleForReview.mockResolvedValue(sandbox());
    reviewPlugin.mockResolvedValue(false);
    getCatalogEntry
      .mockResolvedValueOnce({ pluginId: 'buzzer', version: '1.0.0', manifestUrl: URL_1 })
      .mockResolvedValueOnce({ pluginId: 'buzzer', version: '1.0.1', manifestUrl: 'https://plugins.example.com/new.tgz' });
    const res = await approve({ version: '1.0.0' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'version_changed', version: '1.0.1' });
  });

  it('404s a plugin that is not in the catalogue', async () => {
    getCatalogEntry.mockResolvedValue(null);
    expect((await review({ decision: 'rejected', version: '1.0.0' })).status).toBe(404);
    reviewPlugin.mockResolvedValue(false);
    expect((await review({ decision: 'rejected' })).status).toBe(404);
  });
});
