import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Running a slash command (BOT_API_V2 §3.3): every check in order — the
 * member's channel access and timeout, the command, the invoker's required
 * permission, the bot, the options (incl. the user / channel re-checks),
 * the Moderation Bot — then the interaction row and its delivery. Real
 * session cookies and permission helpers, a per-test rate-limit counter;
 * the database and Redis are replaced.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getChannelById: vi.fn(),
  getUserPermissions: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  getActiveMemberTimeout: vi.fn(),
  getBotCommandById: vi.fn(),
  getBotById: vi.fn(),
  getBotReachableChannel: vi.fn(),
  createBotInteraction: vi.fn(),
  listUserDisplayNames: vi.fn(),
  logAction: vi.fn(),
  expireBotInteractions: vi.fn(),
  pruneBotInteractions: vi.fn(async () => ({ cleared: 0, deleted: 0 })),
  getBuiltInBotForServer: vi.fn(),
  isChannelOpenToBots: vi.fn(),
  getActiveBotById: vi.fn(),
  getBotEventEndpoint: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
// A fixed-window counter per key, reset for every test (the real in-memory
// limiter would carry its counts from one test to the next).
const counters = new Map<string, number>();
vi.mock('@/lib/security-headers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security-headers')>('@/lib/security-headers');
  return {
    ...actual,
    withApiSecurity: (handler: unknown) => handler,
    distributedRateLimit: async (key: string, config: { windowMs: number; maxRequests: number }) => {
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return { allowed: count <= config.maxRequests, remaining: Math.max(0, config.maxRequests - count), resetAt: Date.now() + config.windowMs };
    },
  };
});
const redisPublish = vi.fn();
// PUBSUB NUMSUB on the bot's event channel: how many gateways hold a live
// stream connection for it (lib/bots/reachability.ts).
const redisPubsub = vi.fn();
vi.mock('@/lib/redis', () => ({ redis: { publish: redisPublish, pubsub: redisPubsub } }));
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage: vi.fn() }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '99999999-9999-4999-8999-999999999999';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const STAFF = '88888888-8888-4888-8888-888888888888';
const FOREIGN = '77777777-7777-4777-8777-777777777777';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COMMAND = '66666666-6666-4666-8666-666666666666';

const CHANNELS: Record<string, { id: string; serverId: string; type: string; name: string }> = {
  [GENERAL]: { id: GENERAL, serverId: SERVER, type: 'text', name: 'general' },
  [STAFF]: { id: STAFF, serverId: SERVER, type: 'text', name: 'staff' },
  [FOREIGN]: { id: FOREIGN, serverId: '00000000-0000-4000-8000-000000000000', type: 'text', name: 'theirs' },
};
let perms: Record<string, string[]>;

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMAND,
    botId: BOT_ID,
    serverId: SERVER,
    name: 'roll',
    description: 'Roll dice',
    options: [
      { name: 'sides', description: '', type: 'integer', required: true, min: 2, max: 100 },
      { name: 'who', description: '', type: 'user', required: false },
      { name: 'where', description: '', type: 'channel', required: false },
      { name: 'note', description: '', type: 'string', required: false },
    ],
    channelIds: null,
    adminChannelIds: null,
    requiredPermission: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function bot(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID, serverId: SERVER, name: 'Dice', type: 'custom', enabled: true,
    permissions: ['slash_commands', 'receive_events', 'send_messages'], settings: {},
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function invoke(uid: string | null, body: unknown, ids: { channelId?: string; commandId?: string } = {}) {
  const channelId = ids.channelId ?? GENERAL;
  const commandId = ids.commandId ?? COMMAND;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (uid) headers.cookie = cookie(uid);
  return import('../[commandId]/invoke/route.js').then((route) =>
    route.POST(
      new Request(`https://chat.example.test/api/servers/${SERVER}/channels/${channelId}/commands/${commandId}/invoke`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: SERVER, channelId, commandId }) }
    )
  );
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  counters.clear();
  for (const fn of [...Object.values(db), redisPublish, redisPubsub]) fn.mockReset();
  perms = { [OWNER]: ['administrator'], [MEMBER]: ['send_messages', 'read_message_history'] };
  db.getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  db.isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid in perms);
  db.getChannelById.mockImplementation(async (_db: unknown, id: string) => CHANNELS[id] ?? null);
  db.getUserPermissions.mockImplementation(async (_db: unknown, uid: string) => perms[uid] ?? []);
  db.canMemberAccessChannel.mockImplementation(async (_db: unknown, _s: string, channelId: string) => channelId !== STAFF);
  db.getActiveMemberTimeout.mockResolvedValue(null);
  db.getBotCommandById.mockImplementation(async (_db: unknown, id: string) => (id === COMMAND ? command() : null));
  db.getBotById.mockResolvedValue(bot());
  db.getBotReachableChannel.mockImplementation(async (_db: unknown, _bot: unknown, id: string) => (id === GENERAL ? CHANNELS[GENERAL] : null));
  db.createBotInteraction.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    ...input, id: 'int-1', status: 'pending', response: null, followupCount: 0, createdAt: new Date(), answeredAt: null,
  }));
  db.listUserDisplayNames.mockResolvedValue(new Map([[MEMBER, 'Ayşe']]));
  db.logAction.mockResolvedValue(undefined);
  db.expireBotInteractions.mockResolvedValue(0);
  db.getBuiltInBotForServer.mockResolvedValue(null);
  db.isChannelOpenToBots.mockResolvedValue(true);
  db.getActiveBotById.mockResolvedValue(bot());
  db.getBotEventEndpoint.mockResolvedValue(null);
  redisPublish.mockResolvedValue(1);
  // The bot's stream is connected unless a test says otherwise.
  redisPubsub.mockImplementation(async (_sub: string, channel: string) => [channel, 1]);
});

