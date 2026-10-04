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

async function approve(): Promise<Response> {
  const { POST } = await import('../route');
  return (POST as unknown as (req: Request) => Promise<Response>)(
    new Request('http://localhost/api/marketplace/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'buzzer', decision: 'approved' }),
    })
  );
}

beforeEach(() => {
  reviewPlugin.mockReset().mockResolvedValue(undefined);
  getCatalogEntry.mockReset().mockResolvedValue({ manifestUrl: 'https://plugins.example.com/buzzer.tgz' });
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
      expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
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
});
