/**
 * Poll and Dice Bot, played by two people through the REAL lobby UI.
 *
 * The owner (host) and an invited guest, each in their own browser
 * context, both join the voice channel. Then:
 *
 *   Poll — the owner starts it from the activities hub, writes a
 *   three-option poll (an empty one is refused with a reason), both vote,
 *   and both screens show the counts but never who voted — nor does the
 *   state the API hands out. The owner closes it: the winner is marked for
 *   everyone. The owner ends it, freeing the channel.
 *
 *   Dice Bot — the owner starts it, both roll, and each player's stats
 *   update on both screens. The owner resets the scores (after confirming)
 *   and the roll log survives.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL), like the other
 * real-UI specs. Re-runs on a warm stack: the apps are upserted and a
 * leftover activity in the voice channel is ended first.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };

const QUESTION = 'Which game on Friday?';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial' });

async function newUserContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: baseUrl, permissions: ['microphone', 'camera'] });
}

async function joinVoice(page: Page, serverId: string) {
  await page.goto(`/lobby?server=${serverId}`);
  const voiceChannel = page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
  await expect(voiceChannel).toBeVisible();
  await voiceChannel.click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
}

/** The chat header's "Activities" button opens the hub for the voice channel we are in. */
async function openActivities(page: Page) {
  await page.getByTitle('Start a game or activity in this voice room').click();
  await expect(page.getByRole('button', { name: 'Close activities', exact: true })).toBeVisible();
}

/** An app's launch card in the hub — not the sidebar chip, which only opens the hub. */
function appCard(page: Page, appName: string): Locator {
  return page
    .getByRole('button')
    .filter({ has: page.getByText(appName, { exact: true }) })
    .filter({ hasText: 'Start' });
}

async function openActivitiesIn(request: APIRequestContext, serverId: string, channelId: string) {
  const res = await request.get(`/api/servers/${serverId}/channels/${channelId}/activities`);
  if (!res.ok()) return [];
  const { activities } = (await res.json()) as {
    activities?: Array<{ id: string; pluginId: string; status: string }>;
  };
  return (activities ?? []).filter((a) => a.status !== 'ended' && a.status !== 'cancelled');
}

/** A channel holds one activity at a time; end whatever a previous run left behind. */
async function endOpenActivities(request: APIRequestContext, serverId: string, channelId: string) {
  for (const activity of await openActivitiesIn(request, serverId, channelId)) {
    await request.post(`/api/servers/${serverId}/activities/${activity.id}/end`, { headers: ORIGIN, data: {} });
  }
}

