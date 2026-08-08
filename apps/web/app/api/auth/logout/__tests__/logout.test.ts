import { beforeEach, describe, expect, it, vi } from 'vitest';

const readGuestSession = vi.fn();
const revokeSession = vi.fn();

vi.mock('@/lib/api-auth', () => ({ getSessionSecret: () => 'x'.repeat(32) }));
vi.mock('@/lib/guest-session', () => ({ readGuestSession }));
vi.mock('@/lib/session-tracker', () => ({ revokeSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

beforeEach(() => {
  readGuestSession.mockReset();
  revokeSession.mockReset();
  revokeSession.mockResolvedValue(undefined);
});

async function post() {
  const { POST } = await import('../route.js');
  return POST(new Request('https://community.example/api/auth/logout', {
    method: 'POST',
    headers: { cookie: 'lf_guest=signed' },
  }), {});
}

describe('POST /api/auth/logout', () => {
  it('revokes the current materialized session and clears the cookie', async () => {
    readGuestSession.mockReturnValue({ uid: 'user-id', gid: `g_${'a'.repeat(32)}` });
    const response = await post();
    expect(response.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith('user-id', `g_${'a'.repeat(32)}`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('remains idempotent without a valid session', async () => {
    readGuestSession.mockReturnValue(null);
    const response = await post();
    expect(response.status).toBe(200);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
