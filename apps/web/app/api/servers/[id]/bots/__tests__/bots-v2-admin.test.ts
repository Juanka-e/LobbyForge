import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Admin → Bots for Bot API v2: per-bot channel access (§1.1 — the mode is
 * stored; role-gated channels need Manage Channels; private channels a
 * manager cannot see are never named nor dropped; revoking the last grant
 * leaves the bot with NO channel, never "every channel"), the event
 * endpoint's status / re-enable, and the managers' command switches. Real
 * session cookies and permission helpers.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  getBotById: vi.fn(),
  listChannelsForServer: vi.fn(),
  listBotAccessibleChannels: vi.fn(),
  getBotChannelAccessState: vi.fn(),
  listVisibleChannelsForMember: vi.fn(),
  setBotChannelAccess: vi.fn(),
  grantBotChannelAccess: vi.fn(),
  revokeBotChannelAccess: vi.fn(),
  listBotReachableChannels: vi.fn(),
  listBotEventTargets: vi.fn(),
  listBotChannelAccessForServer: vi.fn(),
  logAction: vi.fn(),
  getBotEventEndpoint: vi.fn(),
  reenableBotEventEndpoint: vi.fn(),
  deleteBotEventEndpoint: vi.fn(),
  listBotCommands: vi.fn(),
  getBotCommandById: vi.fn(),
  updateBotCommandAdmin: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 }),
}));
const publishAccessInvalidation = vi.fn();
vi.mock('@/lib/access-invalidation', () => ({ publishAccessInvalidation }));
vi.mock('@/lib/redis', () => ({ redis: { publish: vi.fn(async () => 1) } }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const MANAGER = '33333333-3333-4333-8333-333333333333';
const CHANNEL_MANAGER = '77777777-7777-4777-8777-777777777771';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const STAFF = '88888888-8888-4888-8888-888888888888';
const VAULT = '99999999-9999-4999-8999-999999999999';
const VOICE = '66666666-6666-4666-8666-666666666666';

const PERMS: Record<string, string[]> = {
  [OWNER]: ['administrator'],
  [MANAGER]: ['manage_server', 'send_messages'],
  [CHANNEL_MANAGER]: ['manage_server', 'manage_channels'],
  [MEMBER]: ['send_messages'],
};
const ch = (id: string, name: string, type = 'text', position = 0) => ({ id, serverId: SERVER, name, type, position, topic: null, pluginId: null, createdAt: new Date() });
const ALL_CHANNELS = [ch(GENERAL, 'general', 'text', 0), ch(STAFF, 'staff', 'text', 1), ch(VAULT, 'vault', 'text', 2), ch(VOICE, 'Lounge', 'voice', 3)];
let grants: string[];
let mode: 'all' | 'selected';

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function req(method: string, path: string, uid: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (uid) headers.cookie = cookie(uid);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://chat.example.test/api/servers/${SERVER}/bots/${BOT_ID}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const botCtx = { params: Promise.resolve({ id: SERVER, botId: BOT_ID }) };
const channelCtx = (channelId: string) => ({ params: Promise.resolve({ id: SERVER, botId: BOT_ID, channelId }) });

async function access() {
  return import('../[botId]/channel-access/route.js');
}
async function accessOne() {
  return import('../[botId]/channel-access/[channelId]/route.js');
}

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [...Object.values(db), publishAccessInvalidation]) fn.mockReset();
  grants = [];
  mode = 'all';
  db.getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  db.isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid in PERMS);
  db.getUserPermissions.mockImplementation(async (_db: unknown, uid: string) => PERMS[uid] ?? []);
  db.getBotById.mockResolvedValue({ id: BOT_ID, serverId: SERVER, name: 'Dice', type: 'custom', permissions: ['receive_events'], enabled: true });
  db.listChannelsForServer.mockResolvedValue(ALL_CHANNELS);
  db.listBotAccessibleChannels.mockResolvedValue([ALL_CHANNELS[0]]);
  db.getBotChannelAccessState.mockImplementation(async () => ({ mode, channelIds: [...grants] }));
  // MANAGER holds no role that opens #staff or #vault.
  db.listVisibleChannelsForMember.mockResolvedValue([ALL_CHANNELS[0], ALL_CHANNELS[3]]);
  db.setBotChannelAccess.mockImplementation(async (_db: unknown, input: { mode: 'all' | 'selected'; channelIds?: string[] }) => {
    mode = input.mode;
    grants = input.mode === 'all' ? [] : [...(input.channelIds ?? [])];
  });
  db.grantBotChannelAccess.mockImplementation(async (_db: unknown, input: { channelId: string }) => {
    if (mode !== 'selected' || grants.includes(input.channelId)) return false;
    grants.push(input.channelId);
    return true;
  });
  db.revokeBotChannelAccess.mockImplementation(async (_db: unknown, _bot: string, channelId: string) => {
    const before = grants.length;
    grants = grants.filter((id) => id !== channelId);
    return grants.length < before;
  });
  db.listBotReachableChannels.mockImplementation(async () =>
    mode === 'all' ? [ALL_CHANNELS[0]] : ALL_CHANNELS.filter((c) => grants.includes(c.id))
  );
  db.listBotEventTargets.mockResolvedValue([]);
  db.listBotChannelAccessForServer.mockResolvedValue(new Map());
  db.logAction.mockResolvedValue(undefined);
});

