import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Polls in text channels (docs/CHAT_POLLS.md): the create, read, vote and
 * close routes — the real routes, the real permission and channel-access
 * helpers and the real Moderation Bot; the database, the realtime bus, the
 * bot event fan-out and the email gate are mocked.
 */

const h = vi.hoisted(() => ({ requireVerifiedEmail: vi.fn() }));

const getServerById = vi.fn();
const isServerMember = vi.fn();
const getChannelById = vi.fn();
const getUserPermissions = vi.fn();
const canMemberAccessChannel = vi.fn();
const getActiveMemberTimeout = vi.fn();
const getBlockedUserIds = vi.fn();
const logAction = vi.fn();
const getBuiltInBotForServer = vi.fn();
const isChannelOpenToBots = vi.fn();
const createMessagePoll = vi.fn();
const getMessagePollById = vi.fn();
const getMessagePollWithTally = vi.fn();
const setMessagePollVote = vi.fn();
const clearMessagePollVote = vi.fn();
const closeMessagePoll = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getServerById,
  isServerMember,
  getChannelById,
  getUserPermissions,
  canMemberAccessChannel,
  getActiveMemberTimeout,
  getBlockedUserIds,
  logAction,
  getBuiltInBotForServer,
  isChannelOpenToBots,
  listUserDisplayNames: vi.fn().mockResolvedValue(new Map()),
  touchBotLastUsed: vi.fn().mockResolvedValue(undefined),
  createMessagePoll,
  getMessagePollById,
  getMessagePollWithTally,
  setMessagePollVote,
  clearMessagePollVote,
  closeMessagePoll,
  listMessagePollsForMessages: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return { ...actual, withApiSecurity: (handler: unknown) => handler };
});
const publishChatMessage = vi.fn();
const publishChatPollUpdate = vi.fn();
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage, publishChatPollUpdate }));
const emitMessageEvent = vi.fn();
vi.mock('@/lib/bots/events', () => ({ emitMessageEvent }));
vi.mock('@/lib/mail/verification', () => ({ requireVerifiedEmail: h.requireVerifiedEmail }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const OTHER_CHANNEL = '23232323-2323-4232-8232-232323232323';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MOD = '55555555-5555-4555-8555-555555555555';
const POLLER = '33333333-3333-4333-8333-333333333333';
const MEMBER = '77777777-7777-4777-8777-777777777777';
const READER = '88888888-8888-4888-8888-888888888888';
const OUTSIDER = '66666666-6666-4666-8666-666666666666';
const POLL = '99999999-9999-4999-8999-999999999999';
const MESSAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const PERMS: Record<string, string[]> = {
  [OWNER]: ['administrator'],
  [MOD]: ['send_messages', 'read_message_history', 'manage_messages', 'create_polls'],
  [POLLER]: ['send_messages', 'read_message_history', 'create_polls'],
  [MEMBER]: ['send_messages', 'read_message_history'],
  [READER]: ['read_message_history'],
};

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function request(uid: string, method: string, body?: unknown): Request {
  return new Request(`https://chat.example.test/api/servers/${SERVER}/channels/${CHANNEL}/polls`, {
    method,
    headers: { cookie: cookie(uid), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

const listCtx = { params: Promise.resolve({ id: SERVER, channelId: CHANNEL }) };
const pollCtx = (channelId = CHANNEL) => ({ params: Promise.resolve({ id: SERVER, channelId, pollId: POLL }) });

const HOUR = 60 * 60_000;

function pollRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLL,
    messageId: MESSAGE,
    channelId: CHANNEL,
    creatorUserId: POLLER,
    question: 'What should we play?',
    options: ['Hushle', 'Quiz', 'Vampire Village'],
    allowMultiple: false,
    closesAt: new Date(Date.now() + 24 * HOUR),
    closedAt: null,
    closedByUserId: null,
    version: 7,
    createdAt: new Date(Date.now() - HOUR),
    ...overrides,
  };
}

function tally(overrides: Record<string, unknown> = {}) {
  return { ...pollRow(), counts: [2, 0, 1], totalVoters: 3, viewerChoices: [], ...overrides };
}

const goodPoll = { question: 'What should we play?', options: ['Hushle', 'Quiz'], allowMultiple: false, durationHours: 4 };

function moderationBot() {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Mod',
    type: 'moderation',
    tokenHash: null,
    permissions: ['read_messages', 'moderate_messages', 'send_messages'],
    settings: { blockedWords: ['salak*'], flood: null, repeat: null, exemptStaff: false },
    enabled: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [
    getServerById, isServerMember, getChannelById, getUserPermissions, canMemberAccessChannel, getActiveMemberTimeout,
    getBlockedUserIds, logAction, getBuiltInBotForServer, isChannelOpenToBots, createMessagePoll, getMessagePollById,
    getMessagePollWithTally, setMessagePollVote, clearMessagePollVote, closeMessagePoll, publishChatMessage,
    publishChatPollUpdate, emitMessageEvent, h.requireVerifiedEmail,
  ]) {
    fn.mockReset();
  }
  h.requireVerifiedEmail.mockResolvedValue(null);
  getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid in PERMS);
  getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'text', name: 'general' });
  getUserPermissions.mockImplementation(async (_db: unknown, uid: string) => PERMS[uid] ?? []);
  canMemberAccessChannel.mockResolvedValue(true);
  getActiveMemberTimeout.mockResolvedValue(null);
  getBlockedUserIds.mockResolvedValue(new Set());
  logAction.mockResolvedValue(undefined);
  getBuiltInBotForServer.mockResolvedValue(null);
  isChannelOpenToBots.mockResolvedValue(true);
  createMessagePoll.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    message: {
      id: MESSAGE,
      channelId: CHANNEL,
      userId: input.userId,
      botId: null,
      content: input.question,
      metadata: { poll: { id: POLL } },
      replyToId: null,
      createdAt: new Date(),
      editedAt: null,
      deletedAt: null,
    },
    poll: pollRow({
      creatorUserId: input.userId,
      question: input.question,
      options: input.options,
      allowMultiple: input.allowMultiple,
      closesAt: input.closesAt,
    }),
  }));
  getMessagePollById.mockResolvedValue(pollRow());
  getMessagePollWithTally.mockImplementation(async (_db: unknown, _id: string, viewer: string) =>
    tally({ viewerChoices: viewer === MEMBER ? [0] : [] })
  );
  setMessagePollVote.mockResolvedValue({ ok: true });
  clearMessagePollVote.mockResolvedValue({ ok: true });
  closeMessagePoll.mockImplementation(async () => ({ ok: true, poll: pollRow({ closedAt: new Date(), closedByUserId: POLLER }) }));
});

