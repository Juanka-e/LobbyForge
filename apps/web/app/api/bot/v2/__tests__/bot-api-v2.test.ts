import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBotToken, hashBotToken } from '@/lib/bots/token';

/**
 * Bot API v2 (docs/BOT_API_V2.md §3.2): commands, interaction answers, the
 * gateway URL, the event endpoint and member lookups — authentication,
 * permissions, rate limits, validation, the happy paths, and the §8 checks
 * (interactions bound to their bot, answered once, expired after 15 min;
 * secrets shown once; private networks refused). The real pipeline runs
 * (machine boundary, bot auth, in-memory rate limiter); the database,
 * Redis, the chat bus and DNS are replaced.
 */

class CommandNameTakenError extends Error {
  constructor(readonly names: string[]) {
    super('taken');
  }
}

const db = {
  getActiveBotById: vi.fn(),
  touchBotLastUsed: vi.fn(),
  listBotCommands: vi.fn(),
  findCommandNamesTakenByOtherBots: vi.fn(),
  replaceBotCommands: vi.fn(),
  deleteBotCommandByName: vi.fn(),
  getBotInteractionForBot: vi.fn(),
  claimBotInteractionAnswer: vi.fn(),
  claimBotInteractionFollowup: vi.fn(),
  releaseBotInteractionAnswer: vi.fn(),
  releaseBotInteractionFollowup: vi.fn(),
  expireBotInteractions: vi.fn(),
  pruneBotInteractions: vi.fn(),
  failBotInteractionNow: vi.fn(),
  getBotReachableChannel: vi.fn(),
  listBotReachableChannels: vi.fn(),
  createMessage: vi.fn(),
  logAction: vi.fn(),
  listUserDisplayNames: vi.fn(),
  listBotEventTargets: vi.fn(),
  listBotChannelAccessForServer: vi.fn(),
  getBotEventEndpoint: vi.fn(),
  upsertBotEventEndpoint: vi.fn(),
  deleteBotEventEndpoint: vi.fn(),
  getServerMember: vi.fn(),
  getMemberRoleIds: vi.fn(),
  listRolesForServer: vi.fn(),
};
vi.mock('@lobbyforge/db', () => ({ ...db, CommandNameTakenError }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const publishChatMessage = vi.fn();
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage }));
const maintenanceResponseForRequest = vi.fn();
vi.mock('@/lib/maintenance-guard', () => ({ maintenanceResponseForRequest }));
const redisPublish = vi.fn();
vi.mock('@/lib/redis', () => ({ redis: { publish: redisPublish } }));
const resolvePublicAddresses = vi.fn();
vi.mock('@/lib/ip-pinned-https', () => ({ resolvePublicAddresses, fetchIpPinned: vi.fn() }));
/** The invoker's channel access, checked before an ephemeral answer is pushed. */
const authorizeChannelMessageAccess = vi.fn();
vi.mock('@/lib/message-authorization', () => ({ authorizeChannelMessageAccess }));

const SERVER = '11111111-1111-4111-8111-111111111111';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_BOT = '5c1e1a9e-8f0d-4c55-9a1c-0f7cbe0f3a11';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '88888888-8888-4888-8888-888888888888';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const INTERACTION = '44444444-4444-4444-8444-444444444444';
const ALL = ['read_messages', 'send_messages', 'slash_commands', 'read_members', 'receive_events'];

let token: string;

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Dice',
    type: 'custom',
    tokenHash: hashBotToken(token),
    tokenIssuedAt: new Date(),
    permissions: ALL,
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

function interactionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTERACTION,
    botId: BOT_ID,
    commandId: 'cmd-1',
    serverId: SERVER,
    channelId: GENERAL,
    userId: MEMBER,
    commandName: 'roll',
    options: { sides: 6 },
    status: 'pending',
    response: null,
    followupCount: 0,
    createdAt: new Date(Date.now() - 60_000),
    answeredAt: null,
    expiresAt: new Date(Date.now() + 14 * 60_000),
    ...overrides,
  };
}

function commandRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `cmd-${name}`,
    botId: BOT_ID,
    serverId: SERVER,
    name,
    description: `Run ${name}`,
    options: [],
    channelIds: null,
    adminChannelIds: null,
    requiredPermission: null,
    enabled: true,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function request(method: string, path: string, init: { auth?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  const auth = init.auth === undefined ? `Bot ${token}` : init.auth;
  if (auth) headers.authorization = auth;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://chat.example.test/api/bot/v2${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
  });
}

const noCtx = { params: Promise.resolve({}) };
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

async function routes() {
  return {
    commands: await import('../commands/route.js'),
    command: await import('../commands/[name]/route.js'),
    respond: await import('../interactions/[id]/respond/route.js'),
    followup: await import('../interactions/[id]/followup/route.js'),
    gateway: await import('../gateway/route.js'),
    endpoint: await import('../event-endpoint/route.js'),
    member: await import('../members/[userId]/route.js'),
    me: await import('../me/route.js'),
  };
}

beforeEach(() => {
  vi.resetModules();
  token = generateBotToken(BOT_ID).token;
  for (const fn of [...Object.values(db), publishChatMessage, maintenanceResponseForRequest, redisPublish, resolvePublicAddresses, authorizeChannelMessageAccess]) {
    fn.mockReset();
  }
  authorizeChannelMessageAccess.mockResolvedValue({ ok: true, context: {} });
  db.pruneBotInteractions.mockResolvedValue({ cleared: 0, deleted: 0 });
  db.failBotInteractionNow.mockResolvedValue(true);
  delete process.env.LOBBYFORGE_PUBLIC_BOT_GATEWAY_URL;
  delete process.env.LOBBYFORGE_PUBLIC_WS_URL;
  delete process.env.NEXT_PUBLIC_WS_URL;
  db.getActiveBotById.mockImplementation(async (_db: unknown, id: string) => (id === BOT_ID ? botRow() : null));
  db.touchBotLastUsed.mockResolvedValue(undefined);
  db.logAction.mockResolvedValue(undefined);
  db.listUserDisplayNames.mockResolvedValue(new Map([[MEMBER, 'Ayşe']]));
  db.listBotEventTargets.mockResolvedValue([]);
  db.listBotChannelAccessForServer.mockResolvedValue(new Map());
  db.expireBotInteractions.mockResolvedValue(0);
  db.getBotReachableChannel.mockImplementation(async (_db: unknown, _bot: unknown, id: string) =>
    id === GENERAL ? { id: GENERAL, serverId: SERVER, type: 'text', name: 'general' } : null
  );
  db.listBotReachableChannels.mockResolvedValue([{ id: GENERAL, serverId: SERVER, type: 'text', name: 'general', position: 0 }]);
  db.findCommandNamesTakenByOtherBots.mockResolvedValue([]);
  db.replaceBotCommands.mockImplementation(async (_db: unknown, input: { commands: Array<{ name: string }> }) =>
    input.commands.map((c) => commandRow(c.name, c))
  );
  db.listBotCommands.mockResolvedValue([commandRow('roll')]);
  db.getBotInteractionForBot.mockImplementation(async (_db: unknown, id: string, botId: string) =>
    id === INTERACTION && botId === BOT_ID ? interactionRow() : null
  );
  db.claimBotInteractionAnswer.mockImplementation(async () => interactionRow({ status: 'answered' }));
  db.claimBotInteractionFollowup.mockImplementation(async () => interactionRow({ status: 'answered', followupCount: 1 }));
  db.createMessage.mockImplementation(async (_db: unknown, row: Record<string, unknown>) => ({
    id: 'msg-new',
    channelId: row.channelId,
    userId: null,
    botId: row.botId,
    content: row.content,
    metadata: row.metadata,
    replyToId: null,
    createdAt: new Date('2026-10-03T12:00:00Z'),
    editedAt: null,
    deletedAt: null,
  }));
  maintenanceResponseForRequest.mockResolvedValue(null);
  redisPublish.mockResolvedValue(1);
  resolvePublicAddresses.mockResolvedValue(['93.184.216.34']);
});

// ── authentication + permissions, every route ─────────────────────────────