describe('channel access — GET', () => {
  it('needs Manage Community', async () => {
    const { GET } = await access();
    expect((await GET(req('GET', '/channel-access', null), botCtx)).status).toBe(401);
    expect((await GET(req('GET', '/channel-access', MEMBER), botCtx)).status).toBe(403);
  });

  it('shows the owner every text channel with its state', async () => {
    const { GET } = await access();
    const res = await GET(req('GET', '/channel-access', OWNER), botCtx);
    expect(res.status).toBe(200);
    const { access: view } = await res.json();
    expect(view.mode).toBe('all');
    expect(view.channels.map((c: { id: string; gated: boolean; reachable: boolean; grantable: boolean }) => [c.id, c.gated, c.reachable, c.grantable])).toEqual([
      [GENERAL, false, true, true],
      [STAFF, true, false, true],
      [VAULT, true, false, true],
    ]);
  });

  it('never names a private channel the manager cannot see — a grant on it is only counted', async () => {
    mode = 'selected';
    grants = [GENERAL, VAULT];
    const { GET } = await access();
    const { access: view } = await (await GET(req('GET', '/channel-access', MANAGER), botCtx)).json();
    expect(view.mode).toBe('selected');
    expect(view.channels.map((c: { id: string }) => c.id)).toEqual([GENERAL]);
    expect(view.hiddenGrantCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain(VAULT);
    expect(JSON.stringify(view)).not.toContain('vault');
  });

  it('404 for another server’s bot', async () => {
    db.getBotById.mockResolvedValue({ id: BOT_ID, serverId: '00000000-0000-4000-8000-000000000000', name: 'X', type: 'custom' });
    const { GET } = await access();
    expect((await GET(req('GET', '/channel-access', OWNER), botCtx)).status).toBe(404);
  });
});

describe('channel access — PUT (bulk)', () => {
  it('chooses channels, audits bot.channel_access and tells the gateway', async () => {
    const { PUT } = await access();
    const res = await PUT(req('PUT', '/channel-access', OWNER, { channelIds: [GENERAL, STAFF] }), botCtx);
    expect(res.status).toBe(200);
    expect(grants.sort()).toEqual([GENERAL, STAFF].sort());
    expect(db.setBotChannelAccess).toHaveBeenCalledWith(expect.anything(), {
      botId: BOT_ID,
      mode: 'selected',
      channelIds: expect.arrayContaining([GENERAL, STAFF]),
      grantedBy: OWNER,
    });
    expect((await res.json()).access.mode).toBe('selected');
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'bot.channel_access',
      targetId: BOT_ID,
      actorUserId: OWNER,
      metadata: expect.objectContaining({ mode: 'selected', added: expect.arrayContaining([GENERAL, STAFF]), removed: [] }),
    }));
    await vi.waitFor(() =>
      expect(publishAccessInvalidation).toHaveBeenCalledWith({ kind: 'bot-access', serverId: SERVER, botId: BOT_ID, reason: 'channel_access_changed' })
    );
  });

  it('§1.1: a role-gated channel needs Manage Channels', async () => {
    const { PUT } = await access();
    const res = await PUT(req('PUT', '/channel-access', MANAGER, { channelIds: [GENERAL, STAFF] }), botCtx);
    // MANAGER cannot even see #staff: it is not a channel they may name.
    expect(res.status).toBe(400);
    db.listVisibleChannelsForMember.mockResolvedValue([ALL_CHANNELS[0], ALL_CHANNELS[1]]);
    const seen = await PUT(req('PUT', '/channel-access', MANAGER, { channelIds: [GENERAL, STAFF] }), botCtx);
    expect(seen.status).toBe(403);
    expect(await seen.json()).toMatchObject({ code: 'cannot_grant_channel', channelIds: [STAFF] });
    expect(db.setBotChannelAccess).not.toHaveBeenCalled();
    expect((await PUT(req('PUT', '/channel-access', CHANNEL_MANAGER, { channelIds: [STAFF] }), botCtx)).status).toBe(200);
  });

  it('refuses voice channels, foreign ids and an empty list', async () => {
    const { PUT } = await access();
    for (const channelIds of [[VOICE], ['12345678-1234-4234-8234-123456789012'], []]) {
      expect((await PUT(req('PUT', '/channel-access', OWNER, { channelIds }), botCtx)).status).toBe(400);
    }
  });

  it('keeps grants on private channels the manager cannot see; switching to "all" over them needs Manage Channels', async () => {
    mode = 'selected';
    grants = [GENERAL, VAULT];
    const { PUT } = await access();
    // Replacing the visible part leaves #vault untouched.
    db.listVisibleChannelsForMember.mockResolvedValue([ALL_CHANNELS[0], ALL_CHANNELS[3]]);
    db.listBotAccessibleChannels.mockResolvedValue([ALL_CHANNELS[0]]);
    const res = await PUT(req('PUT', '/channel-access', MANAGER, { channelIds: [GENERAL] }), botCtx);
    expect(res.status).toBe(200);
    expect(grants.sort()).toEqual([GENERAL, VAULT].sort());
    const toAll = await PUT(req('PUT', '/channel-access', MANAGER, { channelIds: null }), botCtx);
    expect(toAll.status).toBe(403);
    expect(await toAll.json()).toMatchObject({ code: 'cannot_change_hidden_access' });
    expect((await PUT(req('PUT', '/channel-access', OWNER, { channelIds: null }), botCtx)).status).toBe(200);
    expect(grants).toEqual([]);
    expect(mode).toBe('all');
    expect(db.setBotChannelAccess).toHaveBeenLastCalledWith(expect.anything(), { botId: BOT_ID, mode: 'all' });
  });

  it('a bot left with no channel (selected, no grants) is shown as such, and null switches it back to all', async () => {
    mode = 'selected';
    grants = [];
    const { GET, PUT } = await access();
    const { access: view } = await (await GET(req('GET', '/channel-access', OWNER), botCtx)).json();
    expect(view.mode).toBe('selected');
    // Nothing is reachable — not even the open #general.
    expect(view.channels.filter((c: { reachable: boolean }) => c.reachable)).toEqual([]);
    // The mode switch alone is a change (no grant is added or removed).
    const res = await PUT(req('PUT', '/channel-access', OWNER, { channelIds: null }), botCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).access.mode).toBe('all');
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'bot.channel_access',
      metadata: expect.objectContaining({ mode: 'all', added: [], removed: [] }),
    }));
    await vi.waitFor(() =>
      expect(publishAccessInvalidation).toHaveBeenCalledWith({ kind: 'bot-access', serverId: SERVER, botId: BOT_ID, reason: 'channel_access_changed' })
    );
  });

  it('PUT null on a bot already in mode all changes nothing', async () => {
    const { PUT } = await access();
    expect((await PUT(req('PUT', '/channel-access', OWNER, { channelIds: null }), botCtx)).status).toBe(200);
    expect(db.setBotChannelAccess).not.toHaveBeenCalled();
    expect(db.logAction).not.toHaveBeenCalled();
  });
});