describe('POST .../polls — who may post', () => {
  it('posts a poll for a member with Create Polls: one message + poll, a message event, a bot event with the question', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', goodPoll), listCtx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { id: string; content: string; metadata: unknown }; poll: Record<string, unknown> };
    expect(body.message).toMatchObject({ id: MESSAGE, content: 'What should we play?', metadata: { poll: { id: POLL } } });
    expect(body.poll).toMatchObject({
      id: POLL,
      messageId: MESSAGE,
      question: 'What should we play?',
      options: [{ text: 'Hushle', votes: null }, { text: 'Quiz', votes: null }],
      totalVoters: 0,
      myChoices: [],
      resultsVisible: false,
      closed: false,
    });
    const input = createMessagePoll.mock.calls[0]![1] as { closesAt: Date; allowMultiple: boolean };
    expect(input.closesAt.getTime() - Date.now()).toBeGreaterThan(4 * HOUR - 60_000);
    expect(input.closesAt.getTime() - Date.now()).toBeLessThanOrEqual(4 * HOUR);
    expect(publishChatMessage).toHaveBeenCalledTimes(1);
    expect(publishChatMessage.mock.calls[0]![0]).toMatchObject({ message: { id: MESSAGE, poll: { id: POLL } } });
    expect(emitMessageEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'message_create', message: expect.objectContaining({ content: 'What should we play?' }) }));
    expect(logAction.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(['poll.create']);
  });

  it('the owner and moderator roles may post; a member without Create Polls may not', async () => {
    const { POST } = await import('../route.js');
    expect((await POST(request(OWNER, 'POST', goodPoll), listCtx)).status).toBe(201);
    expect((await POST(request(MOD, 'POST', goodPoll), listCtx)).status).toBe(201);
    const refused = await POST(request(MEMBER, 'POST', goodPoll), listCtx);
    expect(refused.status).toBe(403);
    expect(createMessagePoll).toHaveBeenCalledTimes(2);
  });

  it('Create Polls is not enough without Send Messages, and outsiders are refused', async () => {
    PERMS[READER] = ['read_message_history', 'create_polls'];
    try {
      const { POST } = await import('../route.js');
      expect((await POST(request(READER, 'POST', goodPoll), listCtx)).status).toBe(403);
      expect((await POST(request(OUTSIDER, 'POST', goodPoll), listCtx)).status).toBe(403);
      expect(createMessagePoll).not.toHaveBeenCalled();
    } finally {
      PERMS[READER] = ['read_message_history'];
    }
  });

  it('only in text and announcement channels', async () => {
    const { POST } = await import('../route.js');
    getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'announcement', name: 'news' });
    expect((await POST(request(POLLER, 'POST', goodPoll), listCtx)).status).toBe(201);
    for (const type of ['voice', 'stage', 'activity']) {
      getChannelById.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type, name: 'room' });
      const res = await POST(request(POLLER, 'POST', goodPoll), listCtx);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'poll_channel_type' });
    }
    expect(createMessagePoll).toHaveBeenCalledTimes(1);
  });

  it('a timed-out member cannot post a poll', async () => {
    getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + HOUR));
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', goodPoll), listCtx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'You are timed out in this server' });
    expect(createMessagePoll).not.toHaveBeenCalled();
  });

  it('an unverified account in required mode is refused before anything else (the message gate)', async () => {
    h.requireVerifiedEmail.mockResolvedValue(NextResponse.json({ error: 'email_unverified' }, { status: 403 }));
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', goodPoll), listCtx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'email_unverified' });
    expect(h.requireVerifiedEmail).toHaveBeenCalledWith(POLLER, 'message');
    expect(getServerById).not.toHaveBeenCalled();
  });

  it('@everyone in a poll needs Mention Everyone, like a message', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', { ...goodPoll, options: ['@everyone yes', 'no'] }), listCtx);
    expect(res.status).toBe(403);
    expect(createMessagePoll).not.toHaveBeenCalled();
  });
});