describe('every v2 route', () => {
  it('401 without a token and 403 without its permission', async () => {
    const r = await routes();
    const cases: Array<[() => Promise<Response>, () => Promise<Response>, string]> = [
      [() => r.commands.GET(request('GET', '/commands', { auth: null }), noCtx), () => r.commands.GET(request('GET', '/commands'), noCtx), 'slash_commands'],
      [
        () => r.respond.POST(request('POST', `/interactions/${INTERACTION}/respond`, { auth: null, body: { content: 'x' } }), idCtx(INTERACTION)),
        () => r.respond.POST(request('POST', `/interactions/${INTERACTION}/respond`, { body: { content: 'x' } }), idCtx(INTERACTION)),
        'slash_commands',
      ],
      [() => r.gateway.GET(request('GET', '/gateway', { auth: null }), noCtx), () => r.gateway.GET(request('GET', '/gateway'), noCtx), 'receive_events'],
      [() => r.endpoint.GET(request('GET', '/event-endpoint', { auth: null }), noCtx), () => r.endpoint.GET(request('GET', '/event-endpoint'), noCtx), 'receive_events'],
      [
        () => r.member.GET(request('GET', `/members/${MEMBER}`, { auth: null }), { params: Promise.resolve({ userId: MEMBER }) }),
        () => r.member.GET(request('GET', `/members/${MEMBER}`), { params: Promise.resolve({ userId: MEMBER }) }),
        'read_members',
      ],
    ];
    for (const [unauthenticated, , permission] of cases) {
      const res = await unauthenticated();
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'unauthorized' });
      void permission;
    }
    db.getActiveBotById.mockResolvedValue(botRow({ permissions: ['read_messages'] }));
    for (const [, denied, permission] of cases) {
      const res = await denied();
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'missing_permission', permission });
    }
  });

  it('403 for a disabled bot, and v2/me answers like v1', async () => {
    const r = await routes();
    const me = await r.me.GET(request('GET', '/me'), noCtx);
    expect(await me.json()).toMatchObject({ bot: { id: BOT_ID, serverId: SERVER, permissions: ALL } });
    db.getActiveBotById.mockResolvedValue(botRow({ enabled: false }));
    const res = await r.commands.GET(request('GET', '/commands'), noCtx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'bot_disabled' });
  });
});

// ── commands ──────────────────────────────────────────────────────────────

describe('commands', () => {
  const roll = { name: 'roll', description: 'Roll dice', options: [{ name: 'sides', description: 'Sides', type: 'integer', min: 2, max: 1000 }] };

  it('GET lists this bot’s commands and sweeps its overdue interactions', async () => {
    const { commands } = await routes();
    const res = await commands.GET(request('GET', '/commands'), noCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).commands).toEqual([expect.objectContaining({ id: 'cmd-roll', name: 'roll', enabled: true })]);
    expect(db.expireBotInteractions).toHaveBeenCalledWith(expect.anything(), { botId: BOT_ID }, expect.any(Date));
  });

  it('PUT overwrites the list (array or { commands }) with defaults filled in', async () => {
    const { commands } = await routes();
    for (const body of [[roll], { commands: [roll] }]) {
      db.replaceBotCommands.mockClear();
      const res = await commands.PUT(request('PUT', '/commands', { body }), noCtx);
      expect(res.status).toBe(200);
      expect(db.replaceBotCommands).toHaveBeenCalledWith(expect.anything(), {
        botId: BOT_ID,
        serverId: SERVER,
        commands: [
          {
            name: 'roll',
            description: 'Roll dice',
            options: [{ name: 'sides', description: 'Sides', type: 'integer', required: false, min: 2, max: 1000 }],
            channelIds: null,
            requiredPermission: null,
          },
        ],
      });
    }
  });

  it('PUT validates: 400 with issues for bad shapes, more than 50, or channels the bot cannot use', async () => {
    const { commands } = await routes();
    const bad = await commands.PUT(request('PUT', '/commands', { body: [{ ...roll, name: 'Roll Dice' }] }), noCtx);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_request', issues: [expect.stringContaining('0.name')] });
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, description: 'd' }));
    expect((await commands.PUT(request('PUT', '/commands', { body: many }), noCtx)).status).toBe(400);
    const elsewhere = await commands.PUT(request('PUT', '/commands', { body: [{ ...roll, channelIds: [PRIVATE] }] }), noCtx);
    expect(elsewhere.status).toBe(400);
    expect((await elsewhere.json()).issues[0]).toContain(PRIVATE);
    expect(db.replaceBotCommands).not.toHaveBeenCalled();
  });

  it('PUT answers 409 command_name_taken when another bot owns a name — also when it loses a race', async () => {
    const { commands } = await routes();
    db.findCommandNamesTakenByOtherBots.mockResolvedValueOnce(['roll']);
    const res = await commands.PUT(request('PUT', '/commands', { body: [roll] }), noCtx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'command_name_taken', names: ['roll'] });
    db.replaceBotCommands.mockRejectedValueOnce(new CommandNameTakenError(['roll']));
    const raced = await commands.PUT(request('PUT', '/commands', { body: [roll] }), noCtx);
    expect(raced.status).toBe(409);
  });

  it('PUT is limited to 5 per minute per bot', async () => {
    const { commands } = await routes();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await commands.PUT(request('PUT', '/commands', { body: [roll] }), noCtx)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('DELETE removes one command by name; unknown or malformed names are 404', async () => {
    const { command } = await routes();
    db.deleteBotCommandByName.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await command.DELETE(request('DELETE', '/commands/roll'), { params: Promise.resolve({ name: 'roll' }) })).status).toBe(200);
    expect(db.deleteBotCommandByName).toHaveBeenCalledWith(expect.anything(), BOT_ID, 'roll');
    expect((await command.DELETE(request('DELETE', '/commands/flip'), { params: Promise.resolve({ name: 'flip' }) })).status).toBe(404);
    expect((await command.DELETE(request('DELETE', '/commands/X'), { params: Promise.resolve({ name: '../X' }) })).status).toBe(404);
  });
});

