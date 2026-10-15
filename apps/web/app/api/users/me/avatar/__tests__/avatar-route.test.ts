import { beforeEach, describe, expect, it, vi } from 'vitest';

const UID = '00000000-0000-0000-0000-000000000002';
const updateUserAvatar = vi.fn();
const getUserStoredImageBytes = vi.fn();
const getUserById = vi.fn();
const requireMaterializedSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  updateUserAvatar,
  getUserStoredImageBytes,
  getUserById,
  USER_IMAGE_QUOTA_BYTES: 24 * 1024 * 1024,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/member-bus', () => ({ publishProfileChanged: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/mail/verification', () => ({ requireVerifiedEmail: async () => null }));
// The daily upload budget keys on the client address (security-review FILE-001).
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  resolveClientAddress: (req: Request) => req.headers.get('x-test-client') ?? '203.0.113.20',
}));

/** A real minimal 512×512 WebP (VP8L) data URL. */
function validAvatar(): string {
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0);
  webp.writeUInt32LE(16, 4);
  webp.write('WEBP', 8);
  webp.write('VP8L', 12);
  webp[20] = 0x2f;
  const bits = ((512 - 1) & 0x3fff) | (((512 - 1) & 0x3fff) << 14);
  webp[21] = bits & 0xff;
  webp[22] = (bits >> 8) & 0xff;
  webp[23] = (bits >> 16) & 0xff;
  webp[24] = (bits >> 24) & 0xff;
  return 'data:image/webp;base64,' + webp.toString('base64');
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('../route.js');
  return POST(
    new Request('https://example.test/api/users/me/avatar', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    {}
  );
}

beforeEach(async () => {
  updateUserAvatar.mockReset().mockImplementation(async (_db: unknown, _id: string, avatarUrl: string) => ({ id: UID, avatarUrl }));
  getUserStoredImageBytes.mockReset().mockResolvedValue(0);
  getUserById.mockReset().mockResolvedValue({ id: UID, isGuest: false });
  requireMaterializedSession.mockReset().mockReturnValue({
    ok: true,
    session: { uid: UID, gid: 'g_current_session_0000000000000002', name: 'Member' },
  });
  const { __resetUploadBudgetMemory } = await import('@/lib/upload-budget');
  __resetUploadBudgetMemory();
});

describe('POST /api/users/me/avatar', () => {
  it('stores a valid avatar for an account', async () => {
    const dataUrl = validAvatar();
    const response = await post({ dataUrl });

    expect(response.status).toBe(200);
    expect(updateUserAvatar).toHaveBeenCalledWith(expect.anything(), UID, dataUrl);
  });

  it('security-review FILE-001: refuses a guest with 403 guest_upload_forbidden and stores nothing', async () => {
    getUserById.mockResolvedValue({ id: UID, isGuest: true });

    const response = await post({ dataUrl: validAvatar() });

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.code).toBe('guest_upload_forbidden');
    expect(json.error).toMatch(/guest/i);
    expect(updateUserAvatar).not.toHaveBeenCalled();
  });

  it('security-review FILE-001: answers 429 once the client address spent its daily upload budget', async () => {
    const { reserveUploadBytes, UPLOAD_BYTES_PER_ADDRESS } = await import('@/lib/upload-budget');
    const sameAddress = { 'x-test-client': '198.51.100.30' };
    await reserveUploadBytes(new Request('https://example.test/x', { headers: sameAddress }), UPLOAD_BYTES_PER_ADDRESS - 1);

    const response = await post({ dataUrl: validAvatar() }, sameAddress);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'upload_budget_exceeded', budgetBytes: UPLOAD_BYTES_PER_ADDRESS });
    expect(updateUserAvatar).not.toHaveBeenCalled();
  });

  it('a refused upload (quota) does not spend the daily budget', async () => {
    const { reserveUploadBytes, UPLOAD_BYTES_PER_ADDRESS } = await import('@/lib/upload-budget');
    getUserStoredImageBytes.mockResolvedValue(24 * 1024 * 1024);
    expect((await post({ dataUrl: validAvatar() })).status).toBe(413);

    // The whole budget is still there.
    const probe = await reserveUploadBytes(new Request('https://example.test/x'), UPLOAD_BYTES_PER_ADDRESS);
    expect(probe.ok).toBe(true);
  });
});
