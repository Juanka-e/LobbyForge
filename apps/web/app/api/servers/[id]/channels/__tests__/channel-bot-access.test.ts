import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Bot API v2 §1.1 — what a channel's own lifecycle does to bot access,
 * through the real channel route and `lib/bots/channel-changes.ts`:
 *   - DELETE: the bots granted the channel are read first (the rows
 *     cascade), then audited and told (`bot-access` + endpoint), every
 *     stream re-checks (`channel-policy`) and the fan-out cache is dropped;
 *   - PATCH visibleToRoleIds (non-empty): grants made by someone who cannot
 *     manage channels are dropped — the owner's and Manage Channels
 *     holders' grants stay.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getChannelById: vi.fn(),
  getUserPermissions: vi.fn(),
  updateChannel: vi.fn(),
  deleteChannel: vi.fn(),
  listRolesBriefForServer: vi.fn(),
  setChannelRoleOverrides: vi.fn(),
  logAction: vi.fn(),
  listBotChannelGrantsForChannel: vi.fn(),
  revokeBotChannelGrantsForChannel: vi.fn(),
  listBotsForServer: vi.fn(),
  // announceChannelAccessChange → listBotChannels + the fan-out cache
  getBotReachableChannel: vi.fn(),
  listBotReachableChannels: vi.fn(),
  listBotEventTargets: vi.fn(),
  listBotChannelAccessForServer: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  applySecurityHeaders: (r: unknown) => r,
}));
const publishAccessInvalidation = vi.fn();
vi.mock('@/lib/access-invalidation', () => ({ publishAccessInvalidation }));
vi.mock('@/lib/redis', () => ({ redis: { publish: vi.fn(async () => 1) } }));
const enqueueDelivery = vi.fn();
vi.mock('@/lib/bots/event-delivery', () => ({ enqueueDelivery }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const ROLE = '66666666-6666-4666-8666-666666666666';
const OWNER = '44444444-4444-4444-8444-444444444444';
const CHANNEL_MANAGER = '77777777-7777-4777-8777-777777777777';
const BOT_MANAGER = '33333333-3333-4333-8333-333333333333';
const GONE = '99999999-9999-4999-8999-999999999999';

const PERMS: Record<string, string[]> = {
  [OWNER]: ['administrator'],
  [CHANNEL_MANAGER]: ['manage_channels', 'send_messages'],
  [BOT_MANAGER]: ['manage_server', 'send_messages'],
};

const bot = (id: string) => ({ id, serverId: SERVER, name: `Bot ${id}`, type: 'custom', permissions: [], enabled: true });

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'T' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function call(method: 'PATCH' | 'DELETE', uid: string, body?: unknown) {
  return new Request(`https://e.test/api/servers/${SERVER}/channels/${CHANNEL}`, {
    method,
    headers: { cookie: cookie(uid), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const ctx = { params: Promise.resolve({ id: SERVER, channelId: CHANNEL }) };

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [...Object.values(db), publishAccessInvalidation, enqueueDelivery]) fn.mockReset();
  const channel = { id: CHANNEL, serverId: SERVER, name: 'ops', type: 'text', position: 0, pluginId: null, topic: null, createdAt: new Date() };
  db.getServerById.mockResolvedValue({ id: SERVER, ownerUserId: OWNER });
  db.isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid in PERMS);
  db.getChannelById.mockResolvedValue(channel);
  db.getUserPermissions.mockImplementation(async (_db: unknown, uid: string) => PERMS[uid] ?? []);
  db.updateChannel.mockResolvedValue(channel);
  db.deleteChannel.mockResolvedValue(undefined);
  db.listRolesBriefForServer.mockResolvedValue([{ id: ROLE, name: 'Staff', position: 1 }]);
  db.setChannelRoleOverrides.mockResolvedValue(undefined);
  db.logAction.mockResolvedValue(undefined);
  db.listBotChannelGrantsForChannel.mockResolvedValue([]);
  db.revokeBotChannelGrantsForChannel.mockImplementation(async (_db: unknown, _channel: string, ids: string[]) => ids);
  db.listBotsForServer.mockResolvedValue(['bot-a', 'bot-b', 'bot-c', 'bot-d'].map(bot));
  db.listBotReachableChannels.mockResolvedValue([]);
  db.listBotEventTargets.mockResolvedValue([]);
  db.listBotChannelAccessForServer.mockResolvedValue(new Map());
});

function botAccessEvents() {
  return publishAccessInvalidation.mock.calls.map((c) => c[0]).filter((e) => e.kind === 'bot-access');
}

describe('DELETE a channel — the bots granted it lose it, never widen', () => {
  it('reads the grants BEFORE deleting, then audits and tells every bot that had one', async () => {
    db.listBotChannelGrantsForChannel.mockResolvedValue([
      { botId: 'bot-a', grantedBy: OWNER },
      { botId: 'bot-b', grantedBy: null },
    ]);
    const { DELETE } = await import('../[channelId]/route.js');
    const res = await DELETE(call('DELETE', OWNER), ctx);
    expect(res.status).toBe(200);
    expect(db.listBotChannelGrantsForChannel.mock.invocationCallOrder[0]!).toBeLessThan(db.deleteChannel.mock.invocationCallOrder[0]!);
    await vi.waitFor(() =>
      expect(botAccessEvents()).toEqual([
        { kind: 'bot-access', serverId: SERVER, botId: 'bot-a', reason: 'channel_access_changed' },
        { kind: 'bot-access', serverId: SERVER, botId: 'bot-b', reason: 'channel_access_changed' },
      ])
    );
    // Every stream on the channel (incl. `all`-mode bots) re-checks.
    expect(publishAccessInvalidation).toHaveBeenCalledWith({ kind: 'channel-policy', serverId: SERVER, channelId: CHANNEL, reason: 'permissions_changed' });
    for (const botId of ['bot-a', 'bot-b']) {
      expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'bot.channel_access',
        targetType: 'bot',
        targetId: botId,
        actorUserId: OWNER,
        metadata: expect.objectContaining({ mode: 'selected', added: [], removed: [CHANNEL], reason: 'channel_deleted' }),
      }));
    }
  });

  it('drops the bot event-target cache of the server', async () => {
    const events = await import('@/lib/bots/events');
    await events.getBotEventTargets(SERVER);
    await events.getBotEventTargets(SERVER);
    expect(db.listBotEventTargets).toHaveBeenCalledTimes(1);
    const { DELETE } = await import('../[channelId]/route.js');
    expect((await DELETE(call('DELETE', OWNER), ctx)).status).toBe(200);
    await events.getBotEventTargets(SERVER);
    expect(db.listBotEventTargets).toHaveBeenCalledTimes(2);
  });

  it('a channel no bot was granted still re-checks live streams, with no bot audit', async () => {
    const { DELETE } = await import('../[channelId]/route.js');
    expect((await DELETE(call('DELETE', OWNER), ctx)).status).toBe(200);
    await vi.waitFor(() => expect(publishAccessInvalidation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'channel-policy' })));
    expect(botAccessEvents()).toEqual([]);
    expect(db.logAction).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'bot.channel_access' }));
  });

  it('a member without Manage Channels cannot delete — nothing is read or announced', async () => {
    const { DELETE } = await import('../[channelId]/route.js');
    expect((await DELETE(call('DELETE', BOT_MANAGER), ctx)).status).toBe(403);
    expect(db.listBotChannelGrantsForChannel).not.toHaveBeenCalled();
    expect(db.deleteChannel).not.toHaveBeenCalled();
    expect(publishAccessInvalidation).not.toHaveBeenCalled();
  });
});

