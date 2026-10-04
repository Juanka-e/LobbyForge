import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBotToken, hashBotToken } from '@/lib/bots/token';

/**
 * Bot API v1 — authentication, permissions, server isolation, limits and
 * the happy paths. The real pipeline (the shared machine boundary + bot
 * auth) and the in-memory rate limiter run; only the database, the
 * realtime bus and the maintenance lookup are replaced.
 */

const getActiveBotById = vi.fn();
const getChannelById = vi.fn();
const isChannelOpenToBots = vi.fn();
const listBotAccessibleChannels = vi.fn();
// Bot API v2 §1.1: every route asks the ONE access rule in @lobbyforge/db.
const getBotReachableChannel = vi.fn();
const listBotReachableChannels = vi.fn();
const listBotEventTargets = vi.fn();
const listBotChannelAccessForServer = vi.fn();
/** Explicit channel grants of the test bot ([] = none: the v1 rule). */
let grants: string[] = [];
const listMessagesForChannel = vi.fn();
const listUserDisplayNames = vi.fn();
const createMessage = vi.fn();
const logAction = vi.fn();
const touchBotLastUsed = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  BOT_MESSAGE_CHANNEL_TYPES: ['text', 'announcement'],
  getActiveBotById,
  getChannelById,
  isChannelOpenToBots,
  listBotAccessibleChannels,
  getBotReachableChannel,
  listBotReachableChannels,
  listBotEventTargets,
  listBotChannelAccessForServer,
  listMessagesForChannel,
  listUserDisplayNames,
  createMessage,
  logAction,
  touchBotLastUsed,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const publishChatMessage = vi.fn();
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage }));
const maintenanceResponseForRequest = vi.fn();
vi.mock('@/lib/maintenance-guard', () => ({ maintenanceResponseForRequest }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const OTHER_SERVER = '99999999-9999-4999-8999-999999999999';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '77777777-7777-4777-8777-777777777777';
const PRIVATE = '88888888-8888-4888-8888-888888888888';
const VOICE = '66666666-6666-4666-8666-666666666666';
const MEMBER = '33333333-3333-4333-8333-333333333333';

let token: string;

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Announcer',
    type: 'custom',
    tokenHash: hashBotToken(token),
    tokenIssuedAt: new Date(),
    permissions: ['read_messages', 'send_messages'],
    settings: {},
    enabled: true,
    createdBy: MEMBER,
    createdByName: 'Owner',
    lastUsedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

const CHANNELS: Record<string, { id: string; serverId: string; type: string; name: string; position: number; topic: string | null }> = {
  [GENERAL]: { id: GENERAL, serverId: SERVER, type: 'text', name: 'general', position: 0, topic: null },
  [FOREIGN]: { id: FOREIGN, serverId: OTHER_SERVER, type: 'text', name: 'theirs', position: 0, topic: null },
  [PRIVATE]: { id: PRIVATE, serverId: SERVER, type: 'text', name: 'staff', position: 1, topic: null },
  [VOICE]: { id: VOICE, serverId: SERVER, type: 'voice', name: 'Lounge', position: 2, topic: null },
};

function request(method: string, path: string, init: { auth?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const auth = init.auth === undefined ? `Bot ${token}` : init.auth;
  if (auth) headers.authorization = auth;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://chat.example.test/api/bot/v1${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
  });
}

const messagesCtx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const noCtx = { params: Promise.resolve({}) };

async function routes() {
  return {
    me: await import('../me/route.js'),
    channels: await import('../channels/route.js'),
    messages: await import('../channels/[channelId]/messages/route.js'),
  };
}

beforeEach(() => {
  vi.resetModules();
  token = generateBotToken(BOT_ID).token;
  grants = [];
  for (const fn of [getBotReachableChannel, listBotReachableChannels, listBotEventTargets, listBotChannelAccessForServer]) fn.mockReset();
  for (const fn of [getActiveBotById, getChannelById, isChannelOpenToBots, listBotAccessibleChannels, listMessagesForChannel, listUserDisplayNames, createMessage, logAction, touchBotLastUsed, publishChatMessage, maintenanceResponseForRequest]) {
    fn.mockReset();
  }
  getActiveBotById.mockImplementation(async (_db: unknown, id: string) => (id === BOT_ID ? botRow() : null));
  getChannelById.mockImplementation(async (_db: unknown, id: string) => CHANNELS[id] ?? null);
  isChannelOpenToBots.mockImplementation(async (_db: unknown, id: string) => id !== PRIVATE);
  listBotAccessibleChannels.mockResolvedValue([CHANNELS[GENERAL]]);
  // The §1.1 rule over the fixtures: own server, text-like, then explicit
  // grants if any, else no role gate (PRIVATE is the gated one).
  const reaches = (bot: { serverId: string }, id: string) => {
    const c = CHANNELS[id];
    if (!c || c.serverId !== bot.serverId || !['text', 'announcement'].includes(c.type)) return null;
    if (grants.length > 0) return grants.includes(c.id) ? c : null;
    return c.id === PRIVATE ? null : c;
  };
  getBotReachableChannel.mockImplementation(async (_db: unknown, bot: { serverId: string }, id: string) => reaches(bot, id));
  listBotReachableChannels.mockImplementation(async (_db: unknown, bot: { serverId: string }) =>
    Object.keys(CHANNELS).map((id) => reaches(bot, id)).filter(Boolean)
  );
  listBotEventTargets.mockResolvedValue([]);
  listBotChannelAccessForServer.mockResolvedValue(new Map());
  listUserDisplayNames.mockResolvedValue(new Map([[MEMBER, 'Ayşe']]));
  logAction.mockResolvedValue(undefined);
  touchBotLastUsed.mockResolvedValue(undefined);
  maintenanceResponseForRequest.mockResolvedValue(null);
  createMessage.mockImplementation(async (_db: unknown, row: Record<string, unknown>) => ({
    id: 'msg-new',
    channelId: row.channelId,
    userId: row.userId,
    botId: row.botId,
    content: row.content,
    metadata: row.metadata,
    replyToId: null,
    createdAt: new Date('2026-09-28T12:00:00Z'),
    editedAt: null,
    deletedAt: null,
  }));
});

describe('authentication', () => {
  it('401 without a token, telling the caller the scheme', async () => {
    const { me } = await routes();
    const res = await me.GET(request('GET', '/me', { auth: null }), noCtx);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bot');
    expect(await res.json()).toMatchObject({ code: 'unauthorized' });
    expect(getActiveBotById).not.toHaveBeenCalled();
  });

  it('401 for another scheme, a malformed token, or a token in the URL', async () => {
    const { me } = await routes();
    for (const auth of [`Bearer ${token}`, 'Bot not-a-token', token]) {
      const res = await me.GET(request('GET', '/me', { auth }), noCtx);
      expect(res.status).toBe(401);
    }
    const inQuery = await me.GET(
      new Request(`https://chat.example.test/api/bot/v1/me?token=${token}`, { method: 'GET' }),
      noCtx
    );
    expect(inQuery.status).toBe(401);
  });

  it('401 for a wrong secret of a real bot', async () => {
    const { me } = await routes();
    const wrong = generateBotToken(BOT_ID).token;
    const res = await me.GET(request('GET', '/me', { auth: `Bot ${wrong}` }), noCtx);
    expect(res.status).toBe(401);
    expect(getActiveBotById).toHaveBeenCalledWith(expect.anything(), BOT_ID);
  });

  it('401 once the token is revoked or rotated', async () => {
    const { me } = await routes();
    getActiveBotById.mockResolvedValue(botRow({ tokenHash: null }));
    expect((await me.GET(request('GET', '/me'), noCtx)).status).toBe(401);
    getActiveBotById.mockResolvedValue(botRow({ tokenHash: hashBotToken(generateBotToken(BOT_ID).token) }));
    expect((await me.GET(request('GET', '/me'), noCtx)).status).toBe(401);
  });

  it('never authenticates a built-in bot, even with a matching hash', async () => {
    const { me } = await routes();
    getActiveBotById.mockResolvedValue(botRow({ type: 'moderation' }));
    expect((await me.GET(request('GET', '/me'), noCtx)).status).toBe(401);
  });

  it('rate limits failed attempts per address', async () => {
    const { me } = await routes();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) {
      statuses.push((await me.GET(request('GET', '/me', { auth: 'Bot nope' }), noCtx)).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it('answers a disabled bot with 403', async () => {
    const { me } = await routes();
    getActiveBotById.mockResolvedValue(botRow({ enabled: false }));
    const res = await me.GET(request('GET', '/me'), noCtx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'bot_disabled' });
  });

  it('tells a bot who it is — never its token or hash', async () => {
    const { me } = await routes();
    const res = await me.GET(request('GET', '/me'), noCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.json();
    expect(body).toEqual({
      bot: { id: BOT_ID, name: 'Announcer', type: 'custom', serverId: SERVER, permissions: ['read_messages', 'send_messages'] },
    });
    expect(JSON.stringify(body)).not.toContain('sha256$');
  });
});

describe('pipeline guards', () => {
  it('405 for a method the endpoint does not serve, with a code like every other error', async () => {
    const { me } = await routes();
    const res = await me.GET(request('POST', '/me', { body: {} }), noCtx);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ code: 'method_not_allowed' });
  });

  it('looks the bot up once per request', async () => {
    const { me } = await routes();
    expect((await me.GET(request('GET', '/me'), noCtx)).status).toBe(200);
    expect(getActiveBotById).toHaveBeenCalledTimes(1);
  });

  it('caps well-formed tokens per address before touching the database', async () => {
    const { me } = await routes();
    const { BOT_API_ADDRESS_LIMIT } = await import('@/lib/bots/api');
    const forged = generateBotToken('11111111-2222-4333-8444-555555555555').token;
    for (let i = 0; i < BOT_API_ADDRESS_LIMIT.maxRequests; i += 1) {
      await me.GET(request('GET', '/me', { auth: `Bot ${forged}` }), noCtx);
    }
    const lookups = getActiveBotById.mock.calls.length;
    const res = await me.GET(request('GET', '/me', { auth: `Bot ${forged}` }), noCtx);
    expect(res.status).toBe(429);
    expect(getActiveBotById.mock.calls.length).toBe(lookups);
  });

  it('never lets failed attempts spend a bot’s own budget', async () => {
    const { messages } = await routes();
    for (let i = 0; i < 40; i += 1) {
      await messages.POST(
        request('POST', `/channels/${GENERAL}/messages`, { auth: 'Bot forged', body: { content: 'x' } }),
        messagesCtx(GENERAL)
      );
    }
    const res = await messages.POST(
      request('POST', `/channels/${GENERAL}/messages`, { body: { content: 'still here' } }),
      messagesCtx(GENERAL)
    );
    expect(res.status).toBe(201);
  });

  it('413 for an oversized body', async () => {
    const { messages } = await routes();
    const res = await messages.POST(
      request('POST', `/channels/${GENERAL}/messages`, { body: { content: 'x'.repeat(20_000) } }),
      messagesCtx(GENERAL)
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'payload_too_large' });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('503 with a maintenance code during maintenance', async () => {
    const { me } = await routes();
    maintenanceResponseForRequest.mockResolvedValue(
      Response.json({ error: 'Maintenance mode', message: 'Back soon' }, { status: 503 })
    );
    const res = await me.GET(request('GET', '/me'), noCtx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'maintenance', message: 'Back soon' });
  });
});

describe('GET /channels', () => {
  it('needs read_messages or send_messages', async () => {
    const { channels } = await routes();
    getActiveBotById.mockResolvedValue(botRow({ permissions: ['read_presence'] }));
    const res = await channels.GET(request('GET', '/channels'), noCtx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'missing_permission' });
  });

  it('lists the open text channels of the bot’s own server', async () => {
    const { channels } = await routes();
    const res = await channels.GET(request('GET', '/channels'), noCtx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      channels: [{ id: GENERAL, name: 'general', type: 'text', position: 0, topic: null }],
    });
    expect(listBotReachableChannels).toHaveBeenCalledWith(expect.anything(), { id: BOT_ID, serverId: SERVER });
  });

  it('lists exactly the granted channels once an admin chose some — a role-gated one included', async () => {
    const { channels } = await routes();
    grants = [PRIVATE];
    const res = await channels.GET(request('GET', '/channels'), noCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).channels.map((c: { id: string }) => c.id)).toEqual([PRIVATE]);
  });
});

