import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSessions = vi.fn();
const revokeSession = vi.fn();
const requireMaterializedSession = vi.fn();

vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/session-tracker', () => ({ listSessions, revokeSession }));

beforeEach(() => {
  listSessions.mockReset();
  revokeSession.mockReset();
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
    new Request('https://example.test/api/settings/me/sessions', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

describe('PATCH /api/settings/me/sessions', () => {
  it('rejects malformed revoke payloads', async () => {
    const response = await patch({ action: 'revoke', gid: 'short' });

    expect(response.status).toBe(400);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('does not revoke the current session through the sessions list endpoint', async () => {
    const response = await patch({
      action: 'revoke',
      gid: 'g_current_session_0000000000000001',
    });

    expect(response.status).toBe(409);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('revokes another session owned by the caller', async () => {
    const response = await patch({
      action: 'revoke',
      gid: 'g_other_session_00000000000000001',
    });

    expect(response.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'g_other_session_00000000000000001'
    );
  });
});
