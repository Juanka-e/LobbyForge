import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Poll messages (docs/CHAT_POLLS.md) in the ordinary message routes:
 *   - GET .../messages attaches each poll, projected for the viewer, with
 *     ONE batched query for the page (none when the page has no poll);
 *   - a member cannot forge `metadata.poll` on a plain message;
 *   - a poll message's text cannot be edited (pinning still works);
 *   - deleting a poll message deletes its poll and ballots;
 *   - GET .../messages/{id} carries the poll (the lobby refetches edits through it).
 */

const getServerById = vi.fn();
const isServerMember = vi.fn();
const getChannelById = vi.fn();
const getUserPermissions = vi.fn();
const canMemberAccessChannel = vi.fn();
const getActiveMemberTimeout = vi.fn();
const createMessage = vi.fn();
const listMessagesForChannel = vi.fn();
const getBlockedUserIds = vi.fn();
const getMessageById = vi.fn();
const updateMessage = vi.fn();
const softDeleteMessage = vi.fn();
const logAction = vi.fn();
const listMessagePollsForMessages = vi.fn();
const softDeletePollMessage = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  getChannelById,
  getUserPermissions,
  canMemberAccessChannel,
  getActiveMemberTimeout,
  createMessage,
  listMessagesForChannel,
  getBlockedUserIds,
  getMessageById,
  updateMessage,
  softDeleteMessage,
  logAction,
  listMessagePollsForMessages,
  softDeletePollMessage,
  getBuiltInBotForServer: vi.fn().mockResolvedValue(null),
  isChannelOpenToBots: vi.fn().mockResolvedValue(true),
  listUserDisplayNames: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return { ...actual, withApiSecurity: (handler: unknown) => handler };
});
vi.mock('@/lib/chat-bus', () => ({
  publishChatMessage: vi.fn(),
  publishChatMessageUpdate: vi.fn(),
  publishChatMessageDelete: vi.fn(),
}));
vi.mock('@/lib/bots/events', () => ({ emitMessageEvent: vi.fn() }));
vi.mock('@/lib/mail/verification', () => ({ requireVerifiedEmail: vi.fn().mockResolvedValue(null) }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const OWNER = '44444444-4444-4444-8444-444444444444';
const AUTHOR = '33333333-3333-4333-8333-333333333333';
const VIEWER = '77777777-7777-4777-8777-777777777777';
const OTHER_VOTER = '55555555-5555-4555-8555-555555555555';
const HOUR = 60 * 60_000;

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    channelId: CHANNEL,
    userId: AUTHOR,
    botId: null,
    content: 'hello',
    metadata: {},
    replyToId: null,
    createdAt: new Date('2026-10-10T10:00:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function pollTally(messageId: string, pollId: string, viewerChoices: number[]) {
  return {
    id: pollId,
    messageId,
    channelId: CHANNEL,
    creatorUserId: AUTHOR,
    question: 'Pizza?',
    options: ['Yes', 'No'],
    allowMultiple: false,
    closesAt: new Date(Date.now() + HOUR),
    closedAt: null,
    closedByUserId: null,
    version: 4,
    createdAt: new Date(),
    counts: [3, 1],
    totalVoters: 4,
    viewerChoices,
  };
}

const ctx = { params: Promise.resolve({ id: SERVER, channelId: CHANNEL }) };
const itemCtx = { params: Promise.resolve({ id: SERVER, channelId: CHANNEL, messageId: 'poll-msg' }) };

function req(uid: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://chat.example.test/api/servers/${SERVER}/channels/${CHANNEL}/messages`, {
    method,
    headers: { cookie: cookie(uid), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [getServerById, isServerMember, getChannelById, getUserPermissions, canMemberAccessChannel, getActiveMemberTimeout, createMessage, listMessagesForChannel, getBlockedUserIds, getMessageById, updateMessage, softDeleteMessage, logAction, listMessagePollsForMessages, softDeletePollMessage]) {
    fn.mockReset();
  }
  getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  isServerMember.mockResolvedValue(true);
  getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'text', name: 'general' });
  getUserPermissions.mockImplementation(async (_db: unknown, uid: string) =>
    uid === OWNER ? ['administrator'] : ['send_messages', 'read_message_history']
  );
  canMemberAccessChannel.mockResolvedValue(true);
  getActiveMemberTimeout.mockResolvedValue(null);
  getBlockedUserIds.mockResolvedValue(new Set());
  logAction.mockResolvedValue(undefined);
  softDeleteMessage.mockResolvedValue(undefined);
  softDeletePollMessage.mockResolvedValue(undefined);
  createMessage.mockImplementation(async (_db: unknown, row: Record<string, unknown>) => messageRow({ id: 'msg-new', ...row }));
});