describe('channel access — one channel', () => {
  it('409 access_mode_all: one grant would silently narrow "every open channel"', async () => {
    const { PUT } = await accessOne();
    const res = await PUT(req('PUT', `/channel-access/${STAFF}`, OWNER), channelCtx(STAFF));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'access_mode_all' });
  });

  it('grants and revokes in selected mode; revoking the LAST grant leaves the bot with no channel', async () => {
    mode = 'selected';
    grants = [GENERAL];
    const { PUT, DELETE } = await accessOne();
    expect((await PUT(req('PUT', `/channel-access/${STAFF}`, OWNER), channelCtx(STAFF))).status).toBe(200);
    expect(grants).toEqual([GENERAL, STAFF]);
    expect((await DELETE(req('DELETE', `/channel-access/${GENERAL}`, OWNER), channelCtx(GENERAL))).status).toBe(200);
    expect(grants).toEqual([STAFF]);
    const last = await DELETE(req('DELETE', `/channel-access/${STAFF}`, OWNER), channelCtx(STAFF));
    expect(last.status).toBe(200);
    const { access: view } = await last.json();
    expect(grants).toEqual([]);
    // Still selected: the bot reaches NOTHING (never "every open channel").
    expect(view.mode).toBe('selected');
    expect(view.channels.filter((c: { reachable: boolean }) => c.reachable)).toEqual([]);
    expect(db.logAction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      action: 'bot.channel_access',
      metadata: expect.objectContaining({ mode: 'selected', added: [], removed: [STAFF] }),
    }));
  });

  it('two concurrent revokes of the last two grants both succeed and leave no channel', async () => {
    mode = 'selected';
    grants = [GENERAL, STAFF];
    const { DELETE } = await accessOne();
    const [a, b] = await Promise.all([
      DELETE(req('DELETE', `/channel-access/${GENERAL}`, OWNER), channelCtx(GENERAL)),
      DELETE(req('DELETE', `/channel-access/${STAFF}`, OWNER), channelCtx(STAFF)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(grants).toEqual([]);
    expect(mode).toBe('selected');
  });

  it('a gated grant needs Manage Channels; an invisible or voice channel is 404', async () => {
    mode = 'selected';
    grants = [GENERAL];
    db.listVisibleChannelsForMember.mockResolvedValue([ALL_CHANNELS[0], ALL_CHANNELS[1]]);
    const { PUT } = await accessOne();
    const res = await PUT(req('PUT', `/channel-access/${STAFF}`, MANAGER), channelCtx(STAFF));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'cannot_grant_channel' });
    expect((await PUT(req('PUT', `/channel-access/${VAULT}`, MANAGER), channelCtx(VAULT))).status).toBe(404);
    expect((await PUT(req('PUT', `/channel-access/${VOICE}`, OWNER), channelCtx(VOICE))).status).toBe(404);
  });
});