describe('GET /channels/{id}/messages', () => {
  it('needs read_messages', async () => {
    const { messages } = await routes();
    getActiveBotById.mockResolvedValue(botRow({ permissions: ['send_messages'] }));
    const res = await messages.GET(request('GET', `/channels/${GENERAL}/messages`), messagesCtx(GENERAL));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'missing_permission', permission: 'read_messages' });
  });

  it('cannot read another server, a role-gated channel or a voice channel', async () => {
    const { messages } = await routes();
    for (const channel of [FOREIGN, PRIVATE, VOICE, 'not-a-uuid']) {
      const res = await messages.GET(request('GET', `/channels/${channel}/messages`), messagesCtx(channel));
      expect(res.status).toBe(404);
    }
    expect(listMessagesForChannel).not.toHaveBeenCalled();
    // Every lookup went through the one access helper, as this bot.
    expect(getBotReachableChannel).toHaveBeenCalledWith(expect.anything(), { id: BOT_ID, serverId: SERVER }, PRIVATE);
  });

  it('follows explicit grants: a granted role-gated channel opens, an ungranted open one closes', async () => {
    const { messages } = await routes();
    grants = [PRIVATE];
    listMessagesForChannel.mockResolvedValue([]);
    listUserDisplayNames.mockResolvedValue(new Map());
    expect((await messages.GET(request('GET', `/channels/${PRIVATE}/messages`), messagesCtx(PRIVATE))).status).toBe(200);
    expect((await messages.GET(request('GET', `/channels/${GENERAL}/messages`), messagesCtx(GENERAL))).status).toBe(404);
  });

  it('validates limit and before', async () => {
    const { messages } = await routes();
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'before=yesterday']) {
      const res = await messages.GET(request('GET', `/channels/${GENERAL}/messages?${query}`), messagesCtx(GENERAL));
      expect(res.status).toBe(400);
    }
  });

  it('returns recent messages with typed authors', async () => {
    const { messages } = await routes();
    listMessagesForChannel.mockResolvedValue([
      { id: 'm2', channelId: GENERAL, userId: null, botId: BOT_ID, content: 'beep', metadata: { bot: { id: BOT_ID, name: 'Announcer', type: 'custom' } }, replyToId: null, createdAt: new Date('2026-09-28T10:01:00Z'), editedAt: null, deletedAt: null },
      { id: 'm1', channelId: GENERAL, userId: MEMBER, botId: null, content: 'hi', metadata: {}, replyToId: null, createdAt: new Date('2026-09-28T10:00:00Z'), editedAt: null, deletedAt: null },
    ]);
    const res = await messages.GET(
      request('GET', `/channels/${GENERAL}/messages?limit=2&before=2026-09-29T00:00:00Z`),
      messagesCtx(GENERAL)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; author: unknown }> };
    expect(body.messages.map((m) => m.author)).toEqual([
      { type: 'bot', id: BOT_ID, name: 'Announcer' },
      { type: 'user', id: MEMBER, name: 'Ayşe' },
    ]);
    expect(listMessagesForChannel).toHaveBeenCalledWith(expect.anything(), GENERAL, {
      limit: 2,
      before: new Date('2026-09-29T00:00:00Z'),
    });
  });
});