describe('who may run a command', () => {
  it('401 without a session', async () => {
    expect((await invoke(null, { options: { sides: 6 } })).status).toBe(401);
  });

  it('403 for a non-member, a channel they cannot see, or without SEND_MESSAGES', async () => {
    expect((await invoke(STRANGER, { options: { sides: 6 } })).status).toBe(403);
    expect((await invoke(MEMBER, { options: { sides: 6 } }, { channelId: STAFF })).status).toBe(403);
    perms[MEMBER] = ['read_message_history'];
    expect((await invoke(MEMBER, { options: { sides: 6 } })).status).toBe(403);
    expect(db.createBotInteraction).not.toHaveBeenCalled();
  });

  it('403 timed_out for a timed-out member', async () => {
    const until = new Date(Date.now() + 60_000);
    db.getActiveMemberTimeout.mockResolvedValue(until);
    const res = await invoke(MEMBER, { options: { sides: 6 } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'timed_out', until: until.toISOString() });
  });

  it('20 runs per minute per member', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await invoke(MEMBER, { options: { sides: 6 } })).status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('the command and its bot', () => {
  it('404 command_not_found: unknown, another server’s, or a malformed id', async () => {
    expect((await invoke(MEMBER, { options: {} }, { commandId: '12345678-1234-4234-8234-123456789012' })).status).toBe(404);
    db.getBotCommandById.mockResolvedValueOnce(command({ serverId: '00000000-0000-4000-8000-000000000000' }));
    const foreign = await invoke(MEMBER, { options: { sides: 6 } });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: 'command_not_found' });
    expect((await invoke(MEMBER, { options: {} }, { commandId: 'nope' })).status).toBe(404);
  });

  it('403 command_disabled; 404 command_not_available outside its channels (bot’s list or managers’)', async () => {
    db.getBotCommandById.mockResolvedValueOnce(command({ enabled: false }));
    expect(await (await invoke(MEMBER, { options: { sides: 6 } })).json()).toMatchObject({ code: 'command_disabled' });
    db.getBotCommandById.mockResolvedValueOnce(command({ channelIds: [STAFF] }));
    expect(await (await invoke(MEMBER, { options: { sides: 6 } })).json()).toMatchObject({ code: 'command_not_available' });
    db.getBotCommandById.mockResolvedValueOnce(command({ adminChannelIds: [STAFF] }));
    expect(await (await invoke(MEMBER, { options: { sides: 6 } })).json()).toMatchObject({ code: 'command_not_available' });
  });

  it('the invoker must hold requiredPermission — the owner always does', async () => {
    db.getBotCommandById.mockResolvedValue(command({ requiredPermission: 'kick_members' }));
    const res = await invoke(MEMBER, { options: { sides: 6 } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'missing_permission', permission: 'kick_members' });
    expect((await invoke(OWNER, { options: { sides: 6 } })).status).toBe(202);
    perms[MEMBER] = ['send_messages', 'kick_members'];
    expect((await invoke(MEMBER, { options: { sides: 6 } })).status).toBe(202);
  });

  it('409 bot_unavailable for a disabled bot or one without slash_commands; 404 where the bot has no access', async () => {
    db.getBotById.mockResolvedValueOnce(bot({ enabled: false }));
    expect(await (await invoke(MEMBER, { options: { sides: 6 } })).json()).toMatchObject({ code: 'bot_unavailable' });
    db.getBotById.mockResolvedValueOnce(bot({ permissions: ['send_messages'] }));
    expect(await (await invoke(MEMBER, { options: { sides: 6 } })).json()).toMatchObject({ code: 'bot_unavailable' });
    db.getBotReachableChannel.mockResolvedValueOnce(null);
    const res = await invoke(MEMBER, { options: { sides: 6 } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'command_not_available' });
    expect(db.createBotInteraction).not.toHaveBeenCalled();
  });
});

