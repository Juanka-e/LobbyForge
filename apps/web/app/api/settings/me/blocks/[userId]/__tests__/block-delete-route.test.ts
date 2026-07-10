import { beforeEach, describe, expect, it, vi } from 'vitest';

const unblockUser = vi.fn();
const requireMaterializedSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({ unblockUser }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

beforeEach(() => {
  unblockUser.mockReset();
  requireMaterializedSession.mockReset().mockReturnValue({
    ok: true,
    session: {
      uid: '00000000-0000-0000-0000-000000000001',
      gid: 'g_current_session_0000000000000001',
      name: 'Owner',
    },
  });
});

async function remove(userId: string) {
  const { DELETE } = await import('../route.js');
  return DELETE(
    new Request(`https://example.test/api/settings/me/blocks/${userId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ userId }) }
  );
}

describe('DELETE /api/settings/me/blocks/[userId]', () => {
  it('rejects non-UUID ids before calling storage', async () => {
    const response = await remove('../../admin');

    expect(response.status).toBe(400);
    expect(unblockUser).not.toHaveBeenCalled();
  });

  it('unblocks a valid user id for the current caller', async () => {
    const response = await remove('00000000-0000-0000-0000-000000000099');

    expect(response.status).toBe(200);
    expect(unblockUser).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000099'
    );
  });
});