describe('POST .../polls — validation', () => {
  it.each([
    ['an empty question', { ...goodPoll, question: '   ' }],
    ['a question over 300 characters', { ...goodPoll, question: 'q'.repeat(301) }],
    ['one option', { ...goodPoll, options: ['Only'] }],
    ['eleven options', { ...goodPoll, options: Array.from({ length: 11 }, (_, i) => `Option ${i}`) }],
    ['a blank option', { ...goodPoll, options: ['A', '  '] }],
    ['an option over 80 characters', { ...goodPoll, options: ['A', 'b'.repeat(81)] }],
    ['an unknown duration', { ...goodPoll, durationHours: 2 }],
    ['an unknown field', { ...goodPoll, metadata: { poll: { id: 'forged' } } }],
    ['a non-JSON body', 'not json'],
  ])('refuses %s', async (_label, body) => {
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', body), listCtx);
    expect(res.status).toBe(400);
    expect(createMessagePoll).not.toHaveBeenCalled();
  });

  it('refuses options that repeat each other after trim and case-fold', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', { ...goodPoll, options: ['Pizza', '  PIZZA '] }), listCtx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'poll_duplicate_option' });
  });

  it('trims what it stores and defaults to single choice for 24 hours', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', { question: '  Pizza?  ', options: [' Yes ', 'No'] }), listCtx);
    expect(res.status).toBe(201);
    const input = createMessagePoll.mock.calls[0]![1] as { question: string; options: string[]; allowMultiple: boolean; closesAt: Date };
    expect(input).toMatchObject({ question: 'Pizza?', options: ['Yes', 'No'], allowMultiple: false });
    expect(Math.round((input.closesAt.getTime() - Date.now()) / HOUR)).toBe(24);
  });
});

