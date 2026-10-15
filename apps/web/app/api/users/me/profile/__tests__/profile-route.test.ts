import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateUserProfile = vi.fn();
const requireMaterializedSession = vi.fn();
const getUserById = vi.fn();
const publishProfileChanged = vi.fn();

class UsernameTakenError extends Error {}

vi.mock('@lobbyforge/db', () => ({ updateUserProfile, getUserById, UsernameTakenError }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/member-bus', () => ({ publishProfileChanged }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

beforeEach(() => {
  publishProfileChanged.mockReset();
  getUserById.mockReset().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', isGuest: false });
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

  it('refuses control characters in a display name, as sign-up does', async () => {
    // (Leading and trailing whitespace, CR/LF included, is trimmed first.)
    for (const displayName of ['Ow\nner', 'Own\u0085er', 'O\u0000wner', 'Own\u0007er']) {
      const response = await patch({ displayName });
      expect(response.status).toBe(400);
    }
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

  it('tells every community the profile changed, after a save only', async () => {
    await patch({ bio: 'hi' });
    expect(publishProfileChanged).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001');
    publishProfileChanged.mockReset();
    await patch({ displayName: 'x' });
    expect(publishProfileChanged).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/me/profile — 0050 profile fields', () => {
  it('stores a handle lowercased and trimmed', async () => {
    const response = await patch({ username: '  Ada_L.dev ' });
    expect(response.status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), expect.any(String), { username: 'ada_l.dev' });
  });

  it('refuses a malformed or reserved handle with a reason code, before any write', async () => {
    const cases: Array<[string, string]> = [
      ['a', 'username_too_short'],
      ['x'.repeat(33), 'username_too_long'],
      ['ada lovelace', 'username_characters'],
      ['ada!', 'username_characters'],
      ['.ada', 'username_dots'],
      ['ada..l', 'username_dots'],
      ['everyone', 'username_reserved'],
      ['Here', 'username_reserved'],
    ];
    for (const [username, code] of cases) {
      const response = await patch({ username });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe(code);
    }
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it('a guest cannot take a handle', async () => {
    getUserById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', isGuest: true });
    const response = await patch({ username: 'ada' });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('username_guest');
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it('a handle someone else holds answers 409 username_taken', async () => {
    updateUserProfile.mockRejectedValue(new UsernameTakenError('taken'));
    const response = await patch({ username: 'ada' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('username_taken');
  });

  it('null or an empty handle clears it (guests too)', async () => {
    getUserById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', isGuest: true });
    expect((await patch({ username: null })).status).toBe(200);
    expect((await patch({ username: '  ' })).status).toBe(200);
    expect(updateUserProfile).toHaveBeenNthCalledWith(1, expect.anything(), expect.any(String), { username: null });
    expect(updateUserProfile).toHaveBeenNthCalledWith(2, expect.anything(), expect.any(String), { username: null });
  });

  it('pronouns: inner whitespace collapsed, at most 40 characters, no control characters', async () => {
    expect((await patch({ pronouns: '  she /  her ' })).status).toBe(200);
    expect(updateUserProfile).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), { pronouns: 'she / her' });
    const long = await patch({ pronouns: 'x'.repeat(41) });
    expect(long.status).toBe(400);
    expect((await long.json()).code).toBe('pronouns_too_long');
    const control = await patch({ pronouns: 'she\u0007her' });
    expect(control.status).toBe(400);
  });

  it('the profile colour must be #rrggbb; it is stored lowercase; null resets it', async () => {
    expect((await patch({ accentColor: '#5865F2' })).status).toBe(200);
    expect(updateUserProfile).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), { accentColor: '#5865f2' });
    for (const accentColor of ['red', '#fff', '#12345g', 'url(x)']) {
      const response = await patch({ accentColor });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('accent_color_invalid');
    }
    expect((await patch({ accentColor: null })).status).toBe(200);
    expect(updateUserProfile).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), { accentColor: null });
  });
});