describe('options — validated on the server', () => {
  it('400 invalid_options for unknown names, wrong types, ranges and missing required ones', async () => {
    for (const options of [{ sides: 6, sudo: 1 }, { sides: '6' }, { sides: 1 }, {}, { sides: 6, note: 'x'.repeat(1001) }]) {
      const res = await invoke(MEMBER, { options });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_options' });
    }
    expect((await invoke(MEMBER, { options: { sides: 6 }, extra: true })).status).toBe(400);
    expect((await invoke(MEMBER, 'not json')).status).toBe(400);
  });

  it('§8: a user option must be a member of THIS server; a channel option one the invoker can see', async () => {
    const notMember = await invoke(MEMBER, { options: { sides: 6, who: STRANGER } });
    expect(notMember.status).toBe(400);
    expect((await notMember.json()).issues).toEqual(['who: not a member of this server']);
    expect((await invoke(MEMBER, { options: { sides: 6, who: OWNER } })).status).toBe(202);
    const hidden = await invoke(MEMBER, { options: { sides: 6, where: STAFF } });
    expect((await hidden.json()).issues).toEqual(['where: not a channel you can see']);
    const foreign = await invoke(MEMBER, { options: { sides: 6, where: FOREIGN } });
    expect((await foreign.json()).issues).toEqual(['where: not a channel you can see']);
    expect((await invoke(MEMBER, { options: { sides: 6, where: GENERAL } })).status).toBe(202);
  });

  it('free text goes through the Moderation Bot like a message', async () => {
    db.getBuiltInBotForServer.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555', serverId: SERVER, name: 'Mod', type: 'moderation', enabled: true,
      permissions: ['read_messages', 'moderate_messages'], settings: { blockedWords: ['salak*'], flood: null, repeat: null, exemptStaff: false },
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await invoke(MEMBER, { options: { sides: 6, note: 'sen salaksın' } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'blocked_by_moderation', rule: 'blocked_word' });
    expect(db.createBotInteraction).not.toHaveBeenCalled();
  });
});