describe('POST .../polls — the Moderation Bot', () => {
  it('judges the question and every option like a message, and blocks a hit with the same 422', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot());
    const { POST } = await import('../route.js');
    const res = await POST(request(POLLER, 'POST', { ...goodPoll, options: ['fine', 'sen salaksın'] }), listCtx);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'blocked_by_moderation', rule: 'blocked_word', bot: { id: BOT_ID } });
    expect(createMessagePoll).not.toHaveBeenCalled();
    expect(publishChatMessage).not.toHaveBeenCalled();
    expect(logAction.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(['bot.moderation.block']);
  });

  it('lets a clean poll through', async () => {
    getBuiltInBotForServer.mockResolvedValue(moderationBot());
    const { POST } = await import('../route.js');
    expect((await POST(request(POLLER, 'POST', goodPoll), listCtx)).status).toBe(201);
  });
});

describe('GET .../polls/{pollId}', () => {
  it('a member who has not voted sees the options and the voter total, no counts', async () => {
    const { GET } = await import('../[pollId]/route.js');
    const res = await GET(request(POLLER, 'GET'), pollCtx());
    expect(res.status).toBe(200);
    const { poll } = (await res.json()) as { poll: Record<string, unknown> };
    expect(poll).toMatchObject({
      options: [{ text: 'Hushle', votes: null }, { text: 'Quiz', votes: null }, { text: 'Vampire Village', votes: null }],
      totalVoters: 3,
      myChoices: [],
      resultsVisible: false,
    });
  });

  it('a voter sees the counts and their own choice; everyone sees the counts once closed', async () => {
    const { GET } = await import('../[pollId]/route.js');
    const voted = (await (await GET(request(MEMBER, 'GET'), pollCtx())).json()) as { poll: Record<string, unknown> };
    expect(voted.poll).toMatchObject({ options: [{ votes: 2 }, { votes: 0 }, { votes: 1 }], myChoices: [0], resultsVisible: true });

    getMessagePollWithTally.mockResolvedValue(tally({ closesAt: new Date(Date.now() - 1000) }));
    const closed = (await (await GET(request(POLLER, 'GET'), pollCtx())).json()) as { poll: Record<string, unknown> };
    expect(closed.poll).toMatchObject({ closed: true, resultsVisible: true, options: [{ votes: 2 }, { votes: 0 }, { votes: 1 }] });
  });

  it('a poll from another channel, or one the member cannot read, is not found / forbidden', async () => {
    const { GET } = await import('../[pollId]/route.js');
    getMessagePollById.mockResolvedValue(pollRow({ channelId: OTHER_CHANNEL }));
    expect((await GET(request(MEMBER, 'GET'), pollCtx())).status).toBe(404);
    getMessagePollById.mockResolvedValue(null);
    expect((await GET(request(MEMBER, 'GET'), pollCtx())).status).toBe(404);
    getMessagePollById.mockResolvedValue(pollRow());
    canMemberAccessChannel.mockResolvedValue(false);
    expect((await GET(request(MEMBER, 'GET'), pollCtx())).status).toBe(403);
  });
});

