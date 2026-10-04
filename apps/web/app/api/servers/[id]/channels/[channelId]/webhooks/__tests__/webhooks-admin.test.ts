import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Admin → Channels → incoming webhooks (BOT_API_V2 §5.1, §1.3): Manage
 * Channels + seeing the channel; the token (and the URL holding it) is
 * returned once and stored only as a hash; rotate, enable/disable, delete;
 * every change audited without the token.
 */

const db = {
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  getChannelById: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  listChannelWebhooks: vi.fn(),
  countChannelWebhooks: vi.fn(),
  createChannelWebhook: vi.fn(),
  getChannelWebhookById: vi.fn(),
  updateChannelWebhook: vi.fn(),
  deleteChannelWebhook: vi.fn(),
  logAction: vi.fn(),
};
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/chat-bus', () => ({ publishChatMessage: vi.fn() }));

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const CHANNEL_MANAGER = '33333333-3333-4333-8333-333333333333';
const SERVER_MANAGER = '77777777-7777-4777-8777-777777777771';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const GENERAL = '22222222-2222-4222-8222-222222222222';
const VOICE = '66666666-6666-4666-8666-666666666666';
const OTHER = '88888888-8888-4888-8888-888888888888';
const WEBHOOK = '0e7c0e7c-0e7c-4e7c-8e7c-0e7c0e7c0e7c';

const PERMS: Record<string, string[]> = {
  [OWNER]: ['administrator'],
  [CHANNEL_MANAGER]: ['manage_channels'],
  [SERVER_MANAGER]: ['manage_server'],
  [MEMBER]: ['send_messages'],
};
const CHANNELS: Record<string, { id: string; serverId: string; type: string; name: string }> = {
  [GENERAL]: { id: GENERAL, serverId: SERVER, type: 'text', name: 'general' },
  [VOICE]: { id: VOICE, serverId: SERVER, type: 'voice', name: 'Lounge' },
  [OTHER]: { id: OTHER, serverId: SERVER, type: 'text', name: 'other' },
};

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Tester' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}

function req(method: string, path: string, uid: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (uid) h.cookie = cookie(uid);
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(`https://chat.example.test/api/servers/${SERVER}/channels/${GENERAL}/webhooks${path}`, {
    method,
    headers: h,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function webhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK, serverId: SERVER, channelId: GENERAL, name: 'CI', tokenHash: `sha256$${'a'.repeat(64)}`, enabled: true,
    createdBy: OWNER, createdByName: 'Owner', createdAt: new Date('2026-10-03T00:00:00Z'), updatedAt: new Date('2026-10-03T00:00:00Z'),
    lastUsedAt: null, ...overrides,
  };
}

const listCtx = (channelId = GENERAL) => ({ params: Promise.resolve({ id: SERVER, channelId }) });
const oneCtx = (webhookId = WEBHOOK, channelId = GENERAL) => ({ params: Promise.resolve({ id: SERVER, channelId, webhookId }) });

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  delete process.env.LOBBYFORGE_APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  for (const fn of Object.values(db)) fn.mockReset();
  db.getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  db.isServerMember.mockImplementation(async (_db: unknown, uid: string) => uid in PERMS);
  db.getUserPermissions.mockImplementation(async (_db: unknown, uid: string) => PERMS[uid] ?? []);
  db.getChannelById.mockImplementation(async (_db: unknown, id: string) => CHANNELS[id] ?? null);
  db.canMemberAccessChannel.mockResolvedValue(true);
  db.listChannelWebhooks.mockResolvedValue([webhookRow()]);
  db.countChannelWebhooks.mockResolvedValue(0);
  db.createChannelWebhook.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => webhookRow(input));
  db.getChannelWebhookById.mockResolvedValue(webhookRow());
  db.updateChannelWebhook.mockImplementation(async (_db: unknown, _id: string, patch: Record<string, unknown>) => webhookRow(patch));
  db.deleteChannelWebhook.mockResolvedValue(true);
  db.logAction.mockResolvedValue(undefined);
});

describe('who manages webhooks', () => {
  it('401 without a session; 403 without Manage Channels (Manage Community is not enough)', async () => {
    const route = await import('../route.js');
    expect((await route.GET(req('GET', '', null), listCtx())).status).toBe(401);
    expect((await route.GET(req('GET', '', MEMBER), listCtx())).status).toBe(403);
    expect((await route.GET(req('GET', '', SERVER_MANAGER), listCtx())).status).toBe(403);
    expect((await route.GET(req('GET', '', CHANNEL_MANAGER), listCtx())).status).toBe(200);
  });

  it('only text channels of this server', async () => {
    const route = await import('../route.js');
    expect((await route.POST(req('POST', '', OWNER, { name: 'CI' }), listCtx(VOICE))).status).toBe(400);
    expect((await route.POST(req('POST', '', OWNER, { name: 'CI' }), listCtx('12345678-1234-4234-8234-123456789012'))).status).toBe(404);
  });
});