describe('a successful run', () => {
  it('202: records the interaction (15 minutes), delivers it to the bot’s stream and audits it', async () => {
    const before = Date.now();
    const res = await invoke(MEMBER, { options: { sides: 20, note: 'good luck' } });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ interaction: { id: 'int-1', status: 'pending', commandName: 'roll', channelId: GENERAL, bot: { id: BOT_ID, name: 'Dice' } } });
    const row = db.createBotInteraction.mock.calls[0]![1];
    expect(row).toMatchObject({ botId: BOT_ID, commandId: COMMAND, serverId: SERVER, channelId: GENERAL, userId: MEMBER, commandName: 'roll', options: { sides: 20, note: 'good luck' } });
    const ttl = (row.expiresAt as Date).getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(15 * 60_000 - 50);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1_000);

    await vi.waitFor(() => expect(redisPublish).toHaveBeenCalled());
    const [channel, raw] = redisPublish.mock.calls[0]!;
    expect(channel).toMatch(new RegExp(`:bot-events:${BOT_ID}$`));
    expect(JSON.parse(raw)).toMatchObject({
      event: 'interaction_create',
      interaction: { id: 'int-1', commandName: 'roll', options: { sides: 20, note: 'good luck' }, channelId: GENERAL, user: { id: MEMBER, displayName: 'Ayşe' } },
    });
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'command.invoke', actorUserId: MEMBER, targetId: BOT_ID }));
  });

  it('a bot without receive_events cannot be reached at all (no stream, no endpoint): 409 bot_offline, nothing written', async () => {
    db.getBotById.mockResolvedValue(bot({ permissions: ['slash_commands'] }));
    db.getBotEventEndpoint.mockResolvedValue({ botId: BOT_ID, url: 'https://bot.example.test/hook', events: ['interaction_create'], enabled: true });
    const res = await invoke(MEMBER, { options: { sides: 6 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'bot_offline' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redisPublish).not.toHaveBeenCalled();
    expect(db.createBotInteraction).not.toHaveBeenCalled();
  });
});

describe('bot_offline — fail fast instead of a 15-minute "thinking…"', () => {
  it('409 bot_offline when the bot has no live stream connection and no event endpoint; nothing is recorded or audited', async () => {
    redisPubsub.mockImplementation(async (_sub: string, channel: string) => [channel, 0]);
    const res = await invoke(MEMBER, { options: { sides: 6 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'bot_offline',
      error: expect.any(String),
      bot: { id: BOT_ID, name: 'Dice' },
    });
    expect(redisPubsub).toHaveBeenCalledWith('NUMSUB', expect.stringMatching(new RegExp(`:bot-events:${BOT_ID}$`)));
    expect(db.createBotInteraction).not.toHaveBeenCalled();
    expect(db.logAction).not.toHaveBeenCalled();
  });

  it('202 as before when the bot has an enabled HTTP endpoint for interactions, connected or not', async () => {
    redisPubsub.mockImplementation(async (_sub: string, channel: string) => [channel, 0]);
    db.getBotEventEndpoint.mockResolvedValue({ botId: BOT_ID, url: 'https://bot.example.test/hook', events: ['interaction_create'], enabled: true });
    expect((await invoke(MEMBER, { options: { sides: 6 } })).status).toBe(202);
    expect(db.createBotInteraction).toHaveBeenCalledTimes(1);
  });

  it('an endpoint that is switched off, or not subscribed to interaction_create, does not count', async () => {
    redisPubsub.mockImplementation(async (_sub: string, channel: string) => [channel, 0]);
    db.getBotEventEndpoint.mockResolvedValueOnce({ botId: BOT_ID, url: 'https://bot.example.test/hook', events: ['interaction_create'], enabled: false });
    expect(await (await invoke(MEMBER, { options: { sides: 6 } })).json()).toMatchObject({ code: 'bot_offline' });
    db.getBotEventEndpoint.mockResolvedValueOnce({ botId: BOT_ID, url: 'https://bot.example.test/hook', events: ['message_create'], enabled: true });
    expect(await (await invoke(MEMBER, { options: { sides: 6 } })).json()).toMatchObject({ code: 'bot_offline' });
    expect(db.createBotInteraction).not.toHaveBeenCalled();
  });

  it('keeps the old behaviour (202) when Redis cannot say whether the stream is connected', async () => {
    redisPubsub.mockRejectedValue(new Error('connection refused'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await invoke(MEMBER, { options: { sides: 6 } })).status).toBe(202);
  });
});
