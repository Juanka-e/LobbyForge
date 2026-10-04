/**
 * Quiz, played by three people through the REAL lobby UI.
 *
 * The owner hosts; two invited guests play. All three join the voice
 * channel, then:
 *
 *   Lobby — the owner starts Quiz from the activities hub. Both guests
 *   ("Guest QuizKaya", "Guest QuizJuno") open the same hub and join the
 *   quiz. The owner leaves the player list (they wrote the questions), pastes
 *   three questions of their own, picks 30 s per question and no shuffle,
 *   and starts.
 *
 *   Questions — Kaya always answers right, Juno always wrong: once with
 *   the mouse, once with Enter on a focused tile, once with the A–D
 *   shortcut. When both have answered the question is revealed at once:
 *   the right answer, how many picked each option (never who) and the
 *   leaderboard. Mid-question the API hands out no deck and nobody else's
 *   answer. The host moves on, and after the last question shows the
 *   final results: Kaya on the podium, the full ranking below.
 *
 *   Packs — through the API: a pack game's questions are loaded by the
 *   server (a question list the client forges is ignored), and nothing the
 *   client receives carries an answer.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL), like the other
 * real-UI specs. Re-runs on a warm stack: the app is upserted and a
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
// Server-only pack data — fine in a test, never in client code.
import { findQuizPack } from '@lobbyforge/quiz/packs';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };

/** The paste format: question, answers, `*` marks the right one, blank line between questions. */
const QUESTIONS = [
  'What is the capital of Türkiye?',
  'Istanbul',
  '*Ankara',
  'Izmir',
  'Bursa',
  '',
  'How many legs does a spider have?',
  '4',
  '6',
  '*8',
  '10',
  '',
  'Which planet is known as the Red Planet?',
  '*Mars',
  'Venus',
  'Jupiter',
  'Saturn',
].join('\n');

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

function quizPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Quiz', exact: true });
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

/** Join the quiz from its panel. The name shown is the player's display name, from the host. */
async function joinQuiz(panel: Locator) {
  await panel.getByRole('button', { name: 'Join the quiz', exact: true }).click();
  await expect(panel.getByText('You’re playing.', { exact: true })).toBeVisible({ timeout: 15_000 });
}