describe('PATCH visibleToRoleIds — a channel turning private keeps only proper grants', () => {
  it('drops grants by someone without Manage Channels (or gone); keeps the owner’s and a channel manager’s', async () => {
    db.listBotChannelGrantsForChannel.mockResolvedValue([
      { botId: 'bot-a', grantedBy: BOT_MANAGER }, // Manage Community only
      { botId: 'bot-b', grantedBy: OWNER },
      { botId: 'bot-c', grantedBy: CHANNEL_MANAGER },
      { botId: 'bot-d', grantedBy: GONE }, // left the server
    ]);
    const { PATCH } = await import('../[channelId]/route.js');
    const res = await PATCH(call('PATCH', CHANNEL_MANAGER, { visibleToRoleIds: [ROLE] }), ctx);
    expect(res.status).toBe(200);
    expect(db.revokeBotChannelGrantsForChannel).toHaveBeenCalledWith(expect.anything(), CHANNEL, ['bot-a', 'bot-d']);
    // Checked before the channel-policy invalidation, so streams recompute without them.
    expect(db.revokeBotChannelGrantsForChannel.mock.invocationCallOrder[0]!).toBeLessThan(
      publishAccessInvalidation.mock.invocationCallOrder.find((_, i) => publishAccessInvalidation.mock.calls[i]![0].kind === 'channel-policy')!
    );
    await vi.waitFor(() => expect(botAccessEvents().map((e) => e.botId).sort()).toEqual(['bot-a', 'bot-d']));
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'bot.channel_access',
      targetId: 'bot-a',
      actorUserId: CHANNEL_MANAGER,
      metadata: expect.objectContaining({ removed: [CHANNEL], reason: 'channel_restricted', name: 'Bot bot-a' }),
    }));
    expect(db.logAction).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetId: 'bot-b' }));
    expect(db.logAction).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetId: 'bot-c' }));
  });

  it('every grant made by a proper granter stays: nothing revoked, no bot told', async () => {
    db.listBotChannelGrantsForChannel.mockResolvedValue([{ botId: 'bot-b', grantedBy: OWNER }]);
    const { PATCH } = await import('../[channelId]/route.js');
    expect((await PATCH(call('PATCH', OWNER, { visibleToRoleIds: [ROLE] }), ctx)).status).toBe(200);
    expect(db.revokeBotChannelGrantsForChannel).not.toHaveBeenCalled();
    expect(botAccessEvents()).toEqual([]);
  });

  it('opening a channel to everyone, or a name change, never touches grants', async () => {
    const { PATCH } = await import('../[channelId]/route.js');
    expect((await PATCH(call('PATCH', OWNER, { visibleToRoleIds: [] }), ctx)).status).toBe(200);
    expect((await PATCH(call('PATCH', OWNER, { name: 'renamed' }), ctx)).status).toBe(200);
    expect(db.listBotChannelGrantsForChannel).not.toHaveBeenCalled();
  });

  it('if the grant cleanup fails the request fails (a retry re-runs it — the rule is re-checked on every restriction)', async () => {
    db.listBotChannelGrantsForChannel.mockRejectedValue(new Error('db down'));
    const { PATCH } = await import('../[channelId]/route.js');
    expect((await PATCH(call('PATCH', OWNER, { visibleToRoleIds: [ROLE] }), ctx)).status).toBe(500);
  });
});