// ── interaction answers ───────────────────────────────────────────────────

describe('interaction answers', () => {
  const respond = (body: unknown, id = INTERACTION) =>
    routes().then((r) => r.respond.POST(request('POST', `/interactions/${id}/respond`, { body }), idCtx(id)));
  const followup = (body: unknown, id = INTERACTION) =>
    routes().then((r) => r.followup.POST(request('POST', `/interactions/${id}/followup`, { body }), idCtx(id)));

  it('a public answer is a bot message with metadata.interaction', async () => {
    const res = await respond({ content: '🎲 4' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      interaction: { id: INTERACTION, status: 'answered' },
      message: { id: 'msg-new', author: { type: 'bot', id: BOT_ID }, interaction: { id: INTERACTION, commandName: 'roll' } },
    });
    expect(db.createMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      channelId: GENERAL,
      userId: null,
      botId: BOT_ID,
      metadata: {
        interaction: { id: INTERACTION, commandName: 'roll', invokedBy: { id: MEMBER, displayName: 'Ayşe' } },
        bot: { id: BOT_ID, name: 'Dice', type: 'custom' },
      },
    }));
    expect(publishChatMessage).toHaveBeenCalled();
  });

  it('an ephemeral answer is never stored as a message — it goes to the invoker’s user-events channel', async () => {
    const res = await respond({ content: 'only you', ephemeral: true });
    expect(res.status).toBe(200);
    expect(db.createMessage).not.toHaveBeenCalled();
    expect(db.claimBotInteractionAnswer).toHaveBeenCalledWith(
      expect.anything(),
      { interactionId: INTERACTION, botId: BOT_ID, response: { content: 'only you', ephemeral: true } },
      expect.any(Date)
    );
    await vi.waitFor(() => expect(redisPublish).toHaveBeenCalled());
    const [channel, raw] = redisPublish.mock.calls[0]!;
    expect(channel).toMatch(new RegExp(`^lf:[a-z]+:user-events:${MEMBER}$`));
    expect(JSON.parse(raw)).toMatchObject({
      type: 'interaction_response',
      interaction: { id: INTERACTION, serverId: SERVER, channelId: GENERAL, commandName: 'roll', bot: { id: BOT_ID, name: 'Dice' } },
      response: { content: 'only you', ephemeral: true, followup: false },
    });
  });

  it('an ephemeral answer for an invoker who lost the channel (or the server) is not pushed: 409 interaction_failed', async () => {
    authorizeChannelMessageAccess.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await respond({ content: 'only you', ephemeral: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'interaction_failed' });
    expect(authorizeChannelMessageAccess).toHaveBeenCalledWith({ userId: MEMBER, serverId: SERVER, channelId: GENERAL, operation: 'mutate' });
    expect(db.failBotInteractionNow).toHaveBeenCalledWith(expect.anything(), INTERACTION, BOT_ID);
    await new Promise((r) => setTimeout(r, 20));
    expect(redisPublish.mock.calls.filter(([channel]) => String(channel).includes(':user-events:'))).toEqual([]);
  });

  it('§8: another bot’s token gets 404 for this interaction id; malformed ids are 404', async () => {
    const otherToken = generateBotToken(OTHER_BOT).token;
    db.getActiveBotById.mockImplementation(async (_db: unknown, id: string) =>
      id === OTHER_BOT ? botRow({ id: OTHER_BOT, tokenHash: hashBotToken(otherToken) }) : null
    );
    const { respond: route } = await routes();
    const res = await route.POST(
      request('POST', `/interactions/${INTERACTION}/respond`, { auth: `Bot ${otherToken}`, body: { content: 'mine now' } }),
      idCtx(INTERACTION)
    );
    expect(res.status).toBe(404);
    expect(db.getBotInteractionForBot).toHaveBeenCalledWith(expect.anything(), INTERACTION, OTHER_BOT);
    expect(db.claimBotInteractionAnswer).not.toHaveBeenCalled();
    db.getActiveBotById.mockImplementation(async () => botRow());
    expect((await respond({ content: 'x' }, 'not-a-uuid')).status).toBe(404);
  });

  it('answered once: 409 after the first respond (also when a concurrent claim won)', async () => {
    db.getBotInteractionForBot.mockResolvedValueOnce(interactionRow({ status: 'answered' }));
    const again = await respond({ content: 'x' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'interaction_already_answered' });
    db.claimBotInteractionAnswer.mockResolvedValueOnce(null);
    db.getBotInteractionForBot
      .mockResolvedValueOnce(interactionRow())
      .mockResolvedValueOnce(interactionRow({ status: 'answered' }));
    const raced = await respond({ content: 'x' });
    expect(raced.status).toBe(409);
  });

  it('410 interaction_expired after 15 minutes — and the overdue row is swept', async () => {
    db.getBotInteractionForBot.mockResolvedValueOnce(interactionRow({ expiresAt: new Date(Date.now() - 1) }));
    const res = await respond({ content: 'late' });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'interaction_expired' });
    expect(db.expireBotInteractions).toHaveBeenCalled();
    expect(db.claimBotInteractionAnswer).not.toHaveBeenCalled();
    db.getBotInteractionForBot.mockResolvedValueOnce(interactionRow({ status: 'expired' }));
    expect((await followup({ content: 'late' })).status).toBe(410);
  });

  it('a public answer needs send_messages; an ephemeral one does not', async () => {
    db.getActiveBotById.mockResolvedValue(botRow({ permissions: ['slash_commands'] }));
    const res = await respond({ content: 'public' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'missing_permission', permission: 'send_messages' });
    expect((await respond({ content: 'private', ephemeral: true })).status).toBe(200);
  });

  it('validates the body and refuses @everyone in a public answer', async () => {
    for (const body of [{}, { content: '' }, { content: '   ' }, { content: 'x'.repeat(4001) }, { content: 'x', extra: 1 }, { content: 'x', ephemeral: 'yes' }]) {
      const res = await respond(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    }
    const ping = await respond({ content: 'hey @everyone' });
    expect(ping.status).toBe(403);
    expect(await ping.json()).toMatchObject({ code: 'mass_mention_forbidden' });
    expect(db.claimBotInteractionAnswer).not.toHaveBeenCalled();
  });

  it('§8: a channel the bot lost access to since the run is 404, and the answer is not consumed', async () => {
    db.getBotInteractionForBot.mockResolvedValueOnce(interactionRow({ channelId: PRIVATE }));
    expect((await respond({ content: 'x' })).status).toBe(404);
    expect(db.claimBotInteractionAnswer).not.toHaveBeenCalled();
  });

  it('a failed public post gives the claim back so the bot may retry', async () => {
    db.createMessage.mockRejectedValueOnce(new Error('db down'));
    expect((await respond({ content: 'x' })).status).toBe(500);
    expect(db.releaseBotInteractionAnswer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ interactionId: INTERACTION, botId: BOT_ID }));
  });

  it('follow-ups: only after the first answer, at most 5', async () => {
    db.getBotInteractionForBot.mockResolvedValueOnce(interactionRow());
    const early = await followup({ content: 'x' });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'interaction_not_answered' });

    db.getBotInteractionForBot.mockResolvedValueOnce(interactionRow({ status: 'answered', followupCount: 2 }));
    const ok = await followup({ content: 'more', ephemeral: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ interaction: { followupCount: 1 } });

    db.getBotInteractionForBot.mockResolvedValueOnce(interactionRow({ status: 'answered', followupCount: 5 }));
    const capped = await followup({ content: 'x' });
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ code: 'followup_limit_reached' });
  });

  it('respond + followup share one budget of 60 per minute per bot', async () => {
    db.getBotInteractionForBot.mockResolvedValue(interactionRow({ status: 'answered' }));
    let last = 0;
    for (let i = 0; i < 30; i++) await respond({ content: 'x' });
    for (let i = 0; i < 31; i++) last = (await followup({ content: 'x', ephemeral: true })).status;
    expect(last).toBe(429);
  });
});

