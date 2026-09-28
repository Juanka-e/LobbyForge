/**
 * Hushle, played through the real lobby UI by four people.
 *
 * compose-stack.spec.ts drives Hushle's rules through the API. This spec
 * plays a short game the way people do: four browser contexts (the host
 * and three invited guests), each in the lobby and the voice channel. The
 * host launches Hushle from the activities hub, picks the settings, builds
 * two teams of two by seating the people in the room by name, and runs two
 * turns:
 *
 *   turn 1 — Ice (a guest explains, the host guesses with her): the
 *            explainer sees the card, her teammate does not, the other
 *            team sees it and one of them presses BUST; the host scores
 *            the rest of the turn until its five cards are played;
 *   turn 2 — Amber, whose own rotation starts with its first player: the
 *            host now sits on the watching team, scores one card and ends
 *            the game;
 *
 * and every player sees the same winner.
 *
 * Needs a compose stack (LF_E2E_BASE_URL) with the web image rebuilt from
 * this tree, including the host change that passes the voice room's people
 * to the panel as `players`. The rate limiter keys on the client address
 * and all four contexts share one: clear `*rate-limit*` keys in Redis
 * before a re-run. The realtime gateway should be up; without it the
 * players' panels fall back to polling every 5 s (the waits allow for it).
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };

/** Other players learn about a move over the realtime gateway, or by polling every 5 s. */
const SYNC = { timeout: 20_000 };

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

test.describe.configure({ mode: 'serial' });

interface Seat {
  ctx: BrowserContext;
  page: Page;
  uid: string;
  /** The display name the room shows for them. */
  name: string;
}

async function newUserContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: baseUrl, permissions: ['microphone', 'camera'] });
}

/** The signed-in user's id and display name (guest or registered: same session cookie). */
async function whoAmI(ctx: BrowserContext): Promise<{ uid: string; name: string }> {
  const res = await ctx.request.get('/api/auth/guest');
  expect(res.status()).toBe(200);
  const { guest } = (await res.json()) as { guest: { uid: string; name: string } };
  expect(guest.uid).toBeTruthy();
  expect(guest.name).toBeTruthy();
  return { uid: guest.uid, name: guest.name };
}

async function joinVoice(page: Page, serverId: string) {
  await page.goto(`/lobby?server=${serverId}`);
  const voiceChannel = page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
  await expect(voiceChannel).toBeVisible();
  await voiceChannel.click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
}

/** The activities hub for the voice channel, from the sidebar. */
async function openActivities(page: Page) {
  await page.getByTitle(/^Open activities in /).click();
}

/** Hushle's panel (the UI kit shell it renders into). */
const panel = (page: Page): Locator => page.locator('.lfui.hushle');
const card = (page: Page): Locator => panel(page).getByRole('article', { name: 'Word card' });
const bust = (page: Page): Locator => panel(page).getByRole('button', { name: 'BUST! Forbidden word' });

async function addTeam(host: Page, name: string) {
  const form = panel(host).getByRole('form', { name: 'Add team' });
  await form.getByLabel('Team name').fill(name);
  await form.getByRole('button', { name: 'Add team' }).click();
  // set-teams replaces the whole roster: wait for this team to land before
  // the next edit is built from it.
  await expect(panel(host).getByText(name, { exact: true }).first()).toBeVisible(SYNC);
}

/** Seat someone from the room on a team, by the name the room shows. */
async function seat(host: Page, player: Seat, team: string) {
  const button = panel(host).getByRole('button', { name: `Add ${player.name} to ${team}`, exact: true });
  await button.click();
  // Seated: they leave the "not on a team yet" list. Wait for it before the
  // next seat is built from the roster.
  await expect(button).toHaveCount(0, SYNC);
}

