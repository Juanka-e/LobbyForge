/**
 * Regressions from the activities-and-bots pass, against the real stack:
 *
 *   1. a phone (390 px) joins voice from the navigation drawer;
 *   2. two starts at the same moment: one 201, one 409 `activity_exists`
 *      with the running session's id — and the hub offers to open it;
 *   3. a game played over voice refuses a member who is not in its voice
 *      room (403 `voice_required`) and lets a member in the room play;
 *   4. Hushle: two opponents press BUST on the same card at once — one
 *      penalty, one card; then "Start new game" on the end screen starts a
 *      new game (same settings, team setup, nobody seated);
 *   5. a slash command whose bot has no live connection answers 409
 *      `bot_offline` at once (and 202 once the bot is connected).
 *
 * Needs the compose stack (LF_E2E_BASE_URL) with LiveKit reachable from
 * the web container (the voice check asks LiveKit who is in the room).
 * Everything here waits seconds, not minutes: the host hand-over timing
 * (60 s / 3 min) is checked outside the regular suite.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';
import { LobbyForgeBot } from '../../../packages/bot-sdk/dist/index.js';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);
const SYNC = { timeout: 20_000 };

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 180_000 });

interface Player {
  ctx: BrowserContext;
  page: Page;
  uid: string;
}

const voiceButtons = (page: Page) => page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) });

async function joinVoice(page: Page, serverId: string) {
  await page.goto(`/lobby?server=${serverId}`);
  await voiceButtons(page).first().click();
  const connected = page.getByText('Voice Connected');
  // Four contexts joining back to back on a dev box: LiveKit's signal
  // connection is occasionally aborted ("Abort handler called"). That is
  // the transport, not what this spec checks — one more try, then fail.
  if (!(await connected.waitFor({ timeout: 20_000 }).then(() => true, () => false))) {
    await page.reload();
    await voiceButtons(page).first().click();
  }
  await expect(connected).toBeVisible({ timeout: 30_000 });
}

async function openActivities(page: Page) {
  await page.getByTitle('Start a game or activity in this voice room').click();
  await expect(page.getByRole('button', { name: 'Close activities', exact: true })).toBeVisible();
}

function appCard(page: Page, appName: string) {
  return page.getByRole('button').filter({ has: page.getByText(appName, { exact: true }) }).filter({ hasText: 'Start' });
}

test.describe('activities and bots: regressions', () => {
  let browser: Browser;
  let owner: APIRequestContext;
  let serverId = '';
  let voiceChannelId = '';
  let textChannelId = '';
  const contexts: BrowserContext[] = [];

  const startUrl = () => `/api/servers/${serverId}/channels/${voiceChannelId}/activities`;
  const actionUrl = (sessionId: string) => `/api/servers/${serverId}/activities/${sessionId}/actions`;

  async function openSessions(): Promise<Array<{ id: string; pluginId: string }>> {
    const res = await owner.get(startUrl());
    const { activities } = (await res.json()) as { activities: Array<{ id: string; pluginId: string; status: string }> };
    return activities.filter((a) => a.status !== 'ended' && a.status !== 'cancelled');
  }

  async function endOpen() {
    for (const a of await openSessions()) await owner.post(`/api/servers/${serverId}/activities/${a.id}/end`, { data: {} });
  }

  async function newContext(options: { width?: number; height?: number } = {}): Promise<BrowserContext> {
    const ctx = await browser.newContext({
      baseURL: baseUrl,
      locale: 'en-US',
      viewport: { width: options.width ?? 1280, height: options.height ?? 860 },
      permissions: ['microphone', 'camera'],
    });
    contexts.push(ctx);
    return ctx;
  }

  /** A guest invited into the server, in its own browser context. */
  async function guest(options: { width?: number; height?: number } = {}): Promise<Player> {
    const ctx = await newContext(options);
    expect((await createGuest(ctx.request, { headers: ORIGIN, data: {} })).status()).toBe(200);
    resetRateLimits();
    const { invite } = (await (await owner.post(`/api/servers/${serverId}/invites`, { data: {} })).json()) as { invite: { code: string } };
    expect((await ctx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    const { guest: me } = (await (await ctx.request.get('/api/auth/guest')).json()) as { guest: { uid: string } };
    return { ctx, page: await ctx.newPage(), uid: me.uid };
  }

  /** The owner in a browser context of their own (same account, its own page). */
  async function ownerPlayer(): Promise<Player> {
    const ctx = await newContext();
    await ctx.addCookies((await owner.storageState()).cookies);
    const { guest: me } = (await (await ctx.request.get('/api/auth/guest')).json()) as { guest: { uid: string } };
    return { ctx, page: await ctx.newPage(), uid: me.uid };
  }

  test.beforeAll(async ({ playwright }) => {
    resetRateLimits();
    browser = await playwright.chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
      ],
    });
    owner = await playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
    expect((await signIn(owner, { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } })).status(), 'owner sign-in').toBe(200);
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    const { channels } = (await (await owner.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    voiceChannelId = channels.find((c) => c.type === 'voice')!.id;
    textChannelId = channels.find((c) => c.type === 'text')!.id;
    for (const pluginId of ['hushle', 'quiz', 'poll']) {
      expect((await owner.post(`/api/servers/${serverId}/apps`, { data: { pluginId, enabled: true } })).status()).toBe(200);
    }
    await endOpen();
  });

  test.afterAll(async () => {
    if (owner && serverId) await endOpen().catch(() => undefined);
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    await owner?.dispose();
    await browser?.close();
  });

  test('a phone joins voice from the navigation drawer', async () => {
    const phone = await guest({ width: 390, height: 844 });
    await phone.page.goto(`/lobby?server=${serverId}`);
    const menu = phone.page.getByRole('button', { name: 'Open navigation menu' });
    await menu.click();
    // The drawer holds the whole sidebar, voice channels included.
    const channel = phone.page.locator('button:visible').filter({ has: phone.page.locator('span', { hasText: 'volume_up' }) }).first();
    await expect(channel).toBeVisible();
    await channel.click();
    // Joining closes the drawer; the call is up (the status lives in the drawer).
    await expect(phone.page.getByText('Voice Connected')).toBeAttached({ timeout: 30_000 });
    await menu.click();
    await expect(phone.page.getByText('Voice Connected')).toBeVisible();
    await phone.ctx.close();
  });

  test('two starts at once: one 409 activity_exists with the running session, and the hub offers to open it', async () => {
    resetRateLimits();
    const [a, b] = await Promise.all([
      owner.post(startUrl(), { data: { pluginId: 'poll' } }),
      owner.post(startUrl(), { data: { pluginId: 'quiz' } }),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([201, 409]);
    const [winner, loser] = a.status() === 201 ? [a, b] : [b, a];
    const created = ((await winner.json()) as { activity: { id: string } }).activity.id;
    const refused = (await loser.json()) as { code?: string; sessionId?: string };
    expect(refused.code).toBe('activity_exists');
    expect(refused.sessionId).toBe(created);
    await endOpen();

    // In the hub: someone else starts first, this page presses Start anyway.
    const host = await ownerPlayer();
    await joinVoice(host.page, serverId);
    await openActivities(host.page);
    await expect(appCard(host.page, 'Poll')).toBeVisible();
    expect((await owner.post(startUrl(), { data: { pluginId: 'hushle' } })).status()).toBe(201);
    await appCard(host.page, 'Poll').click();
    await expect(host.page.getByText('An activity is already running in this channel.')).toBeVisible();
    await host.page.getByRole('button', { name: 'Open the running activity' }).click();
    await expect(host.page.locator('.lfui.hushle')).toBeVisible(SYNC);
    await endOpen();
    await host.ctx.close();
  });

  test('a game played over voice refuses a member outside the voice room (voice_required)', async () => {
    resetRateLimits();
    const outsider = await guest();
    const insider = await guest();
    await joinVoice(insider.page, serverId);
    const start = await owner.post(startUrl(), { data: { pluginId: 'quiz' } });
    expect(start.status()).toBe(201);
    const sessionId = ((await start.json()) as { activity: { id: string } }).activity.id;

    const refused = await outsider.ctx.request.post(actionUrl(sessionId), { headers: ORIGIN, data: { type: 'join' } });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe('voice_required');

    const joined = await insider.ctx.request.post(actionUrl(sessionId), { headers: ORIGIN, data: { type: 'join' } });
    expect(joined.status(), await joined.text()).toBe(200);
    const players = ((await joined.json()) as { activity: { state: { players?: Array<{ id?: string; userId?: string }> } } }).activity.state.players ?? [];
    expect(JSON.stringify(players)).toContain(insider.uid);
    expect(JSON.stringify(players)).not.toContain(outsider.uid);

    // Poll does not need voice: the same outsider may vote.
    await endOpen();
    const poll = await owner.post(startUrl(), { data: { pluginId: 'poll' } });
    const pollId = ((await poll.json()) as { activity: { id: string } }).activity.id;
    const opened = await owner.post(actionUrl(pollId), { data: { type: 'open-poll', question: `Voice? ${RUN}`, options: ['Yes', 'No'] } });
    const optionId = ((await opened.json()) as { activity: { state: { options: Array<{ id: string }> } } }).activity.state.options[0]!.id;
    const vote = await outsider.ctx.request.post(actionUrl(pollId), { headers: ORIGIN, data: { type: 'vote', optionId } });
    expect(vote.status()).toBe(200);
    await endOpen();
    await outsider.ctx.close();
    await insider.ctx.close();
  });

  test('Hushle: a simultaneous BUST costs one point and one card; "Start new game" starts a new game', async () => {
    resetRateLimits();
    const host = await ownerPlayer();
    const mira = await guest();
    const juno = await guest();
    const theo = await guest();
    for (const p of [host, mira, juno, theo]) await joinVoice(p.page, serverId);

    await openActivities(host.page);
    await appCard(host.page, 'Hushle').click();
    const panel = host.page.locator('.lfui.hushle');
    await panel.getByRole('button', { name: 'Start Hushle' }).click();
    await expect(panel.getByText('Team setup', { exact: true })).toBeVisible(SYNC);
    const [{ id: sessionId }] = await openSessions();
    const act = (p: Player, data: Record<string, unknown>) => p.ctx.request.post(actionUrl(sessionId), { headers: ORIGIN, data });
    const stateAs = async (p: Player) =>
      ((await (await p.ctx.request.get(`/api/servers/${serverId}/activities/${sessionId}`)).json()) as {
        activity: { state: Record<string, unknown> & { teams: Array<{ id: string; score: number; playerIds: string[] }>; currentCard: { id: string } | null; cardsPlayedThisTurn: number } };
      }).activity.state;

    // Mira explains for team A (with the host); Juno and Theo watch for team B.
    expect(
      (await act(host, { type: 'set-teams', teams: [{ name: 'Ice', playerIds: [mira.uid, host.uid] }, { name: 'Amber', playerIds: [juno.uid, theo.uid] }] })).status()
    ).toBe(200);
    const teams = (await stateAs(host)).teams;
    expect((await act(host, { type: 'start-turn', teamId: teams[0]!.id, explainerId: mira.uid })).status()).toBe(200);
    const before = await stateAs(juno);
    const cardId = before.currentCard!.id;

    // Both opponents press BUST on the same card at the same moment.
    const [first, second] = await Promise.all([
      act(juno, { type: 'bust-forbidden', cardId }),
      act(theo, { type: 'bust-forbidden', cardId }),
    ]);
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    const after = await stateAs(juno);
    expect(after.cardsPlayedThisTurn).toBe(before.cardsPlayedThisTurn + 1);
    expect(after.teams[0]!.score).toBe(before.teams[0]!.score - 1);
    expect(after.currentCard!.id).not.toBe(cardId);
    // A BUST without the card on screen is refused outright.
    expect((await act(juno, { type: 'bust-forbidden' })).status()).toBe(400);

    // End the game; the host's end screen starts a new one.
    expect((await act(host, { type: 'end-game' })).status()).toBe(200);
    await expect(panel.getByRole('button', { name: 'Start new game' })).toBeVisible(SYNC);
    await panel.getByRole('button', { name: 'Start new game' }).click();
    // A new game with the same settings, back at team setup with nobody seated.
    await expect(panel.getByText('Team setup', { exact: true })).toBeVisible(SYNC);
    await expect(panel.getByRole('button', { name: 'Start new game' })).toHaveCount(0);
    await expect(host.page.getByText('Game has ended.')).toHaveCount(0);
    const fresh = await stateAs(host);
    expect(fresh.phase).toBe('team_setup');
    expect(fresh.teams).toEqual([]);
    await endOpen();
    for (const p of [host, mira, juno, theo]) await p.ctx.close();
  });

  test('a slash command whose bot is not connected answers bot_offline at once', async () => {
    resetRateLimits();
    const created = await owner.post(`/api/servers/${serverId}/bots`, {
      data: { name: `Offline ${RUN}`, permissions: ['read_messages', 'send_messages', 'slash_commands', 'receive_events'] },
    });
    expect(created.status()).toBe(201);
    const { bot, token } = (await created.json()) as { bot: { id: string }; token: string };
    const sdk = new LobbyForgeBot({ baseUrl, token, reconnect: { maxAttempts: 1 } });
    try {
      await sdk.commands.set([{ name: `ping${RUN.slice(-4)}`, description: 'Ping' }]);
      const member = await guest();
      const { commands } = (await (await member.ctx.request.get(`/api/servers/${serverId}/commands?channelId=${textChannelId}`)).json()) as {
        commands: Array<{ id: string; name: string }>;
      };
      const commandId = commands.find((c) => c.name === `ping${RUN.slice(-4)}`)!.id;
      const invoke = () =>
        member.ctx.request.post(`/api/servers/${serverId}/channels/${textChannelId}/commands/${commandId}/invoke`, { headers: ORIGIN, data: { options: {} } });

      const offline = await invoke();
      expect(offline.status()).toBe(409);
      expect(((await offline.json()) as { code?: string }).code).toBe('bot_offline');

      await sdk.connect();
      await expect.poll(async () => (await invoke()).status(), { timeout: 15_000 }).toBe(202);
      await member.ctx.close();
    } finally {
      sdk.close();
      await owner.delete(`/api/servers/${serverId}/bots/${bot.id}`).catch(() => undefined);
    }
  });
});
