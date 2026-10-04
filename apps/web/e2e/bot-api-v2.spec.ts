/**
 * Bot API v2 on the real stack (docs/BOT_API_V2.md): slash commands and
 * interactions through the real lobby UI, the bot event stream on the
 * gateway, per-bot channel access, incoming webhooks and the SSRF guard on
 * outgoing event endpoints.
 *
 *   - The owner creates a custom bot (read_messages, send_messages,
 *     slash_commands, receive_events, read_members) and gets its token.
 *   - A Node-side bot (`LobbyForgeBot` from packages/bot-sdk, Node's global
 *     WebSocket + `identify`) connects to the gateway's /ws/bot and
 *     registers /roll (integer option `sides`) and /secret.
 *   - A member in Chromium types "/" in the composer, picks /roll, fills
 *     `sides` and runs it: "<bot> is thinking…", then the bot's public
 *     answer with the "↳ <member> used /roll" header, for the member AND
 *     the owner. /secret is answered ephemerally: only the member sees it.
 *   - The bot hears a member's message on the stream (message_create).
 *   - Channel access in "selected" mode with one channel: posting anywhere
 *     else is refused; deleting that one channel leaves the bot NOTHING.
 *   - A manager switches /roll off in Community settings → Bots; the bot
 *     re-registers its commands and /roll stays off.
 *   - An incoming webhook posts into #general with a username override:
 *     the message shows that name with the WEBHOOK badge.
 *   - Event endpoints on private addresses are refused (SSRF).
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL) with the realtime
 * gateway up. Screenshots of each state, dark and light, go to the test's
 * output directory.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';
// The SDK is not a dependency of apps/web: load its built ESM directly.
import { LobbyForgeBot } from '../../../packages/bot-sdk/dist/index.js';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);
const BOT_NAME = `Dicey ${RUN.slice(-5)}`;
const PERMISSIONS = ['read_messages', 'send_messages', 'slash_commands', 'receive_events', 'read_members'];

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface FeedMessage {
  id: string;
  channelId: string;
  content: string;
  author: { id: string | null; displayName: string | null; bot?: boolean; webhook?: boolean };
}

interface Interaction {
  id: string;
  commandName: string;
  options: Record<string, string | number | boolean>;
  channelId: string;
  user: { id: string; displayName: string };
  reply: (content: string, opts?: { ephemeral?: boolean }) => Promise<unknown>;
}

async function newUserContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: baseUrl, locale: 'en-US', viewport: { width: 1360, height: 860 }, colorScheme: 'dark' });
}

/** Screenshot in dark, then light (a signed-in user's default theme follows the system). */
async function shootBothThemes(page: Page, path: (theme: string) => string, target?: ReturnType<Page['locator']>) {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    if (target) await target.screenshot({ path: path(colorScheme) });
    else await page.screenshot({ path: path(colorScheme) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

function composer(page: Page) {
  return page.locator('input[data-composer-input], input[placeholder^="Message #"]').first();
}

test.describe('Bot API v2: commands, interactions, events, access and webhooks', () => {
  let browser: Browser;
  let ownerCtx: BrowserContext;
  let memberCtx: BrowserContext;
  let ownerPage: Page;
  let memberPage: Page;
  let owner: APIRequestContext;
  let serverId = '';
  let generalId = '';
  let botId = '';
  let botToken = '';
  let memberName = '';
  let memberUid = '';
  let bot: InstanceType<typeof LobbyForgeBot> | null = null;
  const heard: FeedMessage[] = [];
  const interactions: Interaction[] = [];
  const accessEvents: Array<Array<{ id: string }>> = [];
  const createdChannels: string[] = [];
  let webhookId = '';

  const commandList = [
    {
      name: 'roll',
      description: 'Roll dice',
      options: [{ name: 'sides', description: 'How many sides', type: 'integer', required: true, min: 2, max: 1000 }],
    },
    { name: 'secret', description: 'Tell me a secret' },
  ];

  /** Bot API v2 with the bot's token: no cookies, no Origin — a plain HTTP client. */
  async function botApi(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    const res = await fetch(new URL(`/api/bot/v2${path}`, baseUrl), {
      method,
      headers: { Authorization: `Bot ${botToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 204 or non-JSON
    }
    return { status: res.status, json };
  }

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    test.setTimeout(120_000);
    // Own browser WITHOUT the config's --disable-web-security (it drops the
    // Origin header and the CSRF guard rejects every POST from the page).
    browser = await playwright.chromium.launch({ args: [] });
    ownerCtx = await newUserContext(browser);
    memberCtx = await newUserContext(browser);
    owner = ownerCtx.request;

    const setup = await owner.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Bot API v2 E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await signIn(owner, { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    const { channels } = (await (await owner.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string; name: string }>;
    };
    generalId = channels.find((c) => c.type === 'text' && c.name === 'general')?.id ?? channels.find((c) => c.type === 'text')!.id;

    // The owner creates the bot and gets its token (shown once).
    const created = await owner.post(`/api/servers/${serverId}/bots`, {
      headers: ORIGIN,
      data: { name: BOT_NAME, permissions: PERMISSIONS },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdBody = (await created.json()) as { bot: { id: string; permissions: string[] }; token: string };
    botId = createdBody.bot.id;
    botToken = createdBody.token;
    expect(botToken).toMatch(/^lfb_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    expect([...createdBody.bot.permissions].sort()).toEqual([...PERMISSIONS].sort());

    // A member joins through an invite.
    expect((await createGuest(memberCtx.request, { headers: ORIGIN, data: { displayNameSeed: 'Roller' } })).status()).toBe(200);
    const invite = await owner.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(invite.status()).toBe(201);
    const { invite: inv } = (await invite.json()) as { invite: { code: string } };
    expect((await memberCtx.request.post(`/api/invites/${inv.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    const me = (await (await memberCtx.request.get('/api/auth/guest')).json()) as { guest: { uid: string; name: string } };
    memberName = me.guest.name;
    memberUid = me.guest.uid;

    // The bot: SDK over the gateway's /ws/bot (Node's global WebSocket → identify).
    bot = new LobbyForgeBot({ baseUrl, token: botToken, reconnect: { maxAttempts: 3 } });
    bot.on('message', (m: FeedMessage) => {
      heard.push(m);
    });
    bot.on('channel_access_changed', (channels: Array<{ id: string }>) => {
      accessEvents.push(channels);
    });
    bot.on('interaction', async (i: Interaction) => {
      interactions.push(i);
      if (i.commandName === 'roll') {
        // A short think, so the invoker's pending row can be seen.
        await new Promise((r) => setTimeout(r, 3_000));
        const sides = Number(i.options.sides);
        await i.reply(`rolled a d${sides}: ${1 + Math.floor(Math.random() * sides)} (${RUN})`, { ephemeral: false });
      } else if (i.commandName === 'secret') {
        await i.reply(`psst — the password is swordfish (${RUN})`, { ephemeral: true });
      }
    });
    await bot.commands.set(commandList as never);
    // Resolves on the first `ready` event; `bot.ready` then holds it.
    await bot.connect();
    expect(bot.ready?.bot.id).toBe(botId);

    ownerPage = await ownerCtx.newPage();
    memberPage = await memberCtx.newPage();
  });

  test.afterAll(async () => {
    await bot?.close();
    if (owner && serverId) {
      if (webhookId) {
        await owner.delete(`/api/servers/${serverId}/channels/${generalId}/webhooks/${webhookId}`, { headers: ORIGIN }).catch(() => undefined);
      }
      for (const id of createdChannels) {
        await owner.delete(`/api/servers/${serverId}/channels/${id}`, { headers: ORIGIN }).catch(() => undefined);
      }
      if (botId) await owner.delete(`/api/servers/${serverId}/bots/${botId}`, { headers: ORIGIN }).catch(() => undefined);
    }
    await ownerCtx?.close();
    await memberCtx?.close();
    await browser?.close();
  });

  test('the bot is on the gateway stream with the channels it reaches', async () => {
    expect(bot!.ready?.bot.id).toBe(botId);
    expect(bot!.ready?.channels.map((c: { id: string }) => c.id)).toContain(generalId);
    // Gateway discovery points at this stack's realtime gateway.
    const gateway = await botApi('GET', '/gateway');
    expect(gateway.status).toBe(200);
    expect(String(gateway.json.url)).toMatch(/\/ws\/bot$/);
  });

  test('/roll from the composer: the picker, "thinking…", then a public answer both users see', async ({}, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    await ownerPage.goto(`/lobby?server=${serverId}`);
    await memberPage.goto(`/lobby?server=${serverId}`);
    const input = composer(memberPage);
    await expect(input).toBeVisible({ timeout: 15_000 });

    // "/" opens the picker, grouped by bot.
    await input.fill('/');
    const picker = memberPage.getByRole('listbox', { name: 'Bot commands' });
    await expect(picker).toBeVisible();
    const group = picker.getByRole('group', { name: new RegExp(BOT_NAME) });
    await expect(group.getByRole('option', { name: /\/roll/ })).toBeVisible();
    await expect(group.getByRole('option', { name: /\/secret/ })).toBeVisible();
    await shootBothThemes(memberPage, shot('1-composer-picker'));

    await group.getByRole('option', { name: /\/roll/ }).click();
    const form = memberPage.locator('[data-slash-form]');
    await expect(form.getByRole('heading', { name: '/roll' })).toBeVisible();
    await form.getByLabel('sides').fill('20');
    await form.getByRole('button', { name: 'Run /roll' }).click();

    // The invoker alone sees the pending row while the bot thinks.
    const pending = memberPage.locator('[data-interaction-pending][data-status="pending"]');
    await expect(pending).toContainText(`${BOT_NAME} is thinking…`);
    await shootBothThemes(memberPage, shot('2-pending-row'));
    await expect(ownerPage.locator('[data-interaction-pending]')).toHaveCount(0);

    // The bot got the interaction with the validated option…
    await expect.poll(() => interactions.filter((i) => i.commandName === 'roll').length).toBe(1);
    const roll = interactions.find((i) => i.commandName === 'roll')!;
    expect(roll.options.sides).toBe(20);
    expect(roll.user.id).toBe(memberUid);
    expect(roll.channelId).toBe(generalId);

    // …and its public answer reaches both users with the "used /roll" header.
    for (const page of [memberPage, ownerPage]) {
      const answer = page.locator('[data-bot-message="true"]').filter({ hasText: `(${RUN})` }).filter({ hasText: 'rolled a d20' });
      await expect(answer).toHaveCount(1, { timeout: 20_000 });
      await expect(answer.locator('[data-interaction-header]')).toContainText(`${memberName} used /roll`);
      await expect(answer.locator('[data-bot-badge]')).toHaveText('BOT');
    }
    await expect(pending).toHaveCount(0);
    const answer = memberPage.locator('[data-bot-message="true"]').filter({ hasText: `(${RUN})` }).filter({ hasText: 'rolled a d20' });
    await answer.scrollIntoViewIfNeeded();
    await shootBothThemes(memberPage, shot('3-public-answer'));
  });

  test('a range the server refuses never reaches the bot', async () => {
    const list = (await (await memberCtx.request.get(`/api/servers/${serverId}/commands?channelId=${generalId}`)).json()) as {
      commands: Array<{ id: string; name: string }>;
    };
    const rollId = list.commands.find((c) => c.name === 'roll')!.id;
    const before = interactions.length;
    const res = await memberCtx.request.post(`/api/servers/${serverId}/channels/${generalId}/commands/${rollId}/invoke`, {
      headers: ORIGIN,
      data: { options: { sides: 1 } },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_options');
    await memberPage.waitForTimeout(1_000);
    expect(interactions.length).toBe(before);
  });

  test('/secret is answered ephemerally: only the invoker sees it', async ({}, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    const input = composer(memberPage);
    await input.fill('/');
    await memberPage
      .getByRole('listbox', { name: 'Bot commands' })
      .getByRole('option', { name: /\/secret/ })
      .click();
    await memberPage.locator('[data-slash-form]').getByRole('button', { name: 'Run /secret' }).click();

    const secret = memberPage.locator('[data-ephemeral-answer]').filter({ hasText: `swordfish (${RUN})` });
    await expect(secret).toBeVisible({ timeout: 20_000 });
    await expect(secret).toContainText('Only you can see this');
    await expect(secret.getByRole('button', { name: `Dismiss the answer from ${BOT_NAME}` })).toBeVisible();
    await shootBothThemes(memberPage, shot('4-ephemeral-answer'));

    // Never stored as a message: the owner sees nothing, the history has nothing.
    await ownerPage.waitForTimeout(1_500);
    await expect(ownerPage.getByText(`swordfish (${RUN})`)).toHaveCount(0);
    const history = (await (await owner.get(`/api/servers/${serverId}/channels/${generalId}/messages?limit=30`)).json()) as {
      messages: Array<{ content: string }>;
    };
    expect(history.messages.some((m) => m.content.includes('swordfish'))).toBe(false);
  });

  test('the bot hears a member message on the stream (message_create)', async () => {
    const text = `hello bot, it is ${memberName} (${RUN})`;
    const input = composer(memberPage);
    await input.fill(text);
    await input.press('Enter');
    await expect(memberPage.getByText(text, { exact: true })).toBeVisible();
    await expect.poll(() => heard.find((m) => m.content === text)?.author.displayName ?? null, { timeout: 15_000 }).toBe(memberName);
    const event = heard.find((m) => m.content === text)!;
    expect(event.channelId).toBe(generalId);
    expect(event.author.id).toBe(memberUid);
    // Never its own messages: the /roll answer did not come back to the bot.
    expect(heard.some((m) => m.content.includes('rolled a d20'))).toBe(false);
  });

  test('channel access: one selected channel; deleting it leaves the bot nothing', async () => {
    const make = async (name: string) => {
      const res = await owner.post(`/api/servers/${serverId}/channels`, { headers: ORIGIN, data: { name, type: 'text' } });
      expect(res.status()).toBe(201);
      const id = ((await res.json()) as { channel: { id: string } }).channel.id;
      createdChannels.push(id);
      return id;
    };
    const botRoom = await make(`bot-room-${RUN}`);
    const other = await make(`no-bots-${RUN}`);

    const select = await owner.put(`/api/servers/${serverId}/bots/${botId}/channel-access`, {
      headers: ORIGIN,
      data: { channelIds: [botRoom] },
    });
    expect(select.status(), await select.text()).toBe(200);
    expect(((await select.json()) as { access: { mode: string } }).access.mode).toBe('selected');
    await expect.poll(() => accessEvents.at(-1)?.map((c) => c.id) ?? null, { timeout: 15_000 }).toEqual([botRoom]);

    const post = (channelId: string) => botApi('POST', `/channels/${channelId}/messages`, { content: `access probe ${RUN}` });
    expect((await post(botRoom)).status).toBe(201);
    for (const channelId of [other, generalId]) {
      const refused = await post(channelId);
      expect(refused.status, `post to ${channelId === other ? 'the other channel' : '#general'}`).toBe(404);
      expect(refused.json.code).toBe('not_found');
    }

    // Delete the only granted channel: the bot narrows to NOTHING, never "every channel".
    expect((await owner.delete(`/api/servers/${serverId}/channels/${botRoom}`, { headers: ORIGIN })).status()).toBe(200);
    createdChannels.splice(createdChannels.indexOf(botRoom), 1);
    const reachable = await botApi('GET', '/channels');
    expect(reachable.status).toBe(200);
    expect(reachable.json.channels).toEqual([]);
    for (const channelId of [other, generalId]) expect((await post(channelId)).status).toBe(404);
    await expect.poll(() => accessEvents.at(-1)?.length ?? -1, { timeout: 15_000 }).toBe(0);
    const access = (await (await owner.get(`/api/servers/${serverId}/bots/${botId}/channel-access`)).json()) as {
      access: { mode: string; channels: Array<{ granted: boolean }> };
    };
    expect(access.access.mode).toBe('selected');
    expect(access.access.channels.some((c) => c.granted)).toBe(false);

    // Back to every open channel for the rest of the run.
    const all = await owner.put(`/api/servers/${serverId}/bots/${botId}/channel-access`, { headers: ORIGIN, data: { channelIds: null } });
    expect(all.status()).toBe(200);
    expect(((await all.json()) as { access: { mode: string } }).access.mode).toBe('all');
  });

  test('a manager switches /roll off; the bot re-registers and it stays off', async ({}, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    await ownerPage.goto('/admin/settings/bots');
    const card = ownerPage.locator('li[data-testid="custom-bot"]').filter({ hasText: BOT_NAME });
    await card.getByRole('button', { name: 'Channels, commands and events' }).click();
    const commands = card.locator('section[data-testid="bot-commands"]');
    const rollSwitch = commands.getByRole('switch', { name: 'Enable /roll' });
    await expect(rollSwitch).toHaveAttribute('aria-checked', 'true');
    await rollSwitch.click();
    await expect(commands.getByText('/roll is off: members no longer see it.')).toBeVisible();
    await expect(rollSwitch).toHaveAttribute('aria-checked', 'false');
    await card.scrollIntoViewIfNeeded();
    await shootBothThemes(ownerPage, shot('5-admin-bot-integrations'), card);

    // The bot overwrites its commands — the managers' switch survives.
    await bot!.commands.set(commandList as never);
    const managed = (await (await owner.get(`/api/servers/${serverId}/bots/${botId}/commands`)).json()) as {
      commands: Array<{ name: string; enabled: boolean }>;
    };
    expect(managed.commands.find((c) => c.name === 'roll')?.enabled).toBe(false);
    expect(managed.commands.find((c) => c.name === 'secret')?.enabled).toBe(true);

    // Members no longer get /roll (fresh page: the picker caches its list for a minute).
    await memberPage.goto(`/lobby?server=${serverId}`);
    const input = composer(memberPage);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill('/');
    const picker = memberPage.getByRole('listbox', { name: 'Bot commands' });
    await expect(picker.getByRole('option', { name: /\/secret/ })).toBeVisible();
    await expect(picker.getByRole('option', { name: /\/roll/ })).toHaveCount(0);
    await input.fill('');
    // …and invoking it by id is refused.
    const listed = (await (await owner.get(`/api/servers/${serverId}/bots/${botId}/commands`)).json()) as {
      commands: Array<{ id: string; name: string }>;
    };
    const rollId = listed.commands.find((c) => c.name === 'roll')!.id;
    const invoke = await memberCtx.request.post(`/api/servers/${serverId}/channels/${generalId}/commands/${rollId}/invoke`, {
      headers: ORIGIN,
      data: { options: { sides: 6 } },
    });
    expect(invoke.status()).toBe(403);
    expect(((await invoke.json()) as { code: string }).code).toBe('command_disabled');
  });

  test('an incoming webhook posts with a username override and the WEBHOOK badge', async ({ playwright }, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    const created = await owner.post(`/api/servers/${serverId}/channels/${generalId}/webhooks`, {
      headers: ORIGIN,
      data: { name: `Deploys ${RUN.slice(-4)}` },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { webhook, url, token } = (await created.json()) as { webhook: { id: string }; url: string; token: string };
    webhookId = webhook.id;
    expect(token).toMatch(/^lfw_[A-Za-z0-9_-]{43}$/);
    expect(url).toBe(`${baseUrl}/api/webhooks/${webhook.id}/${token}`);

    // An outside service: no cookie, no Origin.
    const outside = await playwright.request.newContext();
    const content = `Deploy finished: build ${RUN}`;
    const post = await outside.post(url, { data: { content, username: 'CI Runner' } });
    expect(post.status()).toBe(204);
    const waited = await outside.post(`${url}?wait=true`, { data: { content: `second note ${RUN}` } });
    expect(waited.status()).toBe(200);
    expect(((await waited.json()) as { message: { webhook: { id: string } } }).message.webhook.id).toBe(webhook.id);
    // A wrong token looks exactly like an unknown webhook.
    expect((await outside.post(url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), { data: { content: 'x' } })).status()).toBe(404);
    await outside.dispose();

    // The member is still in the lobby (realtime); the owner comes back from the admin pages.
    await ownerPage.goto(`/lobby?server=${serverId}`);
    for (const page of [memberPage, ownerPage]) {
      const message = page.locator('[data-webhook-message="true"]').filter({ hasText: content });
      await expect(message).toHaveCount(1, { timeout: 15_000 });
      await expect(message).toContainText('CI Runner');
      await expect(message.locator('[data-webhook-badge]')).toHaveText('WEBHOOK');
    }
    await memberPage.locator('[data-webhook-message="true"]').filter({ hasText: content }).scrollIntoViewIfNeeded();
    await shootBothThemes(memberPage, shot('6-webhook-message'));
    // The bot hears it as a webhook author.
    await expect.poll(() => heard.find((m) => m.content === content)?.author.webhook ?? null, { timeout: 15_000 }).toBe(true);

    // The channel's admin panel lists it.
    await ownerPage.goto('/admin/settings/channels');
    await ownerPage.getByRole('button', { name: 'Incoming webhooks for #general' }).click();
    const panel = ownerPage.locator('section[data-testid="channel-webhooks"]');
    await expect(panel.getByRole('heading', { name: 'Incoming webhooks' })).toBeVisible();
    await expect(panel.locator('li[data-testid="channel-webhook"]').filter({ hasText: `Deploys ${RUN.slice(-4)}` })).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await shootBothThemes(ownerPage, shot('7-admin-channel-webhooks'), panel);
  });

  test('an event endpoint on a private address is refused (SSRF)', async () => {
    for (const url of [
      'https://127.0.0.1/lobbyforge/events',
      'https://web:3000/api/health',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/events',
      'http://example.com/events',
    ]) {
      const res = await botApi('PUT', '/event-endpoint', { url });
      expect(res.status, url).toBe(400);
      expect(res.json.code, url).toBe('invalid_endpoint');
    }
    const endpoint = await botApi('GET', '/event-endpoint');
    expect(endpoint.status).toBe(200);
    expect(endpoint.json.endpoint).toBeNull();
  });
});