describe('GET .../messages with polls', () => {
  it('attaches each poll for the viewer with ONE batched query, and leaves plain messages alone', async () => {
    listMessagesForChannel.mockResolvedValue([
      messageRow({ id: 'p2', content: 'Pizza?', metadata: { poll: { id: 'poll-2' } } }),
      messageRow({ id: 'm1' }),
      messageRow({ id: 'p1', content: 'Pizza?', metadata: { poll: { id: 'poll-1' } } }),
    ]);
    listMessagePollsForMessages.mockResolvedValue(
      new Map([
        ['p1', pollTally('p1', 'poll-1', [0])],
        ['p2', pollTally('p2', 'poll-2', [])],
      ])
    );
    const { GET } = await import('../route.js');
    const res = await GET(req(VIEWER), ctx);
    expect(res.status).toBe(200);
    expect(listMessagePollsForMessages).toHaveBeenCalledTimes(1);
    expect(listMessagePollsForMessages.mock.calls[0]!.slice(1)).toEqual([['p2', 'p1'], VIEWER]);

    const { messages } = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(messages[0]!.poll).toMatchObject({ id: 'poll-2', resultsVisible: false, options: [{ votes: null }, { votes: null }], totalVoters: 4 });
    expect(messages[1]).not.toHaveProperty('poll');
    expect(messages[2]!.poll).toMatchObject({ id: 'poll-1', resultsVisible: true, myChoices: [0], options: [{ votes: 3 }, { votes: 1 }] });
    expect(JSON.stringify(messages)).not.toContain(OTHER_VOTER);
  });

  it('runs no poll query for a page without polls', async () => {
    listMessagesForChannel.mockResolvedValue([messageRow({ id: 'm1' }), messageRow({ id: 'm2' })]);
    const { GET } = await import('../route.js');
    expect((await GET(req(VIEWER), ctx)).status).toBe(200);
    expect(listMessagePollsForMessages).not.toHaveBeenCalled();
  });

  it('a blocked author’s poll stays out with their words', async () => {
    listMessagesForChannel.mockResolvedValue([messageRow({ id: 'p1', metadata: { poll: { id: 'poll-1' } } })]);
    listMessagePollsForMessages.mockResolvedValue(new Map([['p1', pollTally('p1', 'poll-1', [])]]));
    getBlockedUserIds.mockResolvedValue(new Set([AUTHOR]));
    const { GET } = await import('../route.js');
    const { messages } = (await (await GET(req(VIEWER), ctx)).json()) as { messages: Array<Record<string, unknown>> };
    expect(messages[0]).toMatchObject({ blocked: true, poll: null });
  });
});

describe('POST .../messages', () => {
  it('refuses a hand-made metadata.poll — only the poll route writes it', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(req(VIEWER, 'POST', { content: 'not a poll', metadata: { poll: { id: 'forged' } } }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ key: 'poll' });
    expect(createMessage).not.toHaveBeenCalled();
  });
});

describe('a poll message in the single-message route', () => {
  const pollMessage = () => messageRow({ id: 'poll-msg', content: 'Pizza?', metadata: { poll: { id: 'poll-1' } } });

  it('refuses a content edit, even by its author; pinning still works', async () => {
    getMessageById.mockResolvedValue(pollMessage());
    updateMessage.mockImplementation(async (_db: unknown, _id: string, patch: Record<string, unknown>) => ({ ...pollMessage(), ...patch }));
    const { PATCH } = await import('../[messageId]/route.js');
    const edit = await PATCH(req(AUTHOR, 'PATCH', { content: 'Pineapple?' }), itemCtx);
    expect(edit.status).toBe(403);
    expect(await edit.json()).toMatchObject({ code: 'poll_message_readonly' });
    expect(updateMessage).not.toHaveBeenCalled();

    const pin = await PATCH(req(OWNER, 'PATCH', { pinned: true }), itemCtx);
    expect(pin.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  it('deleting it deletes the message and the poll (with its ballots) together', async () => {
    getMessageById.mockResolvedValue(pollMessage());
    const { DELETE } = await import('../[messageId]/route.js');
    expect((await DELETE(req(AUTHOR, 'DELETE'), itemCtx)).status).toBe(200);
    expect(softDeletePollMessage).toHaveBeenCalledWith(expect.anything(), 'poll-msg');
    expect(softDeleteMessage).not.toHaveBeenCalled();
  });

  it('if that transaction fails, the delete fails — no message is gone while its ballots stay', async () => {
    getMessageById.mockResolvedValue(pollMessage());
    softDeletePollMessage.mockRejectedValue(new Error('db down'));
    const { DELETE } = await import('../[messageId]/route.js');
    expect((await DELETE(req(AUTHOR, 'DELETE'), itemCtx)).status).toBe(500);
  });

  it('deleting a plain message touches no poll', async () => {
    getMessageById.mockResolvedValue(messageRow({ id: 'poll-msg' }));
    const { DELETE } = await import('../[messageId]/route.js');
    expect((await DELETE(req(AUTHOR, 'DELETE'), itemCtx)).status).toBe(200);
    expect(softDeleteMessage).toHaveBeenCalledWith(expect.anything(), 'poll-msg');
    expect(softDeletePollMessage).not.toHaveBeenCalled();
  });

  it('GET carries the poll as this viewer sees it', async () => {
    getMessageById.mockResolvedValue(pollMessage());
    listMessagePollsForMessages.mockResolvedValue(new Map([['poll-msg', pollTally('poll-msg', 'poll-1', [1])]]));
    const { GET } = await import('../[messageId]/route.js');
    const res = await GET(req(VIEWER), itemCtx);
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as { message: Record<string, unknown> };
    expect(message.poll).toMatchObject({ id: 'poll-1', myChoices: [1], options: [{ votes: 3 }, { votes: 1 }] });
  });
});