describe('event endpoint (managers)', () => {
  const stored = { botId: BOT_ID, url: 'https://bot.example.com/hook', secret: `whsec_${'s'.repeat(43)}`, events: ['interaction_create'], enabled: false, failureCount: 20, disabledReason: 'too_many_failures', lastDeliveryAt: new Date('2026-10-03T10:00:00Z'), lastStatus: 503, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-03T10:00:00Z') };

  it('shows status without the secret, re-enables and removes — Manage Community only', async () => {
    const route = await import('../[botId]/event-endpoint/route.js');
    expect((await route.GET(req('GET', '/event-endpoint', MEMBER), botCtx)).status).toBe(403);
    db.getBotEventEndpoint.mockResolvedValue(stored);
    const status = await (await route.GET(req('GET', '/event-endpoint', MANAGER), botCtx)).json();
    expect(status.endpoint).toMatchObject({ url: stored.url, enabled: false, failureCount: 20, disabledReason: 'too_many_failures', lastStatus: 503 });
    expect(JSON.stringify(status)).not.toContain('whsec_');

    db.reenableBotEventEndpoint.mockResolvedValue({ ...stored, enabled: true, failureCount: 0, disabledReason: null });
    const enabled = await route.PATCH(req('PATCH', '/event-endpoint', MANAGER, { enabled: true }), botCtx);
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).endpoint).toMatchObject({ enabled: true, failureCount: 0 });
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'bot.event_endpoint.enable' }));
    expect((await route.PATCH(req('PATCH', '/event-endpoint', MANAGER, { enabled: false }), botCtx)).status).toBe(400);

    db.deleteBotEventEndpoint.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await route.DELETE(req('DELETE', '/event-endpoint', MANAGER), botCtx)).status).toBe(200);
    expect((await route.DELETE(req('DELETE', '/event-endpoint', MANAGER), botCtx)).status).toBe(404);
  });
});

