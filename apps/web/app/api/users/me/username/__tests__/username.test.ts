import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireMaterializedSession: vi.fn(),
  isUsernameAvailable: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => ({ isUsernameAvailable: mocks.isUsernameAvailable }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __db: true }) }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession: mocks.requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const UID = '00000000-0000-4000-8000-000000000001';

async function check(name: string) {
  const { GET } = await import('../route.js');
  const res = await GET(new Request(`https://example.test/api/users/me/username?name=${encodeURIComponent(name)}`), {});
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  mocks.requireMaterializedSession.mockReset().mockReturnValue({ ok: true, session: { uid: UID } });
  mocks.isUsernameAvailable.mockReset().mockResolvedValue(true);
});

describe('GET /api/users/me/username', () => {
  it('a free handle is available (normalised first)', async () => {
    expect(await check(' Ada_L ')).toEqual({ status: 200, body: { username: 'ada_l', available: true, problem: null } });
    expect(mocks.isUsernameAvailable).toHaveBeenCalledWith({ __db: true }, 'ada_l', UID);
  });

  it('a taken one says so', async () => {
    mocks.isUsernameAvailable.mockResolvedValue(false);
    expect((await check('ada')).body).toEqual({ username: 'ada', available: false, problem: 'taken' });
  });

  it('a malformed or reserved one answers with the rule, without a lookup', async () => {
    expect((await check('a')).body.problem).toBe('too_short');
    expect((await check('everyone')).body.problem).toBe('reserved');
    expect(mocks.isUsernameAvailable).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    mocks.requireMaterializedSession.mockReturnValue({ ok: false, response: Response.json({ error: 'x' }, { status: 401 }) });
    expect((await check('ada')).status).toBe(401);
  });
});