// ── gateway + event endpoint + members ────────────────────────────────────

describe('gateway URL', () => {
  it('derives /ws/bot from the configured realtime URL, or the override', async () => {
    process.env.LOBBYFORGE_PUBLIC_WS_URL = 'wss://chat.example.test/ws';
    let { gateway } = await routes();
    expect(await (await gateway.GET(request('GET', '/gateway'), noCtx)).json()).toEqual({ url: 'wss://chat.example.test/ws/bot' });
    vi.resetModules();
    process.env.LOBBYFORGE_PUBLIC_WS_URL = 'ws://localhost:19521';
    ({ gateway } = await routes());
    expect(await (await gateway.GET(request('GET', '/gateway'), noCtx)).json()).toEqual({ url: 'ws://localhost:19521/ws/bot' });
    process.env.LOBBYFORGE_PUBLIC_BOT_GATEWAY_URL = 'wss://bots.example.test/socket';
    expect(await (await gateway.GET(request('GET', '/gateway'), noCtx)).json()).toEqual({ url: 'wss://bots.example.test/socket' });
  });

  it('falls back to the request origin', async () => {
    const { gateway } = await routes();
    expect(await (await gateway.GET(request('GET', '/gateway'), noCtx)).json()).toEqual({ url: 'wss://chat.example.test/ws/bot' });
  });
});

