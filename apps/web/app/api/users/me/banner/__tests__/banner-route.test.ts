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
    const dataUrl = 'data:image/webp;base64,' + 'a'.repeat(80);
    const response = await post({ dataUrl });

    expect(response.status).toBe(200);
    expect(updateUserBanner).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      dataUrl
    );
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