describe('the projection never names a voter', () => {
  it('drops anything but counts and the caller’s own choices, in the answer and in the realtime update', async () => {
    // Even if a query handed the route more than it should, none of it leaves.
    getMessagePollWithTally.mockResolvedValue({
      ...tally({ viewerChoices: [1] }),
      ballots: [{ userId: MOD, optionIndex: 0 }, { userId: OWNER, optionIndex: 2 }],
      voterIds: [MOD, OWNER],
    });
    const { PUT } = await import('../[pollId]/vote/route.js');
    const res = await PUT(request(MEMBER, 'PUT', { choices: [1] }), pollCtx());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(MOD);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(POLLER); // not even the creator
    const { poll } = JSON.parse(text) as { poll: Record<string, unknown> };
    expect(Object.keys(poll).sort()).toEqual(
      ['allowMultiple', 'closedAt', 'closed', 'closesAt', 'id', 'messageId', 'myChoices', 'options', 'question', 'resultsVisible', 'totalVoters', 'version'].sort()
    );
    expect(publishChatPollUpdate).toHaveBeenCalledTimes(1);
    const update = publishChatPollUpdate.mock.calls[0]![0] as { poll: Record<string, unknown> };
    expect(Object.keys(update.poll).sort()).toEqual(['closed', 'closedAt', 'closesAt', 'counts', 'id', 'messageId', 'totalVoters', 'version']);
    expect(JSON.stringify(update)).not.toMatch(new RegExp(`${MOD}|${OWNER}|${MEMBER}|${POLLER}`));
    expect(update.poll).toMatchObject({ counts: [2, 0, 1], totalVoters: 3, version: 7 });
  });
});