test.describe('Poll and Dice Bot with two players, through the lobby', () => {
  let ownBrowser: Browser;
  let ownerCtx: BrowserContext;
  let guestCtx: BrowserContext;
  let owner: Page;
  let guest: Page;
  let serverId = '';
  let voiceChannelId = '';
  let ownerName = '';
  let guestName = '';
  let guestUid = '';

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    // Own browser WITHOUT the config's --disable-web-security: that flag
    // makes Chromium drop the Origin header, which the app's CSRF guard
    // (rightly) rejects — and every vote and roll is a POST from the page.
    ownBrowser = await playwright.chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    ownerCtx = await newUserContext(ownBrowser);
    guestCtx = await newUserContext(ownBrowser);

    // Owner session: fresh stack → first-run setup; warm stack → login.
    const setup = await ownerCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Poll & Dice E2E',
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
    const ownerMe = (await (await ownerCtx.request.get('/api/auth/guest')).json()) as { guest: { name: string } };
    ownerName = ownerMe.guest.name;

    const { servers } = (await (await ownerCtx.request.get('/api/servers')).json()) as {
      servers: Array<{ id: string }>;
    };
    serverId = servers[0]!.id;
    const { channels } = (await (await ownerCtx.request.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    voiceChannelId = channels.find((c) => c.type === 'voice')!.id;

    // Both apps installed and enabled (an upsert, so re-runs are fine) —
    // before any page loads, because the lobby lists apps when it renders.
    for (const pluginId of ['poll', 'dice-bot']) {
      const install = await ownerCtx.request.post(`/api/servers/${serverId}/apps`, {
        headers: ORIGIN,
        data: { pluginId, enabled: true },
      });
      expect(install.status(), `install ${pluginId}`).toBe(200);
    }
    await endOpenActivities(ownerCtx.request, serverId, voiceChannelId);

    // Guest: a guest identity that redeems the owner's invite.
    const guestAuth = await createGuest(guestCtx.request, {
      headers: ORIGIN,
      data: { displayNameSeed: 'PollDice' },
    });
    expect(guestAuth.status()).toBe(200);
    const inviteRes = await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    // The redeem route allows NO body — omit data.
    expect((await guestCtx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    const guestMe = (await (await guestCtx.request.get('/api/auth/guest')).json()) as {
      guest: { uid: string; name: string };
    };
    guestUid = guestMe.guest.uid;
    guestName = guestMe.guest.name;
    expect(guestUid).toBeTruthy();
    // Both names are checked for ABSENCE on the poll — an empty one would pass vacuously.
    expect(ownerName.trim()).not.toBe('');
    expect(guestName.trim()).not.toBe('');

    owner = await ownerCtx.newPage();
    guest = await guestCtx.newPage();
  });

  test.afterAll(async () => {
    if (ownerCtx && serverId && voiceChannelId) {
      await endOpenActivities(ownerCtx.request, serverId, voiceChannelId).catch(() => undefined);
    }
    await ownerCtx?.close();
    await guestCtx?.close();
    await ownBrowser?.close();
  });

  test('poll: the host asks, both vote, everyone sees counts but never voters, the host closes it', async () => {
    test.setTimeout(180_000);
    await joinVoice(owner, serverId);
    await joinVoice(guest, serverId);

    // ── The host starts Poll and writes the question.
    await openActivities(owner);
    await appCard(owner, 'Poll').click();
    const ownerPoll = owner.getByRole('region', { name: 'Poll', exact: true });
    await expect(ownerPoll.getByRole('heading', { name: 'New poll', exact: true })).toBeVisible({ timeout: 15_000 });

    // An empty poll is refused with a reason, not sent.
    await ownerPoll.getByRole('button', { name: 'Open poll', exact: true }).click();
    await expect(ownerPoll.getByText('Write a question first.')).toBeVisible();
    await expect(ownerPoll.getByText('Fill in at least 2 options.')).toBeVisible();

    await ownerPoll.getByRole('textbox', { name: 'Question', exact: true }).fill(QUESTION);
    await ownerPoll.getByRole('textbox', { name: 'Option 1', exact: true }).fill('Hushle');
    await ownerPoll.getByRole('textbox', { name: 'Option 2', exact: true }).fill('Quiz');
    await ownerPoll.getByRole('button', { name: 'Add option' }).click();
    await ownerPoll.getByRole('textbox', { name: 'Option 3', exact: true }).fill('Watch Party');
    await ownerPoll.getByRole('button', { name: 'Open poll', exact: true }).click();
    await expect(ownerPoll.getByRole('heading', { name: QUESTION })).toBeVisible({ timeout: 15_000 });

    // ── The guest joins the running poll from the same hub.
    await openActivities(guest);
    const guestPoll = guest.getByRole('region', { name: 'Poll', exact: true });
    await expect(guestPoll.getByRole('heading', { name: QUESTION })).toBeVisible({ timeout: 15_000 });
    // Before voting there is no running tally to sway anyone.
    await expect(guestPoll.getByText(/\d+%/)).toHaveCount(0);
    // Only the host gets the lifecycle controls.
    await expect(guestPoll.getByRole('button', { name: 'Close poll', exact: true })).toHaveCount(0);

    // ── Both vote for the same option.
    await guestPoll.getByRole('button', { name: 'Vote for Hushle' }).click();
    await expect(guestPoll.getByText('Your vote', { exact: true })).toBeVisible({ timeout: 15_000 });
    await ownerPoll.getByRole('button', { name: 'Vote for Hushle' }).click();
    await expect(ownerPoll.getByText('Your vote', { exact: true })).toBeVisible({ timeout: 15_000 });

    // ── Counts, never voters — on both screens…
    for (const poll of [ownerPoll, guestPoll]) {
      await expect(poll.getByText(/^(2 votes|2 of \d+ players voted) · nobody can see who voted for what$/)).toBeVisible({
        timeout: 15_000,
      });
      const hushle = poll.getByRole('listitem').filter({ hasText: 'Hushle' });
      await expect(hushle).toContainText('2 votes');
      await expect(hushle).toContainText('100%');
      await expect(poll.getByRole('listitem').filter({ hasText: 'Quiz' })).toContainText('0 votes');
      await expect(poll).not.toContainText(ownerName);
      await expect(poll).not.toContainText(guestName);
    }

    // …and in the state the server hands out: a count, no ballot box.
    const [pollSession] = (await openActivitiesIn(ownerCtx.request, serverId, voiceChannelId)).filter(
      (a) => a.pluginId === 'poll'
    );
    expect(pollSession, 'the running poll').toBeTruthy();
    const detail = await ownerCtx.request.get(`/api/servers/${serverId}/activities/${pollSession!.id}`);
    expect(detail.status()).toBe(200);
    const { activity } = (await detail.json()) as {
      activity: { state: { ballotBox?: unknown; ballotCount: number; hasVoted: boolean; options: Array<{ votes: number }> } };
    };
    expect(activity.state.ballotBox).toBeUndefined();
    expect(activity.state.ballotCount).toBe(2);
    expect(activity.state.hasVoted).toBe(true);
    expect(activity.state.options.map((o) => o.votes)).toEqual([2, 0, 0]);
    expect(JSON.stringify(activity.state)).not.toContain(guestUid);

    // ── The host closes it; everyone sees the final result and its winner.
    await ownerPoll.getByRole('button', { name: 'Close poll', exact: true }).click();
    for (const poll of [ownerPoll, guestPoll]) {
      await expect(poll.getByText('Final results')).toBeVisible({ timeout: 15_000 });
      await expect(poll.getByText('Closed', { exact: true })).toBeVisible();
      await expect(poll.getByRole('listitem').filter({ hasText: 'Hushle' })).toContainText('Winner');
      await expect(poll.getByRole('button', { name: /^Vote for/ })).toHaveCount(0);
    }
    await expect(ownerPoll.getByRole('button', { name: 'Reopen poll', exact: true })).toBeVisible();
    await expect(ownerPoll.getByRole('button', { name: 'New poll', exact: true })).toBeVisible();
    await expect(guestPoll.getByRole('button', { name: 'Reopen poll', exact: true })).toHaveCount(0);

    // ── Done: the host ends it, which frees the channel for the next activity.
    await owner.getByTitle('End this activity for everyone').click();
    await expect(appCard(owner, 'Dice Bot')).toBeVisible({ timeout: 15_000 });
  });

  test('dice bot: both roll and each player’s stats update on both screens', async () => {
    test.setTimeout(180_000);

    // ── The host starts Dice Bot in the channel the poll just freed.
    await appCard(owner, 'Dice Bot').click();
    const ownerDice = owner.getByRole('region', { name: 'Dice Bot', exact: true });
    await expect(ownerDice.getByText('No one has rolled yet — pick a die and go first.')).toBeVisible({ timeout: 15_000 });

    // The guest's hub still shows the poll that ended; reopening it finds the new activity.
    await guest.getByRole('button', { name: 'Close activities', exact: true }).click();
    await openActivities(guest);
    const guestDice = guest.getByRole('region', { name: 'Dice Bot', exact: true });
    await expect(guestDice.getByRole('button', { name: /^Roll d6/ })).toBeVisible({ timeout: 15_000 });

    // ── Both roll: the host picks a d20, the guest keeps the default d6.
    await ownerDice.getByRole('group', { name: 'Die' }).getByRole('button', { name: 'd20', exact: true }).click();
    await ownerDice.getByRole('button', { name: /^Roll d20/ }).click();
    await expect(ownerDice.getByRole('status')).toHaveText(/^You rolled d20 · \d+$/, { timeout: 15_000 });
    await guestDice.getByRole('button', { name: /^Roll d6/ }).click();
    await expect(guestDice.getByRole('status')).toHaveText(/^You rolled d6 · \d+$/, { timeout: 15_000 });

    // Each screen marks the viewer's own row "You" (a badge after their name,
    // or the name itself when the host does not know it); the other row is
    // the other player.
    const playerRows = (panel: Locator) =>
      panel
        .getByRole('table', { name: 'Player stats' })
        .getByRole('row')
        .filter({ has: panel.page().getByRole('rowheader') });
    const you = (panel: Locator) => panel.page().getByRole('rowheader', { name: /\bYou\b/ });
    const mine = (panel: Locator) => playerRows(panel).filter({ has: you(panel) });
    const theirs = (panel: Locator) => playerRows(panel).filter({ hasNot: you(panel) });
    const cells = (row: Locator) => row.getByRole('cell'); // rolls, average, best

    for (const panel of [ownerDice, guestDice]) {
      await expect(playerRows(panel)).toHaveCount(2, { timeout: 15_000 });
      for (const row of [mine(panel), theirs(panel)]) {
        await expect(cells(row).nth(0)).toHaveText('1');
        await expect(cells(row).nth(1)).toHaveText(/^\d+[.,]\d$/);
        await expect(cells(row).nth(2)).toHaveText(/^\d+$/);
      }
    }

    // ── The guest rolls again: their count moves on both screens, the host's does not.
    await guestDice.getByRole('button', { name: /^Roll d6/ }).click();
    await expect(cells(mine(guestDice)).nth(0)).toHaveText('2', { timeout: 15_000 });
    await expect(cells(theirs(ownerDice)).nth(0)).toHaveText('2', { timeout: 15_000 });
    await expect(cells(mine(ownerDice)).nth(0)).toHaveText('1');
    await expect(cells(theirs(guestDice)).nth(0)).toHaveText('1');
    for (const panel of [ownerDice, guestDice]) {
      await expect(panel.getByRole('listitem')).toHaveCount(3, { timeout: 15_000 });
    }

    // ── Only the host can reset, and only after confirming; the roll log survives.
    await expect(guestDice.getByRole('button', { name: /^Reset scores/ })).toHaveCount(0);
    await ownerDice.getByRole('button', { name: /^Reset scores/ }).click();
    await ownerDice.getByRole('button', { name: 'Yes, reset scores' }).click();
    for (const panel of [ownerDice, guestDice]) {
      await expect(panel.getByText('Stats appear after the first roll.')).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole('listitem')).toHaveCount(3);
    }

    // ── Leave the channel free for the next run.
    await owner.getByTitle('End this activity for everyone').click();
    await expect(appCard(owner, 'Poll')).toBeVisible({ timeout: 15_000 });
  });
});