test.describe('Quiz with a host and two players, through the lobby', () => {
  let ownBrowser: Browser;
  let ownerCtx: BrowserContext;
  let kayaCtx: BrowserContext;
  let junoCtx: BrowserContext;
  let owner: Page;
  let kaya: Page;
  let juno: Page;
  let serverId = '';
  let voiceChannelId = '';

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    // Own browser WITHOUT the config's --disable-web-security: that flag
    // makes Chromium drop the Origin header, which the app's CSRF guard
    // (rightly) rejects — and every answer is a POST from the page.
    ownBrowser = await playwright.chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    ownerCtx = await newUserContext(ownBrowser);
    kayaCtx = await newUserContext(ownBrowser);
    junoCtx = await newUserContext(ownBrowser);

    // Owner session: fresh stack → first-run setup; warm stack → login.
    const setup = await ownerCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Quiz E2E',
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
      servers: Array<{ id: string }>;
    };
    serverId = servers[0]!.id;
    const { channels } = (await (await ownerCtx.request.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    voiceChannelId = channels.find((c) => c.type === 'voice')!.id;

    // Installed and enabled (an upsert, so re-runs are fine) before any page
    // loads — the lobby lists apps when it renders.
    const install = await ownerCtx.request.post(`/api/servers/${serverId}/apps`, {
      headers: ORIGIN,
      data: { pluginId: 'quiz', enabled: true },
    });
    expect(install.status(), 'install quiz').toBe(200);
    await endOpenActivities(ownerCtx.request, serverId, voiceChannelId);

    // Two guests, each redeeming an invite from the owner.
    for (const [ctx, seed] of [
      [kayaCtx, 'QuizKaya'],
      [junoCtx, 'QuizJuno'],
    ] as const) {
      expect((await createGuest(ctx.request, { headers: ORIGIN, data: { displayNameSeed: seed } })).status()).toBe(200);
      const inviteRes = await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
      expect(inviteRes.status()).toBe(201);
      const { invite } = (await inviteRes.json()) as { invite: { code: string } };
      // The redeem route allows NO body — omit data.
      expect((await ctx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    }

    owner = await ownerCtx.newPage();
    kaya = await kayaCtx.newPage();
    juno = await junoCtx.newPage();
  });

  test.afterAll(async () => {
    if (ownerCtx && serverId && voiceChannelId) {
      await endOpenActivities(ownerCtx.request, serverId, voiceChannelId).catch(() => undefined);
    }
    await ownerCtx?.close();
    await kayaCtx?.close();
    await junoCtx?.close();
    await ownBrowser?.close();
  });

  test('a full quiz: lobby → three questions → final results', async () => {
    test.setTimeout(240_000);
    await joinVoice(owner, serverId);
    await joinVoice(kaya, serverId);
    await joinVoice(juno, serverId);

    // ── The host starts Quiz: the setup screen, and the host already on the player list.
    await openActivities(owner);
    await appCard(owner, 'Quiz').click();
    const ownerQuiz = quizPanel(owner);
    await expect(ownerQuiz.getByRole('heading', { name: 'Set up the quiz', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(ownerQuiz.getByText('You’re playing.', { exact: true })).toBeVisible();
    // The pack list is there, the viewer's language first.
    await expect(ownerQuiz.getByRole('button', { name: /General Knowledge/ })).toHaveAttribute('aria-pressed', 'true');

    // ── Both guests open the same hub and join.
    await openActivities(kaya);
    await openActivities(juno);
    const kayaQuiz = quizPanel(kaya);
    const junoQuiz = quizPanel(juno);
    for (const panel of [kayaQuiz, junoQuiz]) {
      await expect(panel.getByText(/Waiting for .+ to start the quiz…/)).toBeVisible({ timeout: 15_000 });
      // Only the host sets the quiz up.
      await expect(panel.getByRole('button', { name: 'Start quiz' })).toHaveCount(0);
    }
    await joinQuiz(kayaQuiz);
    await joinQuiz(junoQuiz);
    const ownerPlayers = ownerQuiz.getByRole('list', { name: 'Players', exact: true });
    await expect(ownerPlayers).toContainText('Kaya', { timeout: 15_000 });
    await expect(ownerPlayers).toContainText('Juno', { timeout: 15_000 });

    // ── The host wrote the questions, so they only host.
    await ownerQuiz.getByRole('button', { name: 'Leave the quiz', exact: true }).click();
    await expect(ownerQuiz.getByRole('button', { name: 'Join the quiz', exact: true })).toBeVisible({ timeout: 15_000 });

    // ── Custom questions: pasted, checked as you type, 30 s each, in order.
    await ownerQuiz.getByRole('group', { name: 'Questions', exact: true }).getByRole('button', { name: 'Your own' }).click();
    await ownerQuiz.getByLabel('Paste your questions').fill('Which planet is closest to the Sun?\nMercury\nVenus');
    await expect(ownerQuiz.getByText('Mark the right answer to question 1 with *.')).toBeVisible();
    await ownerQuiz.getByLabel('Paste your questions').fill(QUESTIONS);
    await expect(ownerQuiz.getByText('3 questions ready.')).toBeVisible();
    await ownerQuiz.getByRole('group', { name: 'Time per question', exact: true }).getByRole('button', { name: '30 s' }).click();
    await ownerQuiz.getByRole('group', { name: 'Shuffle', exact: true }).getByRole('button', { name: 'Off' }).click();
    await ownerQuiz.getByRole('button', { name: 'Start quiz', exact: true }).click();

    const heading = (panel: Locator, text: string) => panel.getByRole('heading', { name: new RegExp(text) });

    // ── Question 1 — answers with the mouse.
    for (const panel of [ownerQuiz, kayaQuiz, junoQuiz]) {
      await expect(heading(panel, 'What is the capital of Türkiye\\?')).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByText('Question 1 of 3').first()).toBeVisible();
    }
    // The host, off the player list, watches.
    await expect(ownerQuiz.getByText('You’re watching this one. Join to play from the next question.')).toBeVisible();
    await kayaQuiz.getByRole('button', { name: 'B: Ankara', exact: true }).click();
    await expect(kayaQuiz.getByText('Answer B is locked in — waiting for the others.')).toBeVisible({ timeout: 15_000 });
    await expect(ownerQuiz.getByText('1 of 2 answered')).toBeVisible({ timeout: 15_000 });
    await junoQuiz.getByRole('button', { name: 'A: Istanbul', exact: true }).click();

    // Everyone answered → revealed at once, for everyone.
    for (const panel of [ownerQuiz, kayaQuiz, junoQuiz]) {
      await expect(panel.getByRole('heading', { name: 'Correct answer: B · Ankara' })).toBeVisible({ timeout: 15_000 });
      const counts = panel.getByRole('list', { name: 'Correct answer: B · Ankara' });
      await expect(counts.getByRole('listitem').filter({ hasText: 'Ankara' })).toContainText('1 player');
      await expect(counts.getByRole('listitem').filter({ hasText: 'Izmir' })).toContainText('No one');
      // Counts only — the distribution never says who.
      await expect(counts).not.toContainText('Kaya');
      await expect(counts).not.toContainText('Juno');
      await expect(panel.getByRole('list', { name: 'Leaderboard' })).toContainText('Kaya');
    }
    await expect(kayaQuiz.getByText(/^You got it! \+\d/)).toBeVisible();
    await expect(junoQuiz.getByText('Not this time.')).toBeVisible();
    // Only the host moves the quiz on.
    await expect(kayaQuiz.getByRole('button', { name: 'Next question' })).toHaveCount(0);
    await ownerQuiz.getByRole('button', { name: 'Next question', exact: true }).click();

    // ── Question 2 — Enter on a focused tile; the API is checked while it is open.
    for (const panel of [ownerQuiz, kayaQuiz, junoQuiz]) {
      await expect(heading(panel, 'How many legs does a spider have\\?')).toBeVisible({ timeout: 15_000 });
    }
    await kayaQuiz.getByRole('button', { name: 'C: 8', exact: true }).focus();
    await kaya.keyboard.press('Enter');
    await expect(kayaQuiz.getByText('Answer C is locked in — waiting for the others.')).toBeVisible({ timeout: 15_000 });

    const [session] = (await openActivitiesIn(ownerCtx.request, serverId, voiceChannelId)).filter((a) => a.pluginId === 'quiz');
    expect(session, 'the running quiz').toBeTruthy();
    const stateAs = async (ctx: BrowserContext) => {
      const res = await ctx.request.get(`/api/servers/${serverId}/activities/${session!.id}`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { activity: { state: Record<string, unknown> } }).activity.state;
    };
    for (const [ctx, mine] of [
      [ownerCtx, null],
      [kayaCtx, 2],
      [junoCtx, null],
    ] as const) {
      const state = await stateAs(ctx);
      // No deck (every question WITH its answer) and no answers map, for anyone — the host included.
      expect(state.deck).toBeUndefined();
      expect(state.answers).toBeUndefined();
      expect(state.answeredCount).toBe(1);
      expect(state.myAnswer).toBe(mine);
      expect(state.reveal).toBeNull();
      expect(JSON.stringify(state)).not.toContain('correctIndex');
      expect(JSON.stringify(state)).not.toContain('Red Planet');
    }
    await junoQuiz.getByRole('button', { name: 'A: 4', exact: true }).click();
    for (const panel of [ownerQuiz, kayaQuiz, junoQuiz]) {
      await expect(panel.getByRole('heading', { name: 'Correct answer: C · 8' })).toBeVisible({ timeout: 15_000 });
    }
    await ownerQuiz.getByRole('button', { name: 'Next question', exact: true }).click();

    // ── Question 3 — the keyboard shortcut, while the question has focus.
    for (const panel of [ownerQuiz, kayaQuiz, junoQuiz]) {
      await expect(heading(panel, 'Which planet is known as the Red Planet\\?')).toBeVisible({ timeout: 15_000 });
    }
    await heading(kayaQuiz, 'Which planet is known as the Red Planet\\?').click();
    await kaya.keyboard.press('a');
    await expect(kayaQuiz.getByText('Answer A is locked in — waiting for the others.')).toBeVisible({ timeout: 15_000 });
    await junoQuiz.getByRole('button', { name: 'B: Venus', exact: true }).click();
    for (const panel of [ownerQuiz, kayaQuiz, junoQuiz]) {
      await expect(panel.getByRole('heading', { name: 'Correct answer: A · Mars' })).toBeVisible({ timeout: 15_000 });
    }
    await expect(ownerQuiz.getByRole('button', { name: 'Next question' })).toHaveCount(0);
    await ownerQuiz.getByRole('button', { name: 'See final results', exact: true }).click();

    // ── The end: Kaya on the podium, everyone in the ranking.
    for (const panel of [ownerQuiz, kayaQuiz, junoQuiz]) {
      await expect(panel.getByRole('heading', { name: 'Final results', exact: true })).toBeVisible({ timeout: 15_000 });
      const podium = panel.getByRole('list', { name: 'Podium', exact: true });
      await expect(podium).toContainText('1st place');
      await expect(podium).toContainText('Kaya');
      // Juno scored nothing: no podium place for zero points.
      await expect(podium).not.toContainText('Juno');
      const ranking = panel.getByRole('list', { name: 'Full ranking', exact: true });
      await expect(ranking.getByRole('listitem')).toHaveCount(2);
      await expect(ranking.getByRole('listitem').first()).toContainText('Kaya');
      await expect(ranking.getByRole('listitem').first()).toContainText('3 of 3 right');
      await expect(ranking.getByRole('listitem').last()).toContainText('0 of 3 right');
    }
    await expect(ownerQuiz.getByText('Want another round? End this activity and start Quiz again.')).toBeVisible();

    // ── Done: the host ends it, which frees the channel.
    await owner.getByTitle('End this activity for everyone').click();
    await expect(appCard(owner, 'Quiz')).toBeVisible({ timeout: 15_000 });
  });

  test('a pack game: the server loads the questions, the client never gets an answer', async () => {
    test.setTimeout(60_000);
    await endOpenActivities(ownerCtx.request, serverId, voiceChannelId);
    const created = await ownerCtx.request.post(`/api/servers/${serverId}/channels/${voiceChannelId}/activities`, {
      headers: ORIGIN,
      data: { pluginId: 'quiz' },
    });
    expect(created.status()).toBe(201);
    const { activity } = (await created.json()) as { activity: { id: string } };
    const act = (body: Record<string, unknown>) =>
      ownerCtx.request.post(`/api/servers/${serverId}/activities/${activity.id}/actions`, { headers: ORIGIN, data: body });

    // An unknown pack is refused before anything changes.
    expect((await act({ type: 'start', source: 'pack', packId: 'history', language: 'en' })).status()).toBe(400);

    // The host (on the player list as the creator) starts a pack game with a
    // FORGED question list: the server replaces it with the pack's questions.
    const forged = [{ question: 'Is this question forged?', options: ['Yes', 'No'], correctIndex: 0 }];
    const res = await act({
      type: 'start',
      source: 'pack',
      packId: 'science',
      language: 'en',
      questionCount: 5,
      secondsPerQuestion: 30,
      questions: forged,
    });
    expect(res.status()).toBe(200);
    const { state } = ((await res.json()) as { activity: { state: Record<string, unknown> } }).activity;
    expect(state.phase).toBe('playing');
    expect(state.questionTotal).toBe(5);
    expect(state.settings).toMatchObject({ source: 'pack', packId: 'science', packLanguage: 'en' });
    const current = state.current as { question: string; options: string[] };
    const pack = findQuizPack('science', 'en')!;
    expect(pack.questions.map((q) => q.question)).toContain(current.question);
    expect(current.options).toHaveLength(4);
    // No deck, no answers map, no answer anywhere — and no trace of the forgery.
    expect(state.deck).toBeUndefined();
    expect(state.answers).toBeUndefined();
    const json = JSON.stringify(state);
    expect(json).not.toContain('correctIndex');
    expect(json).not.toContain('forged');

    await endOpenActivities(ownerCtx.request, serverId, voiceChannelId);
  });
});
