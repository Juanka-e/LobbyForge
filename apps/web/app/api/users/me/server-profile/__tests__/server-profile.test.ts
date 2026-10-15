import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireMaterializedSession: vi.fn(),
  getServerById: vi.fn(),
  getServerMember: vi.fn(),
  listServersForUser: vi.fn(),
  updateMemberNickname: vi.fn(),
  publishMembersChanged: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => ({
  getServerById: mocks.getServerById,
  getServerMember: mocks.getServerMember,
  listServersForUser: mocks.listServersForUser,
  updateMemberNickname: mocks.updateMemberNickname,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __db: true }) }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession: mocks.requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/member-bus', () => ({ publishMembersChanged: mocks.publishMembersChanged }));

const UID = '00000000-0000-4000-8000-000000000001';
const SERVER_A = '10000000-0000-4000-8000-00000000000a';
const SERVER_B = '10000000-0000-4000-8000-00000000000b';

async function patch(body: unknown) {
  const { PATCH } = await import('../route.js');
  return PATCH(new Request('https://example.test/api/users/me/server-profile', { method: 'PATCH', body: JSON.stringify(body) }), {});
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.requireMaterializedSession.mockReturnValue({ ok: true, session: { uid: UID } });
  mocks.getServerById.mockImplementation(async (_db: unknown, id: string) => ({ id }));
  mocks.getServerMember.mockResolvedValue({ id: 'm1' });
  mocks.listServersForUser.mockResolvedValue([{ id: SERVER_A }]);
  mocks.updateMemberNickname.mockImplementation(async (_db: unknown, _s: string, _u: string, nickname: string | null) => ({ nickname }));
});

describe('PATCH /api/users/me/server-profile', () => {
  it('sets the nickname in the community named, not the newest one', async () => {
    const res = await patch({ serverId: SERVER_B, nickname: 'Countess' });
    expect(res.status).toBe(200);
    expect(mocks.updateMemberNickname).toHaveBeenCalledWith({ __db: true }, SERVER_B, UID, 'Countess');
    expect(await res.json()).toEqual({ serverProfile: { serverId: SERVER_B, nickname: 'Countess' } });
    expect(mocks.publishMembersChanged).toHaveBeenCalledWith(SERVER_B, [UID]);
  });

  it('a community the account is not in answers 409 no_community and changes nothing', async () => {
    mocks.getServerMember.mockResolvedValue(null);
    const res = await patch({ serverId: SERVER_B, nickname: 'x1' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_community');
    expect(mocks.updateMemberNickname).not.toHaveBeenCalled();
    expect(mocks.publishMembersChanged).not.toHaveBeenCalled();
  });

  it('an older client without serverId still gets the newest community', async () => {
    await patch({ nickname: 'Old' });
    expect(mocks.updateMemberNickname).toHaveBeenCalledWith({ __db: true }, SERVER_A, UID, 'Old');
  });

  it('a bad nickname answers 400 invalid_nickname', async () => {
    const res = await patch({ serverId: SERVER_A, nickname: '<b>' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_nickname');
  });
});
