import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeChannelMessageAccess: vi.fn(),
  isUserBlocked: vi.fn(),
  publishUserEvent: vi.fn(async (_userId: string, _payload: unknown) => {}),
}));
vi.mock('@/lib/message-authorization', () => ({ authorizeChannelMessageAccess: mocks.authorizeChannelMessageAccess }));
vi.mock('@lobbyforge/db', () => ({ isUserBlocked: mocks.isUserBlocked }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __db: true }) }));
vi.mock('@/lib/bots/events', () => ({ publishUserEvent: mocks.publishUserEvent }));

import { notifyMentionedMembers } from '@/lib/mention-notify';

const base = { serverId: 's1', channelId: 'c1', messageId: 'm1', authorId: 'author' };

beforeEach(() => {
  mocks.authorizeChannelMessageAccess.mockReset().mockResolvedValue({ ok: true });
  mocks.isUserBlocked.mockReset().mockResolvedValue(false);
  mocks.publishUserEvent.mockClear();
});

describe('notifyMentionedMembers (docs/PROFILES.md "Mentions")', () => {
  it('tells each named member on their own feed — ids only, no text — once each', async () => {
    notifyMentionedMembers({
      ...base,
      mentions: [
        { userId: 'u1', text: 'Ada' },
        { userId: 'u1', text: 'ada' },
        { userId: 'u2', text: 'Bob' },
      ],
    });
    await vi.waitFor(() => expect(mocks.publishUserEvent).toHaveBeenCalledTimes(2));
    expect(mocks.publishUserEvent).toHaveBeenCalledWith('u1', {
      type: 'mention',
      serverId: 's1',
      channelId: 'c1',
      messageId: 'm1',
      fromUserId: 'author',
    });
    expect(mocks.authorizeChannelMessageAccess).toHaveBeenCalledWith({ userId: 'u2', serverId: 's1', channelId: 'c1', operation: 'read' });
  });

  it('never the author, nobody who cannot read the channel, nobody who blocked the author', async () => {
    mocks.authorizeChannelMessageAccess.mockImplementation(async ({ userId }: { userId: string }) => ({ ok: userId !== 'private' }));
    mocks.isUserBlocked.mockImplementation(async (_db: unknown, blocker: string) => blocker === 'blocker');
    notifyMentionedMembers({
      ...base,
      mentions: [
        { userId: 'author', text: 'Me' },
        { userId: 'private', text: 'P' },
        { userId: 'blocker', text: 'B' },
        { userId: 'ok', text: 'O' },
      ],
    });
    await vi.waitFor(() => expect(mocks.publishUserEvent).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.publishUserEvent).toHaveBeenCalledTimes(1);
    expect(mocks.publishUserEvent.mock.calls[0]![0]).toBe('ok');
  });
});