describe('event endpoint (bot side)', () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    botId: BOT_ID,
    url: 'https://bot.example.com/hook',
    secret: `whsec_${'s'.repeat(43)}`,
    events: ['interaction_create'],
    enabled: true,
    failureCount: 0,
    disabledReason: null,
    lastDeliveryAt: null,
    lastStatus: null,
    createdAt: new Date('2026-10-03T00:00:00Z'),
    updatedAt: new Date('2026-10-03T00:00:00Z'),
    ...overrides,
  });

  it('PUT saves an https endpoint and returns a NEW secret once; GET never shows it', async () => {
    db.upsertBotEventEndpoint.mockImplementation(async (_db: unknown, input: { secret: string; events: string[]; url: string }) =>
      stored({ secret: input.secret, events: input.events, url: input.url })
    );
    const { endpoint } = await routes();
    const res = await endpoint.PUT(request('PUT', '/event-endpoint', { body: { url: 'https://bot.example.com/hook#x', events: ['interaction_create'] } }), noCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(body.endpoint).toMatchObject({ url: 'https://bot.example.com/hook', events: ['interaction_create'], enabled: true });
    expect(body.endpoint.secret).toBeUndefined();
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'bot.event_endpoint.set', targetId: BOT_ID }));
    expect(JSON.stringify(db.logAction.mock.calls)).not.toContain(body.secret);

    const second = await (await endpoint.PUT(request('PUT', '/event-endpoint', { body: { url: 'https://bot.example.com/hook' } }), noCtx)).json();
    expect(second.secret).not.toBe(body.secret);
    // Default subscription: everything the bot's permissions allow.
    expect(db.upsertBotEventEndpoint.mock.calls[1]![1].events).toEqual(
      expect.arrayContaining(['interaction_create', 'message_create', 'member_join', 'channel_access_changed'])
    );

    db.getBotEventEndpoint.mockResolvedValue(stored());
    const status = await (await endpoint.GET(request('GET', '/event-endpoint'), noCtx)).json();
    expect(status.endpoint.url).toBe('https://bot.example.com/hook');
    expect(JSON.stringify(status)).not.toContain('whsec_');
  });

  it('§8: refuses http, credentials and anything resolving to a private address', async () => {
    const { endpoint } = await routes();
    for (const url of ['http://bot.example.com/hook', 'https://u:p@bot.example.com/']) {
      const res = await endpoint.PUT(request('PUT', '/event-endpoint', { body: { url } }), noCtx);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_endpoint' });
    }
    resolvePublicAddresses.mockRejectedValueOnce(new Error('Target resolves to a blocked address: 10.0.0.5'));
    const rebind = await endpoint.PUT(request('PUT', '/event-endpoint', { body: { url: 'https://evil.example.com/' } }), noCtx);
    expect(rebind.status).toBe(400);
    expect(db.upsertBotEventEndpoint).not.toHaveBeenCalled();
  });

  it('validates the event list and the body', async () => {
    const { endpoint } = await routes();
    for (const body of [{ url: 'https://bot.example.com', events: ['ready'] }, { url: 'https://bot.example.com', events: [] }, { url: 'https://bot.example.com', secret: 'mine' }]) {
      expect((await endpoint.PUT(request('PUT', '/event-endpoint', { body }), noCtx)).status).toBe(400);
    }
  });

  it('DELETE removes it (404 when there is none)', async () => {
    const { endpoint } = await routes();
    db.deleteBotEventEndpoint.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await endpoint.DELETE(request('DELETE', '/event-endpoint'), noCtx)).status).toBe(200);
    expect((await endpoint.DELETE(request('DELETE', '/event-endpoint'), noCtx)).status).toBe(404);
  });
});

