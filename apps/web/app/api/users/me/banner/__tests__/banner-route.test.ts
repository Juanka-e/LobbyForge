import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateUserBanner = vi.fn();
const getUserStoredImageBytes = vi.fn();
const getUserById = vi.fn();
const requireMaterializedSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  updateUserBanner,
  getUserStoredImageBytes,
  getUserById,
  USER_IMAGE_QUOTA_BYTES: 24 * 1024 * 1024,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/member-bus', () => ({ publishProfileChanged: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
// The daily upload budget keys on the client address (security-review FILE-001).
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  resolveClientAddress: (req: Request) => req.headers.get('x-test-client') ?? '203.0.113.10',
}));

beforeEach(() => {
  updateUserBanner.mockReset().mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000001',
    bannerUrl: 'data:image/png;base64,' + 'a'.repeat(80),
  });
  getUserStoredImageBytes.mockReset().mockResolvedValue(0);
  getUserById.mockReset().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', isGuest: false });
  requireMaterializedSession.mockReset().mockReturnValue({
    ok: true,
    session: {
      uid: '00000000-0000-0000-0000-000000000001',
      gid: 'g_current_session_0000000000000001',
      name: 'Owner',
    },
  });
});

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('../route.js');
  return POST(
    new Request('https://example.test/api/users/me/banner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    {}
  );
}

/** A real minimal 1280×720 WebP (VP8L) data URL. */
function validBanner(): string {
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0);
  webp.writeUInt32LE(16, 4);
  webp.write('WEBP', 8);
  webp.write('VP8L', 12);
  webp[20] = 0x2f;
  const bits = ((1280 - 1) & 0x3fff) | (((720 - 1) & 0x3fff) << 14);
  webp[21] = bits & 0xff;
  webp[22] = (bits >> 8) & 0xff;
  webp[23] = (bits >> 16) & 0xff;
  webp[24] = (bits >> 24) & 0xff;
  return 'data:image/webp;base64,' + webp.toString('base64');
}

describe('POST /api/users/me/banner — security-review FILE-001', () => {
  beforeEach(async () => {
    const { __resetUploadBudgetMemory } = await import('@/lib/upload-budget');
    __resetUploadBudgetMemory();
  });

  it('refuses a guest account with 403 guest_upload_forbidden, before anything is stored', async () => {
    getUserById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', isGuest: true });

    const response = await post({ dataUrl: validBanner() });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'guest_upload_forbidden' });
    expect(updateUserBanner).not.toHaveBeenCalled();
    expect(getUserStoredImageBytes).not.toHaveBeenCalled();
  });

  it('still lets a guest remove an old banner', async () => {
    getUserById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', isGuest: true });

    const response = await post({ dataUrl: null });

    expect(response.status).toBe(200);
    expect(updateUserBanner).toHaveBeenCalledWith(expect.anything(), '00000000-0000-0000-0000-000000000001', null);
  });

  it('answers 429 upload_budget_exceeded once the address used its daily budget, and stores nothing', async () => {
    const { reserveUploadBytes, UPLOAD_BYTES_PER_ADDRESS } = await import('@/lib/upload-budget');
    const fill = new Request('https://example.test/x', { headers: { 'x-test-client': '198.51.100.7' } });
    // The address has 10 bytes left — less than this banner's data URL.
    expect((await reserveUploadBytes(fill, UPLOAD_BYTES_PER_ADDRESS - 10)).ok).toBe(true);

    const response = await post({ dataUrl: validBanner() }, { 'x-test-client': '198.51.100.7' });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(await response.json()).toMatchObject({ code: 'upload_budget_exceeded' });
    expect(updateUserBanner).not.toHaveBeenCalled();

    // Another address is unaffected.
    expect((await post({ dataUrl: validBanner() }, { 'x-test-client': '198.51.100.8' })).status).toBe(200);
  });
});

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

  it('SEC-010: rejects the upload when the aggregate image quota is blown', async () => {
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0);
    webp.writeUInt32LE(16, 4);
    webp.write('WEBP', 8);
    webp.write('VP8L', 12);
    webp[20] = 0x2f;
    const bits = ((1280 - 1) & 0x3fff) | (((720 - 1) & 0x3fff) << 14);
    webp[21] = bits & 0xff;
    webp[22] = (bits >> 8) & 0xff;
    webp[23] = (bits >> 16) & 0xff;
    webp[24] = (bits >> 24) & 0xff;
    const dataUrl = 'data:image/webp;base64,' + webp.toString('base64');
    // Already at the ceiling — this upload must be refused BEFORE persist.
    getUserStoredImageBytes.mockResolvedValue(24 * 1024 * 1024);

    const response = await post({ dataUrl });

    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json.quotaBytes).toBe(24 * 1024 * 1024);
    expect(updateUserBanner).not.toHaveBeenCalled();
  });

  it('SEC-010: removal (null) never hits the quota and always succeeds', async () => {
    getUserStoredImageBytes.mockResolvedValue(24 * 1024 * 1024);

    const response = await post({ dataUrl: null });

    expect(response.status).toBe(200);
    expect(updateUserBanner).toHaveBeenCalled();
    expect(getUserStoredImageBytes).not.toHaveBeenCalled();
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
