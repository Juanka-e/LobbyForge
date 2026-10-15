import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMemberSummariesForServer, findMembersByUsernames } = vi.hoisted(() => ({
  listMemberSummariesForServer: vi.fn(),
  findMembersByUsernames: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => ({ listMemberSummariesForServer, findMembersByUsernames }));

import { resolveMessageMentions } from '@/lib/message-mentions-server';

const DB = {} as never;

function member(userId: string, globalDisplayName: string, extra: Record<string, unknown> = {}) {
  return { userId, globalDisplayName, displayName: globalDisplayName, nickname: null, username: null, ...extra };
}

beforeEach(() => {
  listMemberSummariesForServer.mockReset().mockResolvedValue([]);
  findMembersByUsernames.mockReset().mockResolvedValue([]);
});

describe('resolveMessageMentions', () => {
  it('keeps a pick that is a member and whose name is in the text — nickname, account name or handle', async () => {
    listMemberSummariesForServer.mockResolvedValue([
      member('u1', 'Ada Lovelace', { nickname: 'Countess' }),
      member('u2', 'Bob'),
      member('u3', 'Cem', { username: 'cem_k' }),
    ]);
    const mentions = await resolveMessageMentions(DB, 's1', 'thanks @Countess and @Bob and @cem_k', ['u1', 'u2', 'u3']);
    expect(mentions).toEqual([
      { userId: 'u1', text: 'Countess' },
      { userId: 'u2', text: 'Bob' },
      { userId: 'u3', text: 'cem_k' },
    ]);
    expect(listMemberSummariesForServer).toHaveBeenCalledWith(DB, 's1', { userIds: ['u1', 'u2', 'u3'] });
  });

  it('drops a pick whose name was deleted from the text, and an id that is not a member', async () => {
    listMemberSummariesForServer.mockResolvedValue([member('u2', 'Bob')]);
    expect(await resolveMessageMentions(DB, 's1', 'never mind', ['u2', 'stranger'])).toEqual([]);
  });

  it('a typed @handle of a member names them without a pick; an unknown handle names nobody', async () => {
    findMembersByUsernames.mockResolvedValue([{ userId: 'u9', username: 'ada' }]);
    expect(await resolveMessageMentions(DB, 's1', 'hey @Ada. and @nobody', [])).toEqual([{ userId: 'u9', text: 'ada' }]);
    expect(findMembersByUsernames).toHaveBeenCalledWith(DB, 's1', ['ada', 'nobody']);
    expect(listMemberSummariesForServer).not.toHaveBeenCalled();
  });

  it('one entry per member, the pick first', async () => {
    listMemberSummariesForServer.mockResolvedValue([member('u1', 'Ada', { username: 'ada' })]);
    findMembersByUsernames.mockResolvedValue([{ userId: 'u1', username: 'ada' }]);
    expect(await resolveMessageMentions(DB, 's1', '@Ada', ['u1'])).toEqual([{ userId: 'u1', text: 'Ada' }]);
  });

  it('no picks and no handles: no database reads', async () => {
    expect(await resolveMessageMentions(DB, 's1', 'plain words, @everyone', [])).toEqual([]);
    expect(listMemberSummariesForServer).not.toHaveBeenCalled();
    expect(findMembersByUsernames).not.toHaveBeenCalled();
  });
});
