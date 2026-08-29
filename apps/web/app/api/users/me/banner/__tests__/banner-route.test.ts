import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateUserBanner = vi.fn();
const requireMaterializedSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({ updateUserBanner }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

beforeEach(() => {
  updateUserBanner.mockReset().mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000001',
    bannerUrl: 'data:image/png;base64,' + 'a'.repeat(80),
  });
  requireMaterializedSession.mockReset().mockReturnValue({
    ok: true,
    session: {
      uid: '00000000-0000-0000-0000-000000000001',
      gid: 'g_current_session_0000000000000001',
      name: 'Owner',
    },
  });
});

async function post(body: unknown) {
  const { POST } = await import('../route.js');
  return POST(
    new Request('https://example.test/api/users/me/banner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

describe('POST /api/users/me/banner', () => {
  it('rejects non-image data URLs', async () => {
    const response = await post({ dataUrl: 'data:text/html;base64,' + 'a'.repeat(80) });

    expect(response.status).toBe(400);
    expect(updateUserBanner).not.toHaveBeenCalled();
  });

  it('updates the current user banner', async () => {
    // Real minimal WebP (VP8L lossless) header carrying 1280×720 — the
    // route now parses actual dimensions (min 960×540, V5/GIF batch).
    // 40 bytes so the data URL clears the structural .min(64) floor.
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0);
    webp.writeUInt32LE(16, 4);
    webp.write('WEBP', 8);
    webp.write('VP8L', 12);
    webp[20] = 0x2f; // lossless signature
    const bits = ((1280 - 1) & 0x3fff) | (((720 - 1) & 0x3fff) << 14);
    webp[21] = bits & 0xff;
    webp[22] = (bits >> 8) & 0xff;
    webp[23] = (bits >> 16) & 0xff;
    webp[24] = (bits >> 24) & 0xff;
    const dataUrl = 'data:image/webp;base64,' + webp.toString('base64');
    const response = await post({ dataUrl });

    expect(response.status).toBe(200);
    expect(updateUserBanner).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      dataUrl
    );
  });

  it('rejects a banner below the minimum dimensions', async () => {
    const png = Buffer.alloc(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.write('IHDR', 12);
    png.writeUInt32BE(400, 16); // 400×300 — under the 960×540 floor
    png.writeUInt32BE(300, 20);
    const response = await post({ dataUrl: 'data:image/png;base64,' + png.toString('base64') });

    expect(response.status).toBe(400);
    expect(updateUserBanner).not.toHaveBeenCalled();
  });

  it('allows removing the banner', async () => {
    const response = await post({ dataUrl: null });

    expect(response.status).toBe(200);
    expect(updateUserBanner).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      null
    );
  });
});
