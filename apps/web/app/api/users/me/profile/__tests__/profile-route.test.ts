import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateUserProfile = vi.fn();
const requireMaterializedSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({ updateUserProfile }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

beforeEach(() => {
  updateUserProfile.mockReset().mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000001',
    displayName: 'Updated',
    statusText: 'Ready',
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

async function patch(body: unknown) {
  const { PATCH } = await import('../route.js');
  return PATCH(
    new Request('https://example.test/api/users/me/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

describe('PATCH /api/users/me/profile', () => {
  it('rejects unknown profile fields', async () => {
    const response = await patch({ displayName: 'Owner', role: 'admin' });

    expect(response.status).toBe(400);
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it('updates display name and status text for the current user', async () => {
    const response = await patch({ displayName: 'Updated', statusText: 'Ready' });

    expect(response.status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      { displayName: 'Updated', statusText: 'Ready' }
    );
  });
});
