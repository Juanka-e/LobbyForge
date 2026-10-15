import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireMaterializedSession: vi.fn(),
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  listMemberSummariesForServer: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => ({
  getServerById: mocks.getServerById,
  isServerMember: mocks.isServerMember,
  listMemberSummariesForServer: mocks.listMemberSummariesForServer,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __db: true }) }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession: mocks.requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));

const SERVER = '10000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-000000000001';
const ALICE = '00000000-0000-4000-8000-00000000000a';
const GONE = '00000000-0000-4000-8000-00000000000f';

function summary(userId: string, extra: Record<string, unknown> = {}) {
  return {
    userId,
    displayName: 'Alice',
    globalDisplayName: 'Alice',
    nickname: null,
    avatarRef: '0123456789ab',
    bannerRef: null,
    profileVisibility: 'everyone',
    isGuest: false,
    roleName: null,
    roleColor: null,
    roleIcon: null,
    statusText: 'busy',
    bio: 'hi',
    username: 'alice',
    pronouns: 'she/her',
    accentColor: '#5865f2',
    roles: [],
    joinedAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  };
}

async function get(query = '') {
  const { GET } = await import('../route.js');
  return GET(new Request(`https://example.test/api/servers/${SERVER}/lobby-members${query}`), {
    params: Promise.resolve({ id: SERVER }),
  });
}

beforeEach(() => {
  mocks.requireMaterializedSession.mockReset().mockReturnValue({ ok: true, session: { uid: VIEWER } });
  mocks.getServerById.mockReset().mockResolvedValue({ id: SERVER, ownerUserId: 'someone-else' });
  mocks.isServerMember.mockReset().mockResolvedValue(true);
  mocks.listMemberSummariesForServer.mockReset().mockResolvedValue([summary(ALICE)]);
});

describe('GET /api/servers/{id}/lobby-members', () => {
  it('reads only the named members, projected for the viewer, and lists the ones that are gone', async () => {
    const res = await get(`?ids=${ALICE},${GONE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mocks.listMemberSummariesForServer).toHaveBeenCalledWith({ __db: true }, SERVER, { userIds: [ALICE, GONE] });
    expect(body.missing).toEqual([GONE]);
    expect(body.members[0]).toMatchObject({
      id: ALICE,
      name: 'Alice',
      username: 'alice',
      pronouns: 'she/her',
      accentColor: '#5865f2',
      status: 'offline',
      avatarUrl: `/api/users/${ALICE}/avatar?v=0123456789ab`,
    });
  });

  it('a hidden profile loses its details but keeps its name and handle', async () => {
    mocks.listMemberSummariesForServer.mockResolvedValue([summary(ALICE, { profileVisibility: 'nobody' })]);
    const body = await (await get(`?ids=${ALICE}`)).json();
    expect(body.members[0]).toMatchObject({ name: 'Alice', username: 'alice', avatarUrl: null, bio: null, pronouns: null, accentColor: null });
  });

  it('without ids: everyone', async () => {
    await get();
    expect(mocks.listMemberSummariesForServer).toHaveBeenCalledWith({ __db: true }, SERVER, {});
  });

  it('refuses junk ids and oversized lists before touching the database', async () => {
    for (const query of ['?ids=', '?ids=nope', `?ids=${Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')}`]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(mocks.getServerById).not.toHaveBeenCalled();
  });

  it('one 404 for no such server and for a non-member', async () => {
    mocks.isServerMember.mockResolvedValue(false);
    expect((await get()).status).toBe(404);
    mocks.getServerById.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(mocks.listMemberSummariesForServer).not.toHaveBeenCalled();
  });
});