describe('member lookup', () => {
  const ctx = (userId: string) => ({ params: Promise.resolve({ userId }) });

  it('returns what the member list shows — never more', async () => {
    db.getServerMember.mockResolvedValue({ id: 'm', serverId: SERVER, userId: MEMBER, roleId: 'r1', nickname: 'Ayşo', timedOutUntil: null, createdAt: new Date('2026-09-02T00:00:00Z') });
    db.getMemberRoleIds.mockResolvedValue(['r1', 'r2']);
    db.listRolesForServer.mockResolvedValue([
      { id: 'r0', name: 'Hidden', position: 9, permissions: ['administrator'] },
      { id: 'r1', name: '@everyone', position: 0, permissions: [] },
      { id: 'r2', name: 'Mods', position: 5, permissions: ['kick_members'] },
    ]);
    const { member } = await routes();
    const res = await member.GET(request('GET', `/members/${MEMBER}`), ctx(MEMBER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      member: {
        id: MEMBER,
        displayName: 'Ayşe',
        nickname: 'Ayşo',
        roles: [{ id: 'r2', name: 'Mods' }, { id: 'r1', name: '@everyone' }],
        joinedAt: '2026-09-02T00:00:00.000Z',
      },
    });
    expect(db.getServerMember).toHaveBeenCalledWith(expect.anything(), SERVER, MEMBER);
  });

  it('404 for someone who is not a member of the bot’s server, or a malformed id', async () => {
    db.getServerMember.mockResolvedValue(null);
    const { member } = await routes();
    expect((await member.GET(request('GET', `/members/${MEMBER}`), ctx(MEMBER))).status).toBe(404);
    expect((await member.GET(request('GET', '/members/x'), ctx('x'))).status).toBe(404);
  });
});
