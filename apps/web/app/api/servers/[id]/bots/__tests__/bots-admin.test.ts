import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';
import { BOT_TOKEN_PATTERN, hashBotToken } from '@/lib/bots/token';

/**
 * Bot administration: list, create (token once), update, delete, token
 * rotate / revoke and the built-in bots — permission checks, validation,
 * no escalation, the audit trail. Real session cookies and the real
 * permission helpers; the database is mocked.
 */

const getServerById = vi.fn();
const isServerMember = vi.fn();
const getUserPermissions = vi.fn();
const listBotsForServer = vi.fn();
const countBotsForServer = vi.fn();
const createBot = vi.fn();
const getBotById = vi.fn();
const updateBot = vi.fn();
const deleteBot = vi.fn();
const setBotTokenHash = vi.fn();
const ensureBuiltInBot = vi.fn();
const logAction = vi.fn();
const getChannelById = vi.fn();
const isChannelOpenToBots = vi.fn();
const getBuiltInBotForServer = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  BOT_MESSAGE_CHANNEL_TYPES: ['text', 'announcement'],
  getServerById,
  isServerMember,
  getUserPermissions,
  listBotsForServer,
  countBotsForServer,
  createBot,
  getBotById,
  updateBot,
  deleteBot,
  setBotTokenHash,
  ensureBuiltInBot,
  logAction,
  getChannelById,
  isChannelOpenToBots,
  getBuiltInBotForServer,
  canMemberAccessChannel: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 }),
}));
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage: vi.fn() }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OTHER_SERVER = '99999999-9999-4999-8999-999999999999';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MANAGER = '33333333-3333-4333-8333-333333333333';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const FOREIGN_CHANNEL = '77777777-7777-4777-8777-777777777777';

const PERMS: Record<string, string[]> = {
  [OWNER]: ['administrator'],
  [MANAGER]: ['manage_server', 'send_messages', 'read_message_history'],
  [MEMBER]: ['send_messages', 'read_message_history'],
};

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    serverId: SERVER,
    name: 'Announcer',
    type: 'custom',
    tokenHash: 'sha256$' + 'a'.repeat(64),
    tokenIssuedAt: new Date('2026-09-01T00:00:00Z'),
    permissions: ['send_messages'],
    settings: {},
    enabled: true,
    createdBy: OWNER,
    createdByName: 'Owner',
    lastUsedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function req(method: string, url: string, uid: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (uid) headers.cookie = cookie(uid);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://chat.example.test${url}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const serverCtx = { params: Promise.resolve({ id: SERVER }) };
const botCtx = (botId = BOT_ID) => ({ params: Promise.resolve({ id: SERVER, botId }) });
const builtinCtx = (type: string) => ({ params: Promise.resolve({ id: SERVER, type }) });

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  delete process.env.LOBBYFORGE_DEFAULT_LOCALE;
  for (const fn of [getServerById, isServerMember, getUserPermissions, listBotsForServer, countBotsForServer, createBot, getBotById, updateBot, deleteBot, setBotTokenHash, ensureBuiltInBot, logAction, getChannelById, isChannelOpenToBots, getBuiltInBotForServer]) {
    fn.mockReset();
  }
  getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid in PERMS);
  getUserPermissions.mockImplementation(async (_db: unknown, uid: string) => PERMS[uid] ?? []);
  logAction.mockResolvedValue(undefined);
  countBotsForServer.mockResolvedValue(0);
  getBotById.mockResolvedValue(botRow());
  createBot.mockImplementation(async (_db: unknown, input: Record<string, unknown>) =>
    botRow({ ...input, tokenIssuedAt: new Date() })
  );
  updateBot.mockImplementation(async (_db: unknown, _id: string, patch: Record<string, unknown>) => botRow(patch));
  setBotTokenHash.mockImplementation(async (_db: unknown, _id: string, hash: string | null) =>
    botRow({ tokenHash: hash, tokenIssuedAt: hash ? new Date() : null })
  );
  deleteBot.mockResolvedValue(true);
  getChannelById.mockImplementation(async (_db: unknown, id: string) =>
    id === GENERAL
      ? { id: GENERAL, serverId: SERVER, type: 'text', name: 'general' }
      : id === FOREIGN_CHANNEL
        ? { id: FOREIGN_CHANNEL, serverId: OTHER_SERVER, type: 'text', name: 'theirs' }
        : null
  );
  isChannelOpenToBots.mockResolvedValue(true);
});