describe('create / list', () => {
  it('201 with the token and URL ONCE; the stored hash verifies the token; the audit never sees it', async () => {
    const { hashWebhookToken, verifyWebhookToken } = await import('@/lib/bots/webhooks');
    const route = await import('../route.js');
    const res = await route.POST(req('POST', '', CHANNEL_MANAGER, { name: '  Deploy   bot ' }, { origin: 'https://chat.example.test' }), listCtx());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^lfw_[A-Za-z0-9_-]{43}$/);
    expect(body.url).toBe(`https://chat.example.test/api/webhooks/${body.webhook.id}/${body.token}`);
    const input = db.createChannelWebhook.mock.calls[0]![1];
    expect(input).toMatchObject({ serverId: SERVER, channelId: GENERAL, name: 'Deploy bot', createdBy: CHANNEL_MANAGER });
    expect(input.tokenHash).toBe(hashWebhookToken(body.token));
    expect(verifyWebhookToken(body.token, input.tokenHash)).toBe(true);
    expect(body.webhook.tokenHash).toBeUndefined();
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'webhook.create', targetType: 'webhook' }));
    expect(JSON.stringify(db.logAction.mock.calls)).not.toContain(body.token);

    const list = await (await route.GET(req('GET', '', CHANNEL_MANAGER), listCtx())).json();
    expect(JSON.stringify(list)).not.toContain('sha256$');
    expect(list.webhooks[0]).toMatchObject({ id: WEBHOOK, name: 'CI', enabled: true });
  });

  it('validates the name and caps a channel at 10 webhooks', async () => {
    const route = await import('../route.js');
    for (const name of ['', '   ', 'x'.repeat(33), 'bad\u0000name']) {
      expect((await route.POST(req('POST', '', OWNER, { name }), listCtx())).status).toBe(400);
    }
    expect((await route.POST(req('POST', '', OWNER, { name: 'CI', token: 'mine' }), listCtx())).status).toBe(400);
    db.countChannelWebhooks.mockResolvedValue(10);
    const full = await route.POST(req('POST', '', OWNER, { name: 'CI' }), listCtx());
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: 'webhook_limit_reached' });
  });
});

describe('update / rotate / delete', () => {
  it('disable and enable are audited as such; a rename as an update', async () => {
    const route = await import('../[webhookId]/route.js');
    expect((await route.PATCH(req('PATCH', `/${WEBHOOK}`, OWNER, { enabled: false }), oneCtx())).status).toBe(200);
    expect(db.logAction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'webhook.disable' }));
    db.getChannelWebhookById.mockResolvedValue(webhookRow({ enabled: false }));
    await route.PATCH(req('PATCH', `/${WEBHOOK}`, OWNER, { enabled: true }), oneCtx());
    expect(db.logAction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'webhook.enable' }));
    await route.PATCH(req('PATCH', `/${WEBHOOK}`, OWNER, { name: 'Builds' }), oneCtx());
    expect(db.logAction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'webhook.update' }));
    expect((await route.PATCH(req('PATCH', `/${WEBHOOK}`, OWNER, {}), oneCtx())).status).toBe(400);
  });

  it('a webhook of another channel is 404 here', async () => {
    db.getChannelWebhookById.mockResolvedValue(webhookRow({ channelId: OTHER }));
    const route = await import('../[webhookId]/route.js');
    expect((await route.PATCH(req('PATCH', `/${WEBHOOK}`, OWNER, { enabled: false }), oneCtx())).status).toBe(404);
    expect((await route.DELETE(req('DELETE', `/${WEBHOOK}`, OWNER), oneCtx())).status).toBe(404);
    expect(db.updateChannelWebhook).not.toHaveBeenCalled();
    expect(db.deleteChannelWebhook).not.toHaveBeenCalled();
  });

  it('rotate issues a new token once (the old hash is replaced); delete removes it', async () => {
    const { hashWebhookToken } = await import('@/lib/bots/webhooks');
    const rotate = await import('../[webhookId]/token/route.js');
    const res = await rotate.POST(req('POST', `/${WEBHOOK}/token`, OWNER), oneCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(db.updateChannelWebhook).toHaveBeenCalledWith(expect.anything(), WEBHOOK, { tokenHash: hashWebhookToken(body.token) });
    expect(db.logAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'webhook.token.rotate' }));
    const route = await import('../[webhookId]/route.js');
    expect((await route.DELETE(req('DELETE', `/${WEBHOOK}`, OWNER), oneCtx())).status).toBe(200);
    expect(db.logAction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'webhook.delete' }));
  });
});
