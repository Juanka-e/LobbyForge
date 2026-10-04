/**
 * Bots, end to end, through the real UI and the real Bot API:
 *
 *   Welcome Bot — the owner switches it on in Community Settings → Bots
 *   with a greeting; a second user joins by invite and sees the greeting
 *   in the lobby, marked BOT; the members panel lists the bot.
 *
 *   Moderation Bot — the owner adds a blocked word; the member types it
 *   (in capitals — matching ignores case) and sees the message refused
 *   with a reason; it is not stored, and the refusal is in the audit log.
 *   A clean message still goes through.
 *
 *   Custom bot — the owner creates one and copies its token from the
 *   one-time dialog; a plain API client (no cookies, no Origin) posts with
 *   it through the Bot API; the member sees the message, marked BOT.
 *   A wrong token is refused, and so is the real one once the bot is gone.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL), like the other
 * real-UI specs. Re-runs on a warm stack: every word and name carries a
 * per-run marker, the custom bot is deleted and both built-in bots are
 * switched off afterwards (a leftover Moderation Bot would rate-limit
 * other specs' chat).
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);
const TOKEN_FORMAT = /^lfb_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial' });

async function newUserContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 900 } });
}

async function openBotSettings(page: Page) {
  await page.goto('/admin/settings/bots');
  await expect(page.getByRole('heading', { level: 1, name: 'Bots' })).toBeVisible();
}

/**
 * Save a built-in bot's card with it switched ON. The switch saves by
 * itself; when a previous run left the bot on, the Save button does it.
 */