function auditCalls(action?: string) {
  return logAction.mock.calls
    .map((call) => call[1] as { action: string; metadata: Record<string, unknown>; actorUserId: string; targetType: string })
    .filter((entry) => !action || entry.action === action);
}

describe('GET /api/servers/{id}/bots', () => {
  it('401 without a session, 403 for a non-member', async () => {
    const { GET } = await import('../route.js');
    expect((await GET(req('GET', `/api/servers/${SERVER}/bots`, null), serverCtx)).status).toBe(401);
    const outsider = '66666666-6666-4666-8666-666666666666';
    expect((await GET(req('GET', `/api/servers/${SERVER}/bots`, outsider), serverCtx)).status).toBe(403);
  });

  it('shows members the bots but not their settings, and never a token hash', async () => {
    listBotsForServer.mockResolvedValue([botRow(), botRow({ id: 'b2', type: 'moderation', settings: { blockedWords: ['secret'] } })]);
    const { GET } = await import('../route.js');
    const res = await GET(req('GET', `/api/servers/${SERVER}/bots`, MEMBER), serverCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canManage).toBe(false);
    expect(body.bots[0]).toMatchObject({
      id: BOT_ID,
      name: 'Announcer',
      builtIn: false,
      trustLevel: 'unverified',
      tokenConfigured: true,
      createdBy: { id: OWNER, name: 'Owner' },
    });
    expect(body.bots[1]).toMatchObject({ builtIn: true, trustLevel: 'official' });
    expect(body.bots[1].settings).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('sha256$');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('shows managers the settings', async () => {
    listBotsForServer.mockResolvedValue([botRow({ type: 'moderation', settings: { blockedWords: ['secret'] } })]);
    const { GET } = await import('../route.js');
    const body = await (await GET(req('GET', `/api/servers/${SERVER}/bots`, MANAGER), serverCtx)).json();
    expect(body.canManage).toBe(true);
    expect(body.bots[0].settings.blockedWords).toEqual(['secret']);
  });
});

describe('POST /api/servers/{id}/bots', () => {
  it('401 without a session, 403 without Manage Community', async () => {
    const { POST } = await import('../route.js');
    expect((await POST(req('POST', `/api/servers/${SERVER}/bots`, null, { name: 'X' }), serverCtx)).status).toBe(401);
    expect((await POST(req('POST', `/api/servers/${SERVER}/bots`, MEMBER, { name: 'X' }), serverCtx)).status).toBe(403);
    expect(createBot).not.toHaveBeenCalled();
  });

  it('validates the name and the permission ids', async () => {
    const { POST } = await import('../route.js');
    for (const body of [{ name: '' }, { name: 'x'.repeat(33) }, { name: 'a\u0000b' }, { name: 'ok', permissions: ['administrator'] }, { name: 'ok', type: 'welcome' }]) {
      const res = await POST(req('POST', `/api/servers/${SERVER}/bots`, OWNER, body), serverCtx);
      expect(res.status).toBe(400);
    }
    expect(createBot).not.toHaveBeenCalled();
  });

  it('refuses to give a bot permissions the manager does not hold', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(
      req('POST', `/api/servers/${SERVER}/bots`, MANAGER, { name: 'Spy', permissions: ['send_messages', 'read_audit_log'] }),
      serverCtx
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ungrantable_permissions', permissions: ['read_audit_log'] });
    expect(createBot).not.toHaveBeenCalled();
  });

  it('caps custom bots per server', async () => {
    countBotsForServer.mockResolvedValue(20);
    const { POST } = await import('../route.js');
    const res = await POST(req('POST', `/api/servers/${SERVER}/bots`, OWNER, { name: 'One more' }), serverCtx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'limit_reached', limit: 20 });
  });

  it('creates the bot, returns its token once and stores only the hash', async () => {
    const { POST } = await import('../route.js');
    const res = await POST(
      req('POST', `/api/servers/${SERVER}/bots`, MANAGER, { name: '  Announcer  ', permissions: ['send_messages', 'read_messages', 'send_messages'] }),
      serverCtx
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.token).toMatch(BOT_TOKEN_PATTERN);
    const input = createBot.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({
      serverId: SERVER,
      name: 'Announcer',
      type: 'custom',
      permissions: ['send_messages', 'read_messages'],
      createdBy: MANAGER,
      tokenHash: hashBotToken(body.token),
    });
    expect(body.token.includes(String(input.id).replace(/-/g, ''))).toBe(true);
    expect(JSON.stringify(input)).not.toContain(body.token);
    const [audit] = auditCalls('bot.create');
    expect(audit).toMatchObject({ actorUserId: MANAGER, targetType: 'bot' });
    expect(JSON.stringify(logAction.mock.calls)).not.toContain(body.token);
  });
});

describe('PATCH /api/servers/{id}/bots/{botId}', () => {
  it('404 for a bot of another server or a malformed id', async () => {
    getBotById.mockResolvedValue(botRow({ serverId: OTHER_SERVER }));
    const { PATCH } = await import('../[botId]/route.js');
    expect((await PATCH(req('PATCH', '/x', OWNER, { enabled: false }), botCtx())).status).toBe(404);
    expect((await PATCH(req('PATCH', '/x', OWNER, { enabled: false }), botCtx('not-a-uuid'))).status).toBe(404);
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('403 for a member without Manage Community', async () => {
    const { PATCH } = await import('../[botId]/route.js');
    expect((await PATCH(req('PATCH', '/x', MEMBER, { enabled: false }), botCtx())).status).toBe(403);
  });

  it('disables a bot and audits it', async () => {
    const { PATCH } = await import('../[botId]/route.js');
    const res = await PATCH(req('PATCH', '/x', MANAGER, { enabled: false }), botCtx());
    expect(res.status).toBe(200);
    expect(updateBot).toHaveBeenCalledWith(expect.anything(), BOT_ID, { enabled: false });
    expect(auditCalls('bot.disable')).toHaveLength(1);
  });

  it('renames and changes permissions with the no-escalation rule', async () => {
    const { PATCH } = await import('../[botId]/route.js');
    const denied = await PATCH(req('PATCH', '/x', MANAGER, { permissions: ['send_messages', 'moderate_messages'] }), botCtx());
    expect(denied.status).toBe(403);

    const ok = await PATCH(req('PATCH', '/x', MANAGER, { name: 'Herald', permissions: ['send_messages', 'read_messages'] }), botCtx());
    expect(ok.status).toBe(200);
    expect(updateBot).toHaveBeenCalledWith(expect.anything(), BOT_ID, {
      name: 'Herald',
      permissions: ['send_messages', 'read_messages'],
    });
    const [audit] = auditCalls('bot.update');
    expect(audit!.metadata.changes).toEqual({
      name: { from: 'Announcer', to: 'Herald' },
      permissions: { added: ['read_messages'], removed: [] },
    });
  });

  it('keeps a permission a manager could not grant when it was already there', async () => {
    getBotById.mockResolvedValue(botRow({ permissions: ['send_messages', 'read_audit_log'] }));
    const { PATCH } = await import('../[botId]/route.js');
    const res = await PATCH(req('PATCH', '/x', MANAGER, { permissions: ['read_audit_log'] }), botCtx());
    expect(res.status).toBe(200);
  });

  it('never lets a built-in bot’s permissions change', async () => {
    getBotById.mockResolvedValue(botRow({ type: 'welcome', permissions: ['send_messages'] }));
    const { PATCH } = await import('../[botId]/route.js');
    const res = await PATCH(req('PATCH', '/x', OWNER, { permissions: ['send_messages', 'read_audit_log'] }), botCtx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'builtin_permissions_fixed' });
  });
});

describe('DELETE /api/servers/{id}/bots/{botId}', () => {
  it('deletes a bot of this server and audits it', async () => {
    const { DELETE } = await import('../[botId]/route.js');
    const res = await DELETE(req('DELETE', '/x', OWNER), botCtx());
    expect(res.status).toBe(200);
    expect(deleteBot).toHaveBeenCalledWith(expect.anything(), BOT_ID);
    expect(auditCalls('bot.delete')).toHaveLength(1);
  });

  it('cannot delete another server’s bot', async () => {
    getBotById.mockResolvedValue(botRow({ serverId: OTHER_SERVER }));
    const { DELETE } = await import('../[botId]/route.js');
    expect((await DELETE(req('DELETE', '/x', OWNER), botCtx())).status).toBe(404);
    expect(deleteBot).not.toHaveBeenCalled();
  });
});

describe('bot tokens', () => {
  it('rotates: a new token, only its hash stored, audited as a rotation', async () => {
    const { POST } = await import('../[botId]/token/route.js');
    const res = await POST(req('POST', '/x', MANAGER), botCtx());
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(token).toMatch(BOT_TOKEN_PATTERN);
    expect(setBotTokenHash).toHaveBeenCalledWith(expect.anything(), BOT_ID, hashBotToken(token));
    expect(auditCalls('bot.token.rotate')).toHaveLength(1);
    expect(JSON.stringify(logAction.mock.calls)).not.toContain(token);
  });

  it('issues a first token as an issue, not a rotation', async () => {
    getBotById.mockResolvedValue(botRow({ tokenHash: null }));
    const { POST } = await import('../[botId]/token/route.js');
    expect((await POST(req('POST', '/x', OWNER), botCtx())).status).toBe(200);
    expect(auditCalls('bot.token.issue')).toHaveLength(1);
  });

  it('revokes', async () => {
    const { DELETE } = await import('../[botId]/token/route.js');
    const res = await DELETE(req('DELETE', '/x', OWNER), botCtx());
    expect(res.status).toBe(200);
    expect(setBotTokenHash).toHaveBeenCalledWith(expect.anything(), BOT_ID, null);
    expect((await res.json()).bot.tokenConfigured).toBe(false);
    expect(auditCalls('bot.token.revoke')).toHaveLength(1);
  });

  it('refuses tokens for built-in bots and for members', async () => {
    const tokens = await import('../[botId]/token/route.js');
    expect((await tokens.POST(req('POST', '/x', MEMBER), botCtx())).status).toBe(403);
    getBotById.mockResolvedValue(botRow({ type: 'moderation', tokenHash: null }));
    expect((await tokens.POST(req('POST', '/x', OWNER), botCtx())).status).toBe(400);
    expect(setBotTokenHash).not.toHaveBeenCalled();
  });
});

describe('PUT /api/servers/{id}/bots/builtin/{type}', () => {
  const welcomeRow = (settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    botRow({ id: 'w1', type: 'welcome', name: 'Welcome Bot', tokenHash: null, permissions: ['send_messages'], settings, ...extra });

  it('404 for an unknown type, 403 for a member', async () => {
    const { PUT } = await import('../builtin/[type]/route.js');
    expect((await PUT(req('PUT', '/x', OWNER, { enabled: true }), builtinCtx('music'))).status).toBe(404);
    expect((await PUT(req('PUT', '/x', MEMBER, { enabled: true }), builtinCtx('welcome'))).status).toBe(403);
    expect(ensureBuiltInBot).not.toHaveBeenCalled();
  });

  it('lets only someone who may remove messages switch on the Moderation Bot', async () => {
    // MANAGER can manage the server but not messages.
    const { PUT } = await import('../builtin/[type]/route.js');
    const res = await PUT(req('PUT', '/x', MANAGER, { enabled: true }), builtinCtx('moderation'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'missing_permission' });
    expect(ensureBuiltInBot).not.toHaveBeenCalled();
  });

  it('sets up the welcome bot with its fixed permissions and the translated default name', async () => {
    ensureBuiltInBot.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
      bot: welcomeRow(input.settings as Record<string, unknown>, { name: input.name, enabled: input.enabled }),
      created: true,
    }));
    const { PUT } = await import('../builtin/[type]/route.js');
    const res = await PUT(
      req('PUT', '/x', MANAGER, { enabled: true, settings: { channelId: GENERAL, template: 'Hi {user}!' } }),
      builtinCtx('welcome')
    );
    expect(res.status).toBe(200);
    expect(ensureBuiltInBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: SERVER,
        type: 'welcome',
        name: 'Welcome Bot',
        permissions: ['send_messages'],
        settings: { channelId: GENERAL, template: 'Hi {user}!' },
        enabled: true,
        createdBy: MANAGER,
      })
    );
    const body = await res.json();
    expect(body).toMatchObject({ created: true, bot: { type: 'welcome', builtIn: true, settings: { channelId: GENERAL } } });
    expect(auditCalls('bot.create')).toHaveLength(1);
  });

  it('rejects a permissions field, a mass-mention template and a foreign channel', async () => {
    const { PUT } = await import('../builtin/[type]/route.js');
    const cases = [
      { enabled: true, permissions: ['read_audit_log'] },
      { settings: { template: 'hey @everyone' } },
      { settings: { unknown: true } },
    ];
    for (const body of cases) {
      expect((await PUT(req('PUT', '/x', OWNER, body), builtinCtx('welcome'))).status).toBe(400);
    }
    const foreign = await PUT(req('PUT', '/x', OWNER, { settings: { channelId: FOREIGN_CHANNEL } }), builtinCtx('welcome'));
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ code: 'invalid_channel' });
    expect(ensureBuiltInBot).not.toHaveBeenCalled();
  });

  it('validates moderation settings', async () => {
    const { PUT } = await import('../builtin/[type]/route.js');
    for (const settings of [{ linkPolicy: 'maybe' }, { allowedDomains: ['not a domain'] }, { maxMentions: 500 }, { flood: { max: 0, windowSeconds: 1 } }]) {
      expect((await PUT(req('PUT', '/x', OWNER, { settings }), builtinCtx('moderation'))).status).toBe(400);
    }
  });

  it('merges settings into an existing bot, re-asserts its permissions and audits a summary', async () => {
    const existing = botRow({
      id: 'm1',
      type: 'moderation',
      name: 'Moderation Bot',
      tokenHash: null,
      permissions: ['moderate_messages', 'administrator'],
      settings: { blockedWords: ['old'], linkPolicy: 'block' },
    });
    ensureBuiltInBot.mockResolvedValue({ bot: existing, created: false });
    const { PUT } = await import('../builtin/[type]/route.js');
    const res = await PUT(
      req('PUT', '/x', OWNER, { settings: { blockedWords: ['salak*', 'SALAK*', 'kötü'] } }),
      builtinCtx('moderation')
    );
    expect(res.status).toBe(200);
    const patch = updateBot.mock.calls[0]![2] as { settings: Record<string, unknown>; permissions: string[] };
    expect(patch.settings).toMatchObject({ blockedWords: ['salak*', 'kötü'], linkPolicy: 'block' });
    expect(patch.permissions).toEqual(['read_messages', 'moderate_messages', 'send_messages']);
    const [audit] = auditCalls('bot.update');
    expect(audit!.metadata.changes).toMatchObject({ settings: { blockedWords: 2, linkPolicy: 'block' } });
    // The audit log gets counts, not the word list.
    expect(JSON.stringify(audit)).not.toContain('salak');
  });

  it('toggles an existing built-in bot as enable/disable', async () => {
    ensureBuiltInBot.mockResolvedValue({ bot: welcomeRow({}, { enabled: true }), created: false });
    const { PUT } = await import('../builtin/[type]/route.js');
    const res = await PUT(req('PUT', '/x', OWNER, { enabled: false }), builtinCtx('welcome'));
    expect(res.status).toBe(200);
    expect(auditCalls('bot.disable')).toHaveLength(1);
  });
});