test.describe('Hushle through the lobby UI', () => {
  let ownBrowser: Browser;
  let host: Seat;
  let mira: Seat;
  let juno: Seat;
  let theo: Seat;
  let serverId = '';
  let voiceChannelId = '';

  const openSessions = async (): Promise<string[]> => {
    const res = await host.ctx.request.get(`/api/servers/${serverId}/channels/${voiceChannelId}/activities`);
    if (!res.ok()) return [];
    const { activities } = (await res.json()) as { activities?: Array<{ id: string; status: string }> };
    return (activities ?? []).filter((a) => a.status !== 'ended' && a.status !== 'cancelled').map((a) => a.id);
  };

  const endOpenSessions = async () => {
    for (const id of await openSessions()) {
      await host.ctx.request.post(`/api/servers/${serverId}/activities/${id}/end`, { headers: ORIGIN, data: {} });
    }
  };

  test.beforeAll(async ({ playwright }) => {
    // Own browser WITHOUT the config's --disable-web-security: that flag makes
    // Chromium drop the Origin header, which the app's CSRF guard rejects.
    ownBrowser = await playwright.chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });

    // ── The host: the instance owner (fresh stack → setup, warm → login).
    const hostCtx = await newUserContext(ownBrowser);
    const setup = await hostCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Hushle UI E2E',
        ownerDisplayName: 'Kaya',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await hostCtx.request.post('/api/auth/login', {
        headers: ORIGIN,
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      test.skip(login.status() !== 200, 'Warm stack provisioned by someone else — owner credentials unknown.');
    }

    const { servers } = (await (await hostCtx.request.get('/api/servers')).json()) as {
      servers: Array<{ id: string; ownerUserId: string }>;
    };
    serverId = servers[0]!.id;
    const { channels } = (await (await hostCtx.request.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    voiceChannelId = channels.find((c) => c.type === 'voice')!.id;
    host = { ctx: hostCtx, page: await hostCtx.newPage(), ...(await whoAmI(hostCtx)) };

    // Hushle must be installed and enabled before the hub offers it.
    const install = await hostCtx.request.post(`/api/servers/${serverId}/apps`, {
      headers: ORIGIN,
      data: { pluginId: 'hushle', enabled: true },
    });
    expect(install.status()).toBe(200);

    // A channel holds one open activity: end a leftover one so the hub offers a launch.
    await endOpenSessions();

    // ── Three guests, each invited into the server.
    const guest = async (): Promise<Seat> => {
      const ctx = await newUserContext(ownBrowser);
      expect((await ctx.request.post('/api/auth/guest', { headers: ORIGIN, data: {} })).status()).toBe(200);
      const inviteRes = await hostCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
      expect(inviteRes.status()).toBe(201);
      const { invite } = (await inviteRes.json()) as { invite: { code: string } };
      // The redeem route allows NO body.
      expect((await ctx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
      return { ctx, page: await ctx.newPage(), ...(await whoAmI(ctx)) };
    };
    mira = await guest();
    juno = await guest();
    theo = await guest();
    // The host seats people by the names the room shows, so they must differ.
    expect(new Set([host.name, mira.name, juno.name, theo.name]).size).toBe(4);
  });

  test.afterAll(async () => {
    if (host && serverId) await endOpenSessions().catch(() => {});
    for (const seatOf of [host, mira, juno, theo]) await seatOf?.ctx.close();
    await ownBrowser?.close();
  });

  test('four players: settings, teams by name, a busted card, two turns and the winner', async ({}, testInfo) => {
    test.setTimeout(300_000);
    const everyone = [host, mira, juno, theo];
    const hostPanel = panel(host.page);

    // ── Everyone is in the lobby's voice channel.
    for (const player of everyone) await joinVoice(player.page, serverId);

    // ── The host launches Hushle from the activities hub.
    await openActivities(host.page);
    const gallery = host.page
      .getByRole('main')
      .filter({ has: host.page.getByRole('heading', { name: 'Start something together' }) });
    await gallery.getByRole('button', { name: /Hushle/ }).click();

    // ── Lobby: the default pack, five cards a turn, and the longest turn
    // timer (one clock per turn — this leaves room for slow realtime).
    await expect(hostPanel.getByRole('button', { name: 'Start Hushle' })).toBeVisible(SYNC);
    await expect(hostPanel.getByText('How to play')).toBeVisible();
    const cardsPerTurn = hostPanel.getByRole('group', { name: 'Cards per turn' });
    await cardsPerTurn.getByRole('button', { name: '5', exact: true }).click();
    await expect(cardsPerTurn.getByRole('button', { name: '5', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await hostPanel.getByRole('group', { name: 'Turn timer' }).getByRole('button', { name: '120 s', exact: true }).click();
    await hostPanel.getByRole('button', { name: 'Start Hushle' }).click();
    await expect(hostPanel.getByText('Team setup', { exact: true })).toBeVisible(SYNC);

    // ── The guests open the hub and land in the running game.
    for (const player of [mira, juno, theo]) {
      await openActivities(player.page);
      await expect(panel(player.page).getByText('Waiting for the host to start the first turn…')).toBeVisible(SYNC);
      // Nobody is shown a raw id.
      await expect(panel(player.page)).not.toContainText(player.uid);
    }

    // ── Two teams of two, seated by name from the room. Mira explains first;
    // the host guesses with her.
    await addTeam(host.page, 'Ice');
    await addTeam(host.page, 'Amber');
    await seat(host.page, mira, 'Ice');
    await seat(host.page, host, 'Ice');
    await seat(host.page, juno, 'Amber');
    await seat(host.page, theo, 'Amber');
    await expect(hostPanel.getByText('Everyone in the room is on a team.')).toBeVisible();
    await expect(hostPanel.getByText(`Ice goes first, and ${mira.name} explains.`)).toBeVisible();
    await host.page.screenshot({ path: testInfo.outputPath('0-teams.png'), fullPage: true });
    await hostPanel.getByRole('button', { name: 'Start first turn' }).click();

    // ── Turn 1. The explainer sees the card…
    await expect(card(mira.page)).toBeVisible(SYNC);
    await expect(panel(mira.page).getByText("You're explaining")).toBeVisible();
    await expect(panel(mira.page).getByText("Don't say")).toBeVisible();
    await expect(panel(mira.page).getByRole('timer')).toBeVisible();
    const firstWord = ((await card(mira.page).locator('.hushle-word').textContent()) ?? '').trim();
    expect(firstWord).not.toBe('');
    // …but cannot bust or score her own card.
    await expect(panel(mira.page).getByRole('button', { name: /BUST|Got it/ })).toHaveCount(0);
    await mira.page.screenshot({ path: testInfo.outputPath('1-explainer.png'), fullPage: true });

    // …her teammate — the host — hears it but never sees it, and scores blind.
    await expect(hostPanel.getByText(`Listen to ${mira.name}`, { exact: true })).toBeVisible(SYNC);
    await expect(card(host.page)).toHaveCount(0);
    await expect(hostPanel).not.toContainText(firstWord);
    await expect(hostPanel.getByRole('button', { name: 'Got it', exact: true })).toBeVisible();
    await expect(hostPanel.getByRole('button', { name: 'Penalty' })).toBeVisible();
    await expect(bust(host.page)).toHaveCount(0);
    await host.page.screenshot({ path: testInfo.outputPath('2-teammate-host.png'), fullPage: true });

    // …and the other team watches the same card, with BUST at hand.
    for (const player of [juno, theo]) {
      await expect(card(player.page).locator('.hushle-word')).toHaveText(firstWord, SYNC);
      await expect(bust(player.page)).toBeEnabled();
      await expect(panel(player.page).getByRole('button', { name: 'Got it', exact: true })).toHaveCount(0);
    }
    await juno.page.screenshot({ path: testInfo.outputPath('3-opponent.png'), fullPage: true });

    // ── Juno catches a forbidden word: Ice loses a point, Mira gets a new card.
    await bust(juno.page).click();
    await expect(card(mira.page).locator('.hushle-word')).not.toHaveText(firstWord, SYNC);
    await expect(panel(juno.page).getByText('Bust', { exact: true })).toBeVisible(SYNC);
    await expect(hostPanel.getByText('Bust', { exact: true })).toBeVisible(SYNC);

    // ── The host scores the rest of the turn; its fifth card ends it.
    // (A host button stays disabled until its move lands — no double scoring.)
    for (const label of ['Got it', 'Got it', 'Got it', 'Skip']) {
      await hostPanel.getByRole('button', { name: label, exact: true }).click();
    }
    await expect(hostPanel.getByText('Next up: Amber')).toBeVisible(SYNC);
    // Amber's own rotation starts with its first player.
    await expect(hostPanel.getByText(`${juno.name} explains next.`)).toBeVisible();
    await expect(hostPanel.getByRole('region', { name: 'Scores' })).toContainText('2 points');
    for (const player of [mira, juno, theo]) {
      await expect(panel(player.page).getByText('Waiting for the host to start the next turn…')).toBeVisible(SYNC);
    }
    await host.page.screenshot({ path: testInfo.outputPath('4-between-turns.png'), fullPage: true });

    // ── Turn 2: Juno explains for Amber; Theo guesses blind; Ice (Mira and
    // the host) now watches the card.
    await hostPanel.getByRole('button', { name: 'Start next turn' }).click();
    await expect(card(juno.page)).toBeVisible(SYNC);
    await expect(panel(juno.page).getByText("You're explaining")).toBeVisible();
    await expect(panel(theo.page).getByText(`Listen to ${juno.name}`, { exact: true })).toBeVisible(SYNC);
    await expect(card(theo.page)).toHaveCount(0);
    await expect(card(mira.page)).toBeVisible(SYNC);
    await expect(bust(mira.page)).toBeEnabled();
    // The host sits on the watching team now: BUST, and no second penalty button.
    await expect(card(host.page)).toBeVisible();
    await expect(bust(host.page)).toBeEnabled();
    await expect(hostPanel.getByRole('button', { name: 'Penalty' })).toHaveCount(0);

    // ── One guess for Amber, then the host ends the game.
    await hostPanel.getByRole('button', { name: 'Got it', exact: true }).click();
    await expect(hostPanel.getByRole('region', { name: 'Scores' })).toContainText('1 point');
    await hostPanel.getByRole('button', { name: 'End game' }).click();

    // ── Everyone sees the same result: Ice 2, Amber 1.
    for (const player of everyone) {
      await expect(panel(player.page).getByText('Ice wins!')).toBeVisible(SYNC);
      await expect(panel(player.page).getByText('Final score: 2 points')).toBeVisible();
    }
    const finalScores = hostPanel.getByRole('list', { name: 'Final scores' });
    await expect(finalScores.getByRole('listitem')).toHaveCount(2);
    await expect(finalScores.getByRole('listitem').first()).toContainText('Ice');
    await expect(hostPanel.getByRole('button', { name: 'Start new game' })).toBeVisible();
    await expect(panel(juno.page).getByRole('button', { name: 'Start new game' })).toHaveCount(0);
    await host.page.screenshot({ path: testInfo.outputPath('5-ended.png'), fullPage: true });
  });
});