async function saveEnabled(card: Locator, switchName: string) {
  const toggle = card.getByRole('switch', { name: switchName });
  if ((await toggle.getAttribute('aria-checked')) === 'true') {
    await card.getByRole('button', { name: 'Save', exact: true }).click();
  } else {
    await toggle.click();
  }
  await expect(card.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

function composer(page: Page): Locator {
  return page.locator('input[placeholder^="Message #"]').first();
}

test.describe('Bots: welcome, moderation and the Bot API', () => {
  let ownBrowser: Browser;
  let ownerCtx: BrowserContext;
  let memberCtx: BrowserContext;
  let owner: Page;
  let member: Page;
  let serverId = '';
  let serverName = '';
  let textChannelId = '';
  let memberName = '';
  let customBotToken = '';

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    // Own browser WITHOUT the config's --disable-web-security: that flag
    // makes Chromium drop the Origin header, which the app's CSRF guard
    // rejects — and saving bot settings and posting in chat are POSTs.
    // `args` must be explicit: under the test runner a bare launch() inherits
    // the config's launchOptions, that flag included.
    ownBrowser = await playwright.chromium.launch({ args: [] });
    ownerCtx = await newUserContext(ownBrowser);
    memberCtx = await newUserContext(ownBrowser);

    // Owner session: fresh stack → first-run setup; warm stack → login.
    const setup = await ownerCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Bots E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await signIn(ownerCtx.request, {
        headers: ORIGIN,
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }

    const { servers } = (await (await ownerCtx.request.get('/api/servers')).json()) as {
      servers: Array<{ id: string; name: string }>;
    };
    serverId = servers[0]!.id;
    serverName = servers[0]!.name;
    const { channels } = (await (await ownerCtx.request.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    // The lobby opens the first text channel, and the Welcome Bot's
    // default channel is the first text channel open to every member.
    textChannelId = channels.find((c) => c.type === 'text')!.id;

    owner = await ownerCtx.newPage();
    member = await memberCtx.newPage();
  });

  test.afterAll(async () => {
    if (ownerCtx && serverId) {
      for (const type of ['welcome', 'moderation']) {
        await ownerCtx.request
          .put(`/api/servers/${serverId}/bots/builtin/${type}`, { headers: ORIGIN, data: { enabled: false } })
          .catch(() => undefined);
      }
      const list = await ownerCtx.request.get(`/api/servers/${serverId}/bots`).catch(() => null);
      const bots = list?.ok() ? ((await list.json()) as { bots: Array<{ id: string; name: string }> }).bots : [];
      for (const bot of bots.filter((b) => b.name.endsWith(RUN))) {
        await ownerCtx.request.delete(`/api/servers/${serverId}/bots/${bot.id}`, { headers: ORIGIN }).catch(() => undefined);
      }
    }
    await ownerCtx?.close();
    await memberCtx?.close();
    await ownBrowser?.close();
  });

  test('the Welcome Bot greets a member who joins, marked BOT', async () => {
    test.setTimeout(120_000);
    await openBotSettings(owner);
    const card = owner.getByTestId('welcome-bot-card');
    await card.getByLabel('Greeting', { exact: true }).fill(`Welcome {user} to {server}! (${RUN})`);
    await saveEnabled(card, 'Enable the welcome bot');

    // A second user joins through an invite.
    const guestAuth = await createGuest(memberCtx.request, {
      headers: ORIGIN,
      data: { displayNameSeed: 'Botwatch' },
    });
    expect(guestAuth.status()).toBe(200);
    const inviteRes = await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    // The redeem route allows NO body — omit data.
    expect((await memberCtx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    const me = (await (await memberCtx.request.get('/api/auth/guest')).json()) as { guest: { name: string } };
    memberName = me.guest.name;

    await member.goto(`/lobby?server=${serverId}`);
    const greeting = member.locator('[data-bot-message="true"]').filter({ hasText: `(${RUN})` });
    await expect(greeting).toHaveCount(1, { timeout: 15_000 });
    await expect(greeting).toContainText(`Welcome ${memberName.replace(/@/g, '')} to ${serverName}!`);
    await expect(greeting.getByText('BOT', { exact: true })).toBeVisible();
    // It is a bot's message: the robot avatar, not a member's initial.
    await expect(greeting.locator('[data-bot-avatar]')).toHaveCount(1);
    await expect(greeting.locator('[data-chat-avatar]')).toHaveCount(0);

    // The bot is listed among the members, badged, with a profile.
    const botGroup = member.getByTestId('members-bots');
    await expect(botGroup.getByText('BOT', { exact: true }).first()).toBeVisible();
    await botGroup.getByRole('button', { name: /Welcome Bot/ }).click();
    const profile = member.getByRole('dialog', { name: /bot profile$/ });
    await expect(profile).toContainText('Official');
    await expect(profile).toContainText('Send messages');
    await member.keyboard.press('Escape');
  });

  test('the Moderation Bot refuses a blocked word and logs it', async () => {
    test.setTimeout(120_000);
    const blocked = `yasakli${RUN}`;
    await openBotSettings(owner);
    const card = owner.getByTestId('moderation-bot-card');
    await card.getByLabel('Blocked words', { exact: true }).fill(blocked);
    await saveEnabled(card, 'Enable the moderation bot');

    await member.goto(`/lobby?server=${serverId}`);
    const input = composer(member);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(`this has ${blocked.toUpperCase()} in it`);
    await input.press('Enter');
    await expect(
      member.getByText('Your message was not sent: it contains a word this community does not allow.')
    ).toBeVisible();

    // Not stored…
    const history = await memberCtx.request.get(`/api/servers/${serverId}/channels/${textChannelId}/messages?limit=20`);
    const { messages } = (await history.json()) as { messages: Array<{ content: string }> };
    expect(messages.some((m) => m.content.toLowerCase().includes(blocked))).toBe(false);

    // …but on the record for moderators: the rule and what matched.
    const audit = await ownerCtx.request.get(`/api/servers/${serverId}/audit-logs?limit=50`);
    const { auditLogs } = (await audit.json()) as {
      auditLogs: Array<{ action: string; metadata: { rule?: string; detail?: string } }>;
    };
    expect(
      auditLogs.some((e) => e.action === 'bot.moderation.block' && e.metadata.rule === 'blocked_word' && e.metadata.detail === blocked)
    ).toBe(true);

    // A clean message still goes through.
    await input.fill(`a clean message ${RUN}`);
    await input.press('Enter');
    await expect(member.getByText(`a clean message ${RUN}`, { exact: true })).toBeVisible();
  });

  test('a custom bot posts through the Bot API with its one-time token', async ({ request }) => {
    test.setTimeout(120_000);
    const botName = `E2E Bot ${RUN}`;
    await openBotSettings(owner);
    await owner.getByPlaceholder('Announcer').fill(botName);
    await owner.getByRole('button', { name: 'Create bot', exact: true }).click();
    const dialog = owner.getByRole('dialog', { name: `Token for ${botName}` });
    await expect(dialog).toBeVisible();
    customBotToken = await dialog.getByTestId('bot-token').inputValue();
    expect(customBotToken).toMatch(TOKEN_FORMAT);
    await dialog.getByRole('button', { name: 'I saved it' }).click();
    await expect(dialog).toHaveCount(0);
    // Shown once: gone from the page after the dialog closes.
    expect(await owner.content()).not.toContain(customBotToken);

    // A plain API client — no cookies, no Origin — authenticates as the bot.
    const auth = { Authorization: `Bot ${customBotToken}` };
    const meRes = await request.get('/api/bot/v1/me', { headers: auth });
    expect(meRes.status()).toBe(200);
    const { bot } = (await meRes.json()) as { bot: { name: string; serverId: string } };
    expect(bot).toMatchObject({ name: botName, serverId });

    const forged = `${customBotToken.slice(0, -1)}${customBotToken.endsWith('x') ? 'y' : 'x'}`;
    const wrong = await request.get('/api/bot/v1/me', { headers: { Authorization: `Bot ${forged}` } });
    expect(wrong.status()).toBe(401);

    const channelsRes = await request.get('/api/bot/v1/channels', { headers: auth });
    expect(channelsRes.status()).toBe(200);
    const { channels } = (await channelsRes.json()) as { channels: Array<{ id: string }> };
    expect(channels.map((c) => c.id)).toContain(textChannelId);

    const text = `Hello from the bot ${RUN}`;
    const post = await request.post(`/api/bot/v1/channels/${textChannelId}/messages`, {
      headers: auth,
      data: { content: text },
    });
    expect(post.status()).toBe(201);
    const { message } = (await post.json()) as { message: { author: { type: string; name: string } } };
    expect(message.author).toMatchObject({ type: 'bot', name: botName });

    const read = await request.get(`/api/bot/v1/channels/${textChannelId}/messages?limit=5`, { headers: auth });
    expect(read.status()).toBe(200);
    const { messages } = (await read.json()) as { messages: Array<{ content: string }> };
    expect(messages.map((m) => m.content)).toContain(text);

    // The member sees it in the channel, marked BOT.
    await member.goto(`/lobby?server=${serverId}`);
    const posted = member.locator('[data-bot-message="true"]').filter({ hasText: text });
    await expect(posted).toHaveCount(1, { timeout: 15_000 });
    await expect(posted).toContainText(botName);
    await expect(posted.getByText('BOT', { exact: true })).toBeVisible();

    // Delete the bot: its token stops working, its message stays.
    const list = (await (await ownerCtx.request.get(`/api/servers/${serverId}/bots`)).json()) as {
      bots: Array<{ id: string; name: string }>;
    };
    const created = list.bots.find((b) => b.name === botName)!;
    expect((await ownerCtx.request.delete(`/api/servers/${serverId}/bots/${created.id}`, { headers: ORIGIN })).status()).toBe(200);
    expect((await request.get('/api/bot/v1/me', { headers: auth })).status()).toBe(401);
  });
});
