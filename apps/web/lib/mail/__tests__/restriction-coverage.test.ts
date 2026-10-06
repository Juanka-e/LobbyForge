/**
 * docs/EMAIL.md §4.2 — every route behind a restricted action calls
 * `requireVerifiedEmail(user, action)` and answers its 403
 * `{ "error": "email_unverified" }` before doing anything.
 *
 * One test per protected action: the gate is mocked to refuse, the route's
 * earlier guards (session, membership, permission) are mocked to pass, and
 * the route must come back with the gate's 403 having named the right
 * action for the signed-in account. A static check pins the list, so a
 * refactor cannot silently drop a gate.
 *
 * The rules themselves (who is restricted) are in verification.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ requireVerifiedEmail: vi.fn() }));

vi.mock('@/lib/mail/verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail/verification')>()),
  requireVerifiedEmail: h.requireVerifiedEmail,
}));
vi.mock('@lobbyforge/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) mocked[key] = typeof value === 'function' ? vi.fn(async () => null) : value;
  return mocked;
});
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/deployment-mode', () => ({ isOfficialDeployment: () => true, getDeploymentMode: () => 'official' }));
vi.mock('@/lib/security-headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security-headers')>()),
  withApiSecurity: (handler: unknown) => handler,
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 }),
}));
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/permissions')>()),
  authorizeServerPermission: async () => ({ ok: true, permissions: ['ADMINISTRATOR'] }),
}));
vi.mock('@/lib/message-authorization', () => ({
  authorizeChannelMessageAccess: async () => ({ ok: true, context: { server: { ownerUserId: 'someone-else' }, channel: { id: CHANNEL } } }),
}));
vi.mock('@/lib/bots/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bots/admin')>()),
  requireBotManager: async () => ({ ok: true, manager: { uid: UID, server: { id: SERVER, ownerUserId: UID, name: 'S' }, permissions: [], isOwner: true } }),
}));
vi.mock('@/lib/bots/webhooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bots/webhooks')>()),
  requireWebhookManager: async () => ({ ok: true, manager: { uid: UID, server: { id: SERVER, ownerUserId: UID }, channel: { id: CHANNEL } } }),
}));

import * as db from '@lobbyforge/db';
import { buildGuestSessionCookie } from '@/lib/guest-session';
import type { VerifiedAction } from '../types';

const SECRET = 's'.repeat(48);
const UID = '33333333-3333-4333-8333-333333333333';
const SERVER = '44444444-4444-4444-8444-444444444444';
const CHANNEL = '55555555-5555-4555-8555-555555555555';
const MESSAGE = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';

function cookie(): string {
  return `lf_guest=${buildGuestSessionCookie({ gid: 'g_'.padEnd(34, 'b'), uid: UID, name: 'Member' }, SECRET).raw}`;
}

function request(path: string, method: string, body: unknown): Request {
  return new Request(`https://community.example${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookie(), origin: 'https://community.example' },
    ...(method === 'GET' || body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  load: () => Promise<Record<string, unknown>>,
  method: string,
  path: string,
  body: unknown,
  params: Record<string, string> = {}
): Promise<Response> {
  const mod = await load();
  const handler = mod[method] as Handler;
  return handler(request(path, method, body), { params: Promise.resolve(params) });
}

async function expectRefused(response: Response, action: VerifiedAction): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'email_unverified' });
  expect(h.requireVerifiedEmail).toHaveBeenCalledWith(UID, action);
}

beforeEach(() => {
  vi.stubEnv('LOBBYFORGE_SESSION_SECRET', SECRET);
  h.requireVerifiedEmail.mockReset().mockImplementation(async () => NextResponse.json({ error: 'email_unverified' }, { status: 403 }));
  // The message PATCH loads the message before deciding it is an edit.
  vi.mocked(db.getMessageById).mockResolvedValue({
    id: MESSAGE,
    channelId: CHANNEL,
    userId: UID,
    botId: null,
    content: 'old',
    metadata: {},
    replyToId: null,
    createdAt: new Date(),
    editedAt: null,
    deletedAt: null,
  } as unknown as Awaited<ReturnType<typeof db.getMessageById>>);
  vi.mocked(db.getActiveMemberTimeout).mockResolvedValue(null);
});

describe('every protected action is gated (docs/EMAIL.md §4.2)', { timeout: 30_000 }, () => {
  it('message: posting in a channel', async () => {
    const res = await call(() => import('@/app/api/servers/[id]/channels/[channelId]/messages/route'), 'POST', `/api/servers/${SERVER}/channels/${CHANNEL}/messages`, { content: 'hi' }, { id: SERVER, channelId: CHANNEL });
    await expectRefused(res, 'message');
  });

  it('message: editing a message’s text (pinning is not gated)', async () => {
    const load = () => import('@/app/api/servers/[id]/channels/[channelId]/messages/[messageId]/route');
    const params = { id: SERVER, channelId: CHANNEL, messageId: MESSAGE };
    await expectRefused(await call(load, 'PATCH', `/api/servers/${SERVER}/channels/${CHANNEL}/messages/${MESSAGE}`, { content: 'new' }, params), 'message');
    h.requireVerifiedEmail.mockClear();
    await call(load, 'PATCH', `/api/servers/${SERVER}/channels/${CHANNEL}/messages/${MESSAGE}`, { pinned: true }, params);
    expect(h.requireVerifiedEmail).not.toHaveBeenCalled();
  });

  it('message: invoking a slash command (it posts into the channel)', async () => {
    const res = await call(
      () => import('@/app/api/servers/[id]/channels/[channelId]/commands/[commandId]/invoke/route'),
      'POST',
      `/api/servers/${SERVER}/channels/${CHANNEL}/commands/${OTHER}/invoke`,
      { options: {} },
      { id: SERVER, channelId: CHANNEL, commandId: OTHER }
    );
    await expectRefused(res, 'message');
  });

  it('dm: opening a conversation and sending a direct message', async () => {
    await expectRefused(await call(() => import('@/app/api/dm/route'), 'POST', '/api/dm', { recipientUserId: OTHER }), 'dm');
    h.requireVerifiedEmail.mockClear();
    await expectRefused(await call(() => import('@/app/api/dm/[channelId]/messages/route'), 'POST', `/api/dm/${CHANNEL}/messages`, { content: 'hi' }, { channelId: CHANNEL }), 'dm');
  });

  it('reaction: no HTTP route adds reactions — they ride the voice data channel, so the voice token gate covers them', () => {
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    })(join(process.cwd(), 'app', 'api')).filter((f) => f.endsWith('route.ts'));
    expect(files.filter((f) => /reaction/i.test(f))).toEqual([]);
  });

  it('voice: getting a voice token', async () => {
    const res = await call(() => import('@/app/api/livekit/token/route'), 'POST', '/api/livekit/token', { serverId: SERVER, channelId: CHANNEL });
    await expectRefused(res, 'voice');
  });

  it('server_create: creating a community on the hub', async () => {
    await expectRefused(await call(() => import('@/app/api/servers/route'), 'POST', '/api/servers', { name: 'New' }), 'server_create');
  });

  it('channel_create: creating a channel', async () => {
    const res = await call(() => import('@/app/api/servers/[id]/channels/route'), 'POST', `/api/servers/${SERVER}/channels`, { name: 'general', type: 'text' }, { id: SERVER });
    await expectRefused(res, 'channel_create');
  });

  it('invite_create: creating an invite', async () => {
    const res = await call(() => import('@/app/api/servers/[id]/invites/route'), 'POST', `/api/servers/${SERVER}/invites`, {}, { id: SERVER });
    await expectRefused(res, 'invite_create');
  });

  it('upload: avatar, profile banner and server banner images; removing a banner is not gated', async () => {
    const image = { dataUrl: 'data:image/png;base64,'.padEnd(80, 'A') };
    // The server banner route checks MANAGE_SERVER before it looks at the image.
    vi.mocked(db.getServerById).mockResolvedValue({ id: SERVER, ownerUserId: UID } as unknown as Awaited<ReturnType<typeof db.getServerById>>);
    vi.mocked(db.getUserPermissions).mockResolvedValue(['administrator'] as unknown as Awaited<ReturnType<typeof db.getUserPermissions>>);
    const avatar = () => import('@/app/api/users/me/avatar/route');
    const banner = () => import('@/app/api/users/me/banner/route');
    const serverBanner = () => import('@/app/api/servers/[id]/banner/route');
    await expectRefused(await call(avatar, 'POST', '/api/users/me/avatar', image), 'upload');
    h.requireVerifiedEmail.mockClear();
    await expectRefused(await call(banner, 'POST', '/api/users/me/banner', image), 'upload');
    h.requireVerifiedEmail.mockClear();
    await expectRefused(await call(serverBanner, 'POST', `/api/servers/${SERVER}/banner`, image, { id: SERVER }), 'upload');

    // Removal (dataUrl: null, or the server banner DELETE) stays allowed.
    h.requireVerifiedEmail.mockClear();
    vi.mocked(db.updateUserBanner).mockResolvedValue({ bannerUrl: null } as unknown as Awaited<ReturnType<typeof db.updateUserBanner>>);
    vi.mocked(db.updateServerBannerUrl).mockResolvedValue({ bannerUrl: null } as unknown as Awaited<ReturnType<typeof db.updateServerBannerUrl>>);
    expect((await call(banner, 'POST', '/api/users/me/banner', { dataUrl: null })).status).toBe(200);
    expect((await call(serverBanner, 'POST', `/api/servers/${SERVER}/banner`, { dataUrl: null }, { id: SERVER })).status).toBe(200);
    expect((await call(serverBanner, 'DELETE', `/api/servers/${SERVER}/banner`, undefined, { id: SERVER })).status).toBe(200);
    expect(h.requireVerifiedEmail).not.toHaveBeenCalled();
  });

  it('bot_create: creating a bot and switching on a built-in one', async () => {
    await expectRefused(await call(() => import('@/app/api/servers/[id]/bots/route'), 'POST', `/api/servers/${SERVER}/bots`, { name: 'Helper' }, { id: SERVER }), 'bot_create');
    h.requireVerifiedEmail.mockClear();
    const res = await call(() => import('@/app/api/servers/[id]/bots/builtin/[type]/route'), 'PUT', `/api/servers/${SERVER}/bots/builtin/welcome`, { enabled: true }, { id: SERVER, type: 'welcome' });
    await expectRefused(res, 'bot_create');
  });

  it('bot_token: issuing or rotating a bot token', async () => {
    const res = await call(() => import('@/app/api/servers/[id]/bots/[botId]/token/route'), 'POST', `/api/servers/${SERVER}/bots/${OTHER}/token`, {}, { id: SERVER, botId: OTHER });
    await expectRefused(res, 'bot_token');
  });

  it('webhook: creating a webhook and rotating its token', async () => {
    const params = { id: SERVER, channelId: CHANNEL };
    await expectRefused(await call(() => import('@/app/api/servers/[id]/channels/[channelId]/webhooks/route'), 'POST', `/api/servers/${SERVER}/channels/${CHANNEL}/webhooks`, { name: 'CI' }, params), 'webhook');
    h.requireVerifiedEmail.mockClear();
    const res = await call(
      () => import('@/app/api/servers/[id]/channels/[channelId]/webhooks/[webhookId]/token/route'),
      'POST',
      `/api/servers/${SERVER}/channels/${CHANNEL}/webhooks/${OTHER}/token`,
      {},
      { ...params, webhookId: OTHER }
    );
    await expectRefused(res, 'webhook');
  });

  it('plugin_publish: submitting a plugin to the hub marketplace', async () => {
    await expectRefused(await call(() => import('@/app/api/marketplace/submit/route'), 'POST', '/api/marketplace/submit', { manifest: {} }), 'plugin_publish');
  });

  it('join_request: a note to the moderators is gated; asking without one is not', async () => {
    const load = () => import('@/app/api/servers/[id]/join-requests/mine/route');
    await expectRefused(await call(load, 'POST', `/api/servers/${SERVER}/join-requests/mine`, { note: 'please let me in' }, { id: SERVER }), 'join_request');
    h.requireVerifiedEmail.mockClear();
    await call(load, 'POST', `/api/servers/${SERVER}/join-requests/mine`, undefined, { id: SERVER });
    await call(load, 'POST', `/api/servers/${SERVER}/join-requests/mine`, { note: '   ' }, { id: SERVER });
    expect(h.requireVerifiedEmail).not.toHaveBeenCalled();
  });

  it('directory_listing: listing a community in the hub directory (challenge and registration)', async () => {
    await expectRefused(await call(() => import('@/app/api/directory/register/challenge/route'), 'GET', '/api/directory/register/challenge', undefined), 'directory_listing');
    h.requireVerifiedEmail.mockClear();
    await expectRefused(await call(() => import('@/app/api/directory/register/route'), 'POST', '/api/directory/register', {}), 'directory_listing');
  });
});

describe('the gate stays in place (static)', () => {
  const GATED: Array<[string, VerifiedAction]> = [
    ['servers/[id]/channels/[channelId]/messages/route.ts', 'message'],
    ['servers/[id]/channels/[channelId]/messages/[messageId]/route.ts', 'message'],
    ['servers/[id]/channels/[channelId]/commands/[commandId]/invoke/route.ts', 'message'],
    ['dm/route.ts', 'dm'],
    ['dm/[channelId]/messages/route.ts', 'dm'],
    ['livekit/token/route.ts', 'voice'],
    ['servers/route.ts', 'server_create'],
    ['servers/[id]/channels/route.ts', 'channel_create'],
    ['servers/[id]/invites/route.ts', 'invite_create'],
    ['users/me/avatar/route.ts', 'upload'],
    ['users/me/banner/route.ts', 'upload'],
    ['servers/[id]/banner/route.ts', 'upload'],
    ['servers/[id]/bots/route.ts', 'bot_create'],
    ['servers/[id]/bots/builtin/[type]/route.ts', 'bot_create'],
    ['servers/[id]/bots/[botId]/token/route.ts', 'bot_token'],
    ['servers/[id]/channels/[channelId]/webhooks/route.ts', 'webhook'],
    ['servers/[id]/channels/[channelId]/webhooks/[webhookId]/token/route.ts', 'webhook'],
    ['marketplace/submit/route.ts', 'plugin_publish'],
    ['directory/register/route.ts', 'directory_listing'],
    ['directory/register/challenge/route.ts', 'directory_listing'],
    ['servers/[id]/join-requests/mine/route.ts', 'join_request'],
  ];

  it.each(GATED)('%s calls requireVerifiedEmail(…, %s)', (file, action) => {
    const source = readFileSync(join(process.cwd(), 'app', 'api', file), 'utf8');
    expect(source).toMatch(new RegExp(`requireVerifiedEmail\\([^)]*'${action}'\\)`));
  });
});