describe('POST /channels/{id}/messages', () => {
  it('needs send_messages', async () => {
    const { messages } = await routes();
    getActiveBotById.mockResolvedValue(botRow({ permissions: ['read_messages'] }));
    const res = await messages.POST(
      request('POST', `/channels/${GENERAL}/messages`, { body: { content: 'hi' } }),
      messagesCtx(GENERAL)
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'missing_permission', permission: 'send_messages' });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('validates the body', async () => {
    const { messages } = await routes();
    for (const body of ['not json', { content: '' }, { content: '   ' }, { content: 'x'.repeat(4001) }, { content: 'hi', userId: MEMBER }, {}]) {
      const res = await messages.POST(request('POST', `/channels/${GENERAL}/messages`, { body }), messagesCtx(GENERAL));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('cannot post into another server, a role-gated channel or a voice channel', async () => {
    const { messages } = await routes();
    for (const channel of [FOREIGN, PRIVATE, VOICE]) {
      const res = await messages.POST(
        request('POST', `/channels/${channel}/messages`, { body: { content: 'hi' } }),
        messagesCtx(channel)
      );
      expect(res.status).toBe(404);
    }
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('cannot ping the whole server', async () => {
    const { messages } = await routes();
    const res = await messages.POST(
      request('POST', `/channels/${GENERAL}/messages`, { body: { content: 'wake up @everyone' } }),
      messagesCtx(GENERAL)
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'mass_mention_forbidden' });
  });

  it('posts as the bot, fans the message out and audits it', async () => {
    const { messages } = await routes();
    const res = await messages.POST(
      request('POST', `/channels/${GENERAL}/messages`, { body: { content: '  Server restarts in 5 minutes  ' } }),
      messagesCtx(GENERAL)
    );
    expect(res.status).toBe(201);
    const snapshot = { id: BOT_ID, name: 'Announcer', type: 'custom' };
    expect(createMessage).toHaveBeenCalledWith(expect.anything(), {
      channelId: GENERAL,
      userId: null,
      botId: BOT_ID,
      content: 'Server restarts in 5 minutes',
      metadata: { bot: snapshot },
    });
    expect(publishChatMessage).toHaveBeenCalledWith({
      serverId: SERVER,
      channelId: GENERAL,
      message: expect.objectContaining({ id: 'msg-new', userId: null, botId: BOT_ID, bot: snapshot }),
    });
    expect(logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: SERVER,
        actorUserId: null,
        action: 'message.create',
        targetId: 'msg-new',
        metadata: expect.objectContaining({ botId: BOT_ID, channelId: GENERAL }),
      })
    );
    expect(await res.json()).toEqual({
      message: {
        id: 'msg-new',
        channelId: GENERAL,
        content: 'Server restarts in 5 minutes',
        createdAt: '2026-09-28T12:00:00.000Z',
        editedAt: null,
        replyToId: null,
        author: { type: 'bot', id: BOT_ID, name: 'Announcer' },
      },
    });
  });

  it('rate limits each bot on its own budget', async () => {
    const { messages } = await routes();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const res = await messages.POST(
        request('POST', `/channels/${GENERAL}/messages`, { body: { content: `n${i}` } }),
        messagesCtx(GENERAL)
      );
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
        expect(await res.json()).toMatchObject({ code: 'rate_limited' });
      }
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
  });
});
