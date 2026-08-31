import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Instance logo route contract: owner-only writes, content-sniffed
 * format + dimension enforcement (LOGO_LIMITS), null clears.
 */

const setInstanceLogoUrl = vi.fn();
const requireInstanceAdmin = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getInstanceSetupStatus: vi.fn().mockResolvedValue({ instanceLogoUrl: null }),
  setInstanceLogoUrl,
}));
vi.mock('@/lib/admin-auth', () => ({
  requireInstanceAdmin: (...args: unknown[]) => requireInstanceAdmin(...args),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));

beforeEach(() => {
  setInstanceLogoUrl.mockReset();
  requireInstanceAdmin.mockReset().mockResolvedValue(null);
});

function png1x1(width: number, height: number): string {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function gif(width: number, height: number): string {
  const buf = Buffer.alloc(200);
  buf.write('GIF89a', 0);
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return `data:image/gif;base64,${buf.toString('base64')}`;
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import('../route.js');
  return POST(
    new Request('http://localhost/api/admin/instance-logo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

async function get(): Promise<Response> {
  const { GET } = await import('../route.js');
  return GET(new Request('http://localhost/api/admin/instance-logo'), {});
}

describe('POST /api/admin/instance-logo', () => {
  it('401 without instance-owner auth', async () => {
    requireInstanceAdmin.mockResolvedValue(Response.json({ error: 'auth' }, { status: 401 }));
    const res = await post({ dataUrl: png1x1(128, 128) });
    expect(res.status).toBe(401);
    expect(setInstanceLogoUrl).not.toHaveBeenCalled();
  });

  it('accepts a valid square logo (animated GIF included)', async () => {
    setInstanceLogoUrl.mockResolvedValue('data:image/gif;base64,AAA');
    const res = await post({ dataUrl: gif(256, 256) });
    expect(res.status).toBe(200);
    expect(setInstanceLogoUrl).toHaveBeenCalledWith(expect.anything(), gif(256, 256));
  });

  it('400 for undersized logos (< 64×64)', async () => {
    const res = await post({ dataUrl: png1x1(48, 48) });
    expect(res.status).toBe(400);
    expect(setInstanceLogoUrl).not.toHaveBeenCalled();
  });

  it('400 for oversized logos (> 1024)', async () => {
    const res = await post({ dataUrl: png1x1(2048, 2048) });
    expect(res.status).toBe(400);
    expect(setInstanceLogoUrl).not.toHaveBeenCalled();
  });

  it('400 for a non-image payload disguised as one', async () => {
    const payload = '<script>alert(1)</script>' + 'x'.repeat(80);
    const html = 'data:image/png;base64,' + Buffer.from(payload).toString('base64');
    const res = await post({ dataUrl: html });
    expect(res.status).toBe(400);
  });

  it('null clears the logo', async () => {
    setInstanceLogoUrl.mockResolvedValue(null);
    const res = await post({ dataUrl: null });
    expect(res.status).toBe(200);
    expect(setInstanceLogoUrl).toHaveBeenCalledWith(expect.anything(), null);
  });
});

describe('GET /api/admin/instance-logo', () => {
  it('is public (read) and returns the current logo', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instanceLogoUrl: string | null };
    expect(body.instanceLogoUrl).toBeNull();
    expect(requireInstanceAdmin).not.toHaveBeenCalled();
  });
});