describe('registered commands (managers)', () => {
  const command = { id: '12121212-1212-4212-8212-121212121212', botId: BOT_ID, serverId: SERVER, name: 'roll', description: 'Roll', options: [], channelIds: null, adminChannelIds: null, requiredPermission: null, enabled: true, createdAt: new Date(), updatedAt: new Date() };
  const cmdCtx = { params: Promise.resolve({ id: SERVER, botId: BOT_ID, commandId: command.id }) };

  it('lists a bot’s commands; switches one off or restricts it to text channels of this server', async () => {
    const list = await import('../[botId]/commands/route.js');
    db.listBotCommands.mockResolvedValue([command]);
    const listed = await (await list.GET(req('GET', '/commands', MANAGER), botCtx)).json();
    expect(listed.commands[0]).toMatchObject({ name: 'roll', enabled: true, adminChannelIds: null });

    const one = await import('../[botId]/commands/[commandId]/route.js');
    db.getBotCommandById.mockResolvedValue(command);
    db.updateBotCommandAdmin.mockImplementation(async (_db: unknown, _id: string, patch: Record<string, unknown>) => ({ ...command, ...patch }));
    const off = await one.PATCH(req('PATCH', `/commands/${command.id}`, MANAGER, { enabled: false, channelIds: [GENERAL] }), cmdCtx);
    expect(off.status).toBe(200);
    expect(db.updateBotCommandAdmin).toHaveBeenCalledWith(expect.anything(), command.id, {
      enabled: false,
      adminChannelIds: [GENERAL],
      updatedBy: MANAGER,
    });
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'bot.command.update' }));
    expect((await one.PATCH(req('PATCH', `/commands/${command.id}`, MANAGER, { channelIds: [VOICE] }), cmdCtx)).status).toBe(400);
    expect((await one.PATCH(req('PATCH', `/commands/${command.id}`, MANAGER, {}), cmdCtx)).status).toBe(400);
    expect((await one.PATCH(req('PATCH', `/commands/${command.id}`, MEMBER, { enabled: false }), cmdCtx)).status).toBe(403);
    db.getBotCommandById.mockResolvedValue({ ...command, botId: 'another-bot' });
    expect((await one.PATCH(req('PATCH', `/commands/${command.id}`, MANAGER, { enabled: false }), cmdCtx)).status).toBe(404);
  });
});