describe('PUT/DELETE .../polls/{pollId}/vote', () => {
  it('any member who can read the channel may vote — without Send Messages or Create Polls', async () => {
    const { PUT } = await import('../[pollId]/vote/route.js');
    const res = await PUT(request(READER, 'PUT', { choices: [2] }), pollCtx());
    expect(res.status).toBe(200);
    expect(setMessagePollVote).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pollId: POLL, userId: READER, optionIndexes: [2] }));
  });

  it('changing a vote replaces it; removing it clears it; both broadcast public counts', async () => {
    const { PUT, DELETE } = await import('../[pollId]/vote/route.js');
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(200);
    expect((await PUT(request(MEMBER, 'PUT', { choices: [1] }), pollCtx())).status).toBe(200);
    expect(setMessagePollVote.mock.calls.map((c) => (c[1] as { optionIndexes: number[] }).optionIndexes)).toEqual([[0], [1]]);
    expect((await DELETE(request(MEMBER, 'DELETE'), pollCtx())).status).toBe(200);
    expect(clearMessagePollVote).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pollId: POLL, userId: MEMBER }));
    expect(publishChatPollUpdate).toHaveBeenCalledTimes(3);
  });

  it('a single-choice poll takes exactly one answer', async () => {
    const { PUT } = await import('../[pollId]/vote/route.js');
    const res = await PUT(request(MEMBER, 'PUT', { choices: [0, 1] }), pollCtx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'vote_single_choice' });
    expect(setMessagePollVote).not.toHaveBeenCalled();
  });

  it('a multiple-choice poll takes up to every option, each once, each on the poll', async () => {
    getMessagePollById.mockResolvedValue(pollRow({ allowMultiple: true }));
    const { PUT } = await import('../[pollId]/vote/route.js');
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0, 2] }), pollCtx())).status).toBe(200);
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0, 1, 2] }), pollCtx())).status).toBe(200);
    const duplicate = await PUT(request(MEMBER, 'PUT', { choices: [1, 1] }), pollCtx());
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ code: 'vote_duplicate' });
    const outOfRange = await PUT(request(MEMBER, 'PUT', { choices: [0, 3] }), pollCtx());
    expect(outOfRange.status).toBe(400);
    expect(await outOfRange.json()).toMatchObject({ code: 'vote_out_of_range' });
    for (const body of [{ choices: [] }, { choices: [-1] }, { choices: [0.5] }, { choice: 0 }]) {
      expect((await PUT(request(MEMBER, 'PUT', body), pollCtx())).status).toBe(400);
    }
    expect(setMessagePollVote).toHaveBeenCalledTimes(2);
  });

  it('refuses a vote or a removal once the poll has closed (409) — expired, closed early, or lost to a race', async () => {
    const { PUT, DELETE } = await import('../[pollId]/vote/route.js');
    getMessagePollById.mockResolvedValue(pollRow({ closesAt: new Date(Date.now() - 1000) }));
    const expired = await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx());
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ code: 'poll_closed' });
    getMessagePollById.mockResolvedValue(pollRow({ closedAt: new Date() }));
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(409);
    expect((await DELETE(request(MEMBER, 'DELETE'), pollCtx())).status).toBe(409);
    expect(setMessagePollVote).not.toHaveBeenCalled();

    getMessagePollById.mockResolvedValue(pollRow());
    setMessagePollVote.mockResolvedValue({ ok: false, reason: 'closed' });
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(409);
    expect(publishChatPollUpdate).not.toHaveBeenCalled();
  });

  it('a timed-out member cannot vote; neither can an unverified account in required mode', async () => {
    const { PUT } = await import('../[pollId]/vote/route.js');
    getActiveMemberTimeout.mockResolvedValue(new Date(Date.now() + HOUR));
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(403);
    getActiveMemberTimeout.mockResolvedValue(null);
    h.requireVerifiedEmail.mockResolvedValue(NextResponse.json({ error: 'email_unverified' }, { status: 403 }));
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(403);
    expect(h.requireVerifiedEmail).toHaveBeenCalledWith(MEMBER, 'reaction');
    expect(setMessagePollVote).not.toHaveBeenCalled();
  });

  it('outsiders, hidden channels and polls of another channel are refused', async () => {
    const { PUT } = await import('../[pollId]/vote/route.js');
    expect((await PUT(request(OUTSIDER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(403);
    canMemberAccessChannel.mockResolvedValue(false);
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(403);
    canMemberAccessChannel.mockResolvedValue(true);
    getMessagePollById.mockResolvedValue(pollRow({ channelId: OTHER_CHANNEL }));
    expect((await PUT(request(MEMBER, 'PUT', { choices: [0] }), pollCtx())).status).toBe(404);
    expect(setMessagePollVote).not.toHaveBeenCalled();
  });
});

describe('POST .../polls/{pollId}/close', () => {
  it('the creator closes their poll: final results for them, a broadcast, an audit entry', async () => {
    getMessagePollWithTally.mockResolvedValue(tally({ closedAt: new Date() }));
    const { POST } = await import('../[pollId]/close/route.js');
    const res = await POST(request(POLLER, 'POST'), pollCtx());
    expect(res.status).toBe(200);
    const { poll } = (await res.json()) as { poll: Record<string, unknown> };
    expect(poll).toMatchObject({ closed: true, resultsVisible: true, options: [{ votes: 2 }, { votes: 0 }, { votes: 1 }] });
    expect(publishChatPollUpdate.mock.calls[0]![0]).toMatchObject({ poll: { id: POLL, closed: true } });
    expect(logAction.mock.calls.map((c) => (c[1] as { action: string; metadata: Record<string, unknown> }))).toEqual([
      expect.objectContaining({ action: 'poll.close', metadata: expect.objectContaining({ byCreator: true }) }),
    ]);
  });

  it('a member with Manage Messages and the owner may close anyone’s poll; another member may not', async () => {
    const { POST } = await import('../[pollId]/close/route.js');
    expect((await POST(request(MOD, 'POST'), pollCtx())).status).toBe(200);
    expect((await POST(request(OWNER, 'POST'), pollCtx())).status).toBe(200);
    const refused = await POST(request(MEMBER, 'POST'), pollCtx());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'poll_close_forbidden' });
    expect(closeMessagePoll).toHaveBeenCalledTimes(2);
  });

  it('a poll that has already closed answers 409', async () => {
    closeMessagePoll.mockResolvedValue({ ok: false, reason: 'closed' });
    const { POST } = await import('../[pollId]/close/route.js');
    const res = await POST(request(POLLER, 'POST'), pollCtx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'poll_closed' });
    expect(publishChatPollUpdate).not.toHaveBeenCalled();
  });
});
