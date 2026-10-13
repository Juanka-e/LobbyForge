/**
 * Activities while someone drops out — real browsers, several players at
 * once, in the community's first voice channel (docs/ACTIVITY_INTEGRITY_
 * AND_RESILIENCE.md, lib/activity-action-retry.ts, lib/activity-host.ts,
 * the plugins' stale-intent fields).
 *
 *   Dice Bot   a roll pressed during a network blink lands once: the retry
 *              carries the same actionId; a lost answer is not counted
 *              twice; a reload mid-game puts the panel back, and the other
 *              panels are nudged to re-read (`presenceChanged`)
 *   Poll       a vote pressed on a poll that moved on (offline, then
 *              retried) is ignored (`pollId`); the dropped panel resyncs
 *   Quiz       a late answer / a second "Next" is ignored (`questionIndex`);
 *              the host leaves voice → after the 60 s grace hosting moves
 *              to a player; the old host coming back does not take it back
 *   Hushle     the explainer's teammate never receives the card (network
 *              responses, WebSocket frames, DOM); stale card moves
 *              (`cardSeq`) and turn moves (`turnNumber`) are ignored; an
 *              opponent who drops resyncs to the new card
 *   Vampire    five players; a villager who drops resyncs; nobody's state
 *   Village    carries another player's role; a stale `advance` is ignored
 *   Watch      a viewer who drops comes back to the current queue
 *   Party
 *   rules      voice_required ("Join the voice channel to play [Join]"),
 *              watching needs no voice, a timed-out member cannot play
 *              (403 timed_out), one activity per channel (409)
 *
 * The marketplace sandbox buzzer's timers are covered by
 * marketplace-sandbox.spec.ts ("a round nobody reveals reveals itself
 * after 30 s"), part of the full run.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Screenshots, dark
 * and light, go to LF_E2E_SHOT_DIR (or the test output folder).
 */
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { resetRateLimits } from './helpers/auth';
import {
  baseUrl,
  endOpenActivities,
  firstServerId,
  guestMember,
  json,
  launchRealUi,
  listChannels,
  ORIGIN,
  ownerContext,
  send,
  SHOT_DIR,
  shootBothThemes,
  type Person,
} from './helpers/stack';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

/** An observation for the report: kept as an annotation and printed by the list reporter. */
function note(testInfo: { annotations: Array<{ type: string; description?: string }> }, entry: { type: string; description: string }) {
  testInfo.annotations.push(entry);
  console.info(`[note] ${entry.type}: ${entry.description}`);
}
test.describe.configure({ mode: 'default', timeout: 240_000 });

const RUN = Date.now().toString(36).slice(-4);
const SYNC = { timeout: 20_000 };

interface Player extends Person {
  page: Page;
}

function shot(testInfo: { outputPath: (name: string) => string }, name: string) {
  return (theme: 'dark' | 'light') => (SHOT_DIR ? join(SHOT_DIR, `${name}-${theme}.png`) : testInfo.outputPath(`${name}-${theme}.png`));
}

const footerStatus = (page: Page) => page.getByText(/^(Voice Connected|Voice Ready|Connecting\.\.\.|Reconnecting\.\.\.)$/).first();

let browser: Browser;
let owner: Player;
let ann: Player;
let bea: Player;
let cid: Player;
let serverId = '';
let voiceId = '';
let voiceName = '';

async function inVoice(p: Player): Promise<void> {
  if (!p.page.url().includes('/lobby')) await p.page.goto(`/lobby?server=${serverId}`);
  const status = await footerStatus(p.page).textContent({ timeout: 10_000 }).catch(() => null);
  if (status === 'Voice Connected') return;
  if (status === null) await p.page.goto(`/lobby?server=${serverId}`);
  await p.page.getByRole('button', { name: voiceName }).filter({ has: p.page.locator('span', { hasText: 'volume_up' }) }).first().click();
  await expect(footerStatus(p.page)).toHaveText('Voice Connected', { timeout: 30_000 });
}

/** The activities view of the voice channel, from the chat header (in voice) or the sidebar. */
async function openHub(p: Player): Promise<void> {
  const close = p.page.getByRole('button', { name: 'Close activities', exact: true });
  const header = p.page.getByTitle('Start a game or activity in this voice room');
  const sidebar = p.page.getByTitle(`Open activities in ${voiceName}`);
  // Right after a navigation the lobby may still reopen the view this tab
  // had open (lf.view.v1): let the page settle on one or the other first.
  await expect(close.or(header).or(sidebar).first()).toBeVisible(SYNC);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await close.isVisible().catch(() => false)) return;
    const entry = (await header.isVisible().catch(() => false)) ? header : sidebar;
    await entry.click({ timeout: 5_000 }).catch(() => undefined);
    if (await close.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) return;
    await p.page.waitForTimeout(500);
  }
  await expect(close).toBeVisible(SYNC);
}

async function start(pluginId: string): Promise<string> {
  await endOpenActivities(owner.api, serverId, voiceId);
  const res = await send(() => owner.api.post(`/api/servers/${serverId}/channels/${voiceId}/activities`, { headers: ORIGIN, data: { pluginId } }));
  expect(res.status(), `start ${pluginId}: ${await res.text()}`).toBe(201);
  return (await json<{ activity: { id: string } }>(res)).activity.id;
}

async function act(api: APIRequestContext, sessionId: string, body: Record<string, unknown>) {
  const res = await send(() =>
    api.post(`/api/servers/${serverId}/activities/${sessionId}/actions`, { headers: ORIGIN, data: { actionId: crypto.randomUUID(), ...body } })
  );
  const text = await res.text();
  let state: Record<string, any> | null = null;
  try {
    state = res.status() === 200 ? (JSON.parse(text) as { activity: { state: Record<string, any> } }).activity.state : null;
  } catch {
    state = null;
  }
  return { status: res.status(), state, text, code: (() => { try { return (JSON.parse(text) as { code?: string }).code; } catch { return undefined; } })() };
}

async function stateOf(api: APIRequestContext, sessionId: string): Promise<Record<string, any>> {
  const res = await send(() => api.get(`/api/servers/${serverId}/activities/${sessionId}`));
  expect(res.status()).toBe(200);
  return (await json<{ activity: { state: Record<string, any> } }>(res)).activity.state;
}

async function detailOf(api: APIRequestContext, sessionId: string): Promise<Record<string, any>> {
  const res = await send(() => api.get(`/api/servers/${serverId}/activities/${sessionId}`));
  expect(res.status()).toBe(200);
  return (await json<{ activity: Record<string, any> }>(res)).activity;
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(240_000);
  resetRateLimits();
  browser = await launchRealUi(playwright);
  const media = { permissions: ['microphone'], viewport: { width: 1360, height: 900 }, colorScheme: 'dark' as const };
  const ownerPerson = await ownerContext(browser, media);
  serverId = await firstServerId(ownerPerson.api);
  const voice = (await listChannels(ownerPerson.api, serverId)).find((c) => c.type === 'voice')!;
  voiceId = voice.id;
  voiceName = voice.name;
  for (const pluginId of ['dice-bot', 'poll', 'quiz', 'hushle', 'vampire-village', 'watch-party']) {
    const install = await send(() => ownerPerson.api.post(`/api/servers/${serverId}/apps`, { headers: ORIGIN, data: { pluginId, enabled: true } }));
    expect(install.status(), `install ${pluginId}`).toBe(200);
  }
  await endOpenActivities(ownerPerson.api, serverId, voiceId);
  const make = async (seed: string): Promise<Player> => {
    const person = await guestMember(browser, ownerPerson.api, serverId, `${seed} ${RUN}`, media);
    const page = await person.ctx.newPage();
    page.on('dialog', (dialog) => void dialog.accept());
    return { ...person, page };
  };
  owner = { ...ownerPerson, page: await ownerPerson.ctx.newPage() };
  owner.page.on('dialog', (dialog) => void dialog.accept());
  ann = await make('Ann');
  bea = await make('Bea');
  cid = await make('Cid');
});

test.afterAll(async () => {
  if (owner && serverId) await endOpenActivities(owner.api, serverId, voiceId).catch(() => undefined);
  for (const p of [ann, bea, cid, owner]) await p?.ctx.close().catch(() => undefined);
  await browser?.close();
});

// ── Dice Bot ─────────────────────────────────────────────────────────────

const dicePanel = (p: Player): Locator => p.page.getByRole('region', { name: 'Dice Bot', exact: true });
const rollButton = (p: Player): Locator => dicePanel(p).getByRole('button', { name: /^Roll a 6-sided die/ });

test('Dice: a roll pressed during a network blink lands once (same actionId); a lost answer is not counted twice', async () => {
  for (const p of [owner, ann, bea]) await inVoice(p);
  const session = await start('dice-bot');
  for (const p of [owner, ann, bea]) {
    await openHub(p);
    await expect(rollButton(p)).toBeVisible(SYNC);
  }

  const sent: string[] = [];
  const onRequest = (req: import('@playwright/test').Request) => {
    if (req.method() === 'POST' && /\/activities\/[^/]+\/actions$/.test(new URL(req.url()).pathname)) {
      sent.push(String((req.postDataJSON() as { actionId?: string }).actionId));
    }
  };
  ann.page.on('request', onRequest);

  // ── The blink: offline, press Roll, back online within the retry window.
  await ann.ctx.setOffline(true);
  await rollButton(ann).click();
  await ann.page.waitForTimeout(2_500);
  await ann.ctx.setOffline(false);
  await expect(dicePanel(ann).getByRole('status')).toHaveText(/^You rolled a 6-sided die\s· \d+$/, { timeout: 15_000 });
  await expect.poll(async () => (await stateOf(owner.api, session)).stats?.[ann.uid]?.rolls ?? 0, SYNC).toBe(1);
  expect(sent.length, 'the press was sent more than once (a retry)').toBeGreaterThanOrEqual(2);
  expect(new Set(sent).size, 'every attempt carried the same actionId').toBe(1);

  // ── A lost answer: the first attempt commits on the server, its answer
  // never arrives; the retry (same actionId) is answered as a duplicate.
  sent.length = 0;
  let intercepted = false;
  await ann.page.route('**/activities/*/actions', async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    await route.fetch(); // reaches the server and commits
    await route.abort('connectionreset');
  });
  await rollButton(ann).click();
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(new Set(sent).size).toBe(1);
  await expect.poll(async () => (await stateOf(owner.api, session)).stats?.[ann.uid]?.rolls ?? 0, SYNC).toBe(2);
  await ann.page.waitForTimeout(2_000);
  expect((await stateOf(owner.api, session)).stats?.[ann.uid]?.rolls).toBe(2);
  await ann.page.unroute('**/activities/*/actions');
  ann.page.off('request', onRequest);
  // Every panel shows two rolls for Ann, none shows an error.
  for (const p of [owner, bea]) {
    const row = dicePanel(p).getByRole('table', { name: 'Player stats' }).getByRole('row').filter({ hasText: ann.name });
    await expect(row.getByRole('cell').first()).toHaveText('2', SYNC);
  }
  await expect(dicePanel(ann).getByRole('alert')).toHaveCount(0);
});

test('Dice: a reload mid-game puts the panel back, and the other panels are nudged to re-read (presenceChanged)', async () => {
  for (const p of [owner, ann, bea]) await inVoice(p);
  let session = await currentSession();
  const running = session ? await detailOf(owner.api, session) : null;
  if (!running || running.pluginId !== 'dice-bot') session = await start('dice-bot');
  for (const p of [owner, bea]) await openHub(p);
  // Bea is seated once she rolls.
  await rollButton(bea).click();
  await expect(dicePanel(bea).getByRole('status')).toHaveText(/You rolled/, SYNC);

  const reads: number[] = [];
  const onRead = (req: import('@playwright/test').Request) => {
    if (req.method() === 'GET' && new URL(req.url()).pathname === `/api/servers/${serverId}/activities/${session}`) reads.push(Date.now());
  };
  owner.page.on('request', onRead);
  const before = Date.now();
  await bea.page.reload();
  // Back in voice by herself, the activities view reopened, her stats there.
  await expect(footerStatus(bea.page)).toHaveText('Voice Connected', { timeout: 30_000 });
  await expect(rollButton(bea)).toBeVisible(SYNC);
  const mine = dicePanel(bea).getByRole('rowheader', { name: /\bYou\b/ });
  await expect(mine).toBeVisible(SYNC);
  // The LiveKit webhook told the open panels she left and came back.
  await expect.poll(() => reads.filter((at) => at > before).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  owner.page.off('request', onRead);
});

async function currentSession(): Promise<string> {
  const res = await owner.api.get(`/api/servers/${serverId}/channels/${voiceId}/activities`);
  const { activities } = await json<{ activities?: Array<{ id: string; status: string }> }>(res);
  return (activities ?? []).find((a) => a.status !== 'ended' && a.status !== 'cancelled')?.id ?? '';
}

// ── Poll ─────────────────────────────────────────────────────────────────

const pollPanel = (p: Player): Locator => p.page.getByRole('region', { name: 'Poll', exact: true });

test('Poll: a vote pressed on a poll that moved on is ignored (pollId); the dropped panel resyncs', async () => {
  for (const p of [owner, ann, cid]) await inVoice(p);
  const session = await start('poll');
  const first = await act(owner.api, session, { type: 'open-poll', question: `First? ${RUN}`, options: ['Red', 'Blue'] });
  expect(first.status, first.text).toBe(200);
  const firstPollId = first.state!.pollId as number;
  for (const p of [ann, cid]) {
    await openHub(p);
    await expect(pollPanel(p).getByRole('heading', { name: `First? ${RUN}` })).toBeVisible(SYNC);
  }

  // Cid drops; while away the host closes the poll and opens another
  // whose options share the old ones' ids.
  await cid.ctx.setOffline(true);
  expect((await act(owner.api, session, { type: 'close-poll' })).status).toBe(200);
  const second = await act(owner.api, session, { type: 'open-poll', question: `Second? ${RUN}`, options: ['Red', 'Blue'] });
  expect(second.state!.pollId).toBe(firstPollId + 1);
  // Cid's screen still shows the first poll; the press goes out on reconnect.
  await expect(pollPanel(cid).getByRole('heading', { name: `First? ${RUN}` })).toBeVisible();
  await pollPanel(cid).getByRole('button', { name: 'Vote for Red' }).click();
  await cid.page.waitForTimeout(1_500);
  await cid.ctx.setOffline(false);
  // Back online: the panel re-reads and shows the new poll …
  await expect(pollPanel(cid).getByRole('heading', { name: `Second? ${RUN}` })).toBeVisible(SYNC);
  // … and the late vote, meant for the first poll, counted nowhere.
  await cid.page.waitForTimeout(3_000);
  const now = await stateOf(owner.api, session);
  expect(now.pollId).toBe(firstPollId + 1);
  expect(now.ballotCount).toBe(0);
  expect(now.options.map((o: { votes: number }) => o.votes)).toEqual([0, 0]);
  // The same stale vote over the API: accepted as a no-op, never counted.
  const stale = await act(ann.api, session, { type: 'vote', optionId: now.options[0].id, pollId: firstPollId });
  expect(stale.status).toBe(200);
  expect((await stateOf(owner.api, session)).ballotCount).toBe(0);
  // A fresh vote for the poll on screen counts.
  const fresh = await act(ann.api, session, { type: 'vote', optionId: now.options[0].id, pollId: firstPollId + 1 });
  expect(fresh.status).toBe(200);
  expect((await stateOf(owner.api, session)).ballotCount).toBe(1);
});

// ── Quiz ─────────────────────────────────────────────────────────────────

const quizPanel = (p: Player): Locator => p.page.getByRole('region', { name: 'Quiz', exact: true });
const QUESTIONS = [
  { question: `Capital of Turkey? ${RUN}`, options: ['Istanbul', 'Ankara', 'Izmir', 'Bursa'], correctIndex: 1 },
  { question: `Two plus two? ${RUN}`, options: ['3', '4', '5', '6'], correctIndex: 1 },
  { question: `Red planet? ${RUN}`, options: ['Mars', 'Venus', 'Earth', 'Jupiter'], correctIndex: 0 },
];

test('Quiz: stale answers and a second "Next" are ignored (questionIndex); a dropped player resyncs; the answer never reaches players early', async () => {
  for (const p of [owner, ann, bea, cid]) await inVoice(p);
  const session = await start('quiz');
  const bodies: string[] = [];
  const onResponse = async (res: import('@playwright/test').Response) => {
    if (new URL(res.url()).pathname.includes(`/activities/${session}`)) bodies.push(await res.text().catch(() => ''));
  };
  ann.page.on('response', onResponse);
  for (const p of [ann, bea, cid]) {
    await openHub(p);
    expect((await act(p.api, session, { type: 'join' })).status).toBe(200);
  }
  const started = await act(owner.api, session, { type: 'start', source: 'custom', questions: QUESTIONS, secondsPerQuestion: 30, shuffle: false });
  expect(started.status, started.text).toBe(200);
  for (const p of [ann, bea, cid]) await expect(quizPanel(p).getByText(QUESTIONS[0]!.question).first()).toBeVisible(SYNC);
  // Before the reveal no player's answers carry the correct option.
  expect(JSON.stringify(await stateOf(ann.api, session))).not.toMatch(/"correctIndex"\s*:\s*1/);

  // Ann answers question 1; then the host reveals and moves on, while Cid is offline.
  await quizPanel(ann).getByRole('button', { name: 'B: Ankara', exact: true }).click();
  await expect(quizPanel(ann).getByText(/Answer B is locked in/)).toBeVisible(SYNC);
  await cid.ctx.setOffline(true);
  expect((await act(owner.api, session, { type: 'reveal', questionIndex: 0 })).status).toBe(200);
  const next = await act(owner.api, session, { type: 'next', questionIndex: 0 });
  expect(next.state!.currentIndex).toBe(1);
  // A second "Next" for question 1 (a double tap, or a moderator at the same time) skips nothing.
  const again = await act(owner.api, session, { type: 'next', questionIndex: 0 });
  expect(again.status).toBe(200);
  expect((await stateOf(owner.api, session)).currentIndex).toBe(1);
  // A late answer to question 1 does not land on question 2.
  const late = await act(bea.api, session, { type: 'answer', index: 1, questionIndex: 0 });
  expect(late.status).toBe(200);
  expect((await stateOf(owner.api, session)).answeredCount).toBe(0);
  // Cid comes back: the panel shows question 2.
  await cid.page.waitForTimeout(5_000);
  await cid.ctx.setOffline(false);
  await expect(quizPanel(cid).getByText(QUESTIONS[1]!.question).first()).toBeVisible(SYNC);
  // A current answer counts.
  expect((await act(bea.api, session, { type: 'answer', index: 1, questionIndex: 1 })).status).toBe(200);
  expect((await stateOf(owner.api, session)).answeredCount).toBe(1);
  ann.page.off('response', onResponse);
  // Nothing Ann's page received before question 2's reveal named its answer.
  const q2Bodies = bodies.filter((b) => b.includes(QUESTIONS[1]!.question));
  for (const body of q2Bodies) expect(body).not.toMatch(/"correctIndex"\s*:/);
});

test('Quiz: the host leaves voice — after the 60 s grace a player hosts; the old host coming back does not take it back', async ({}, testInfo) => {
  test.setTimeout(300_000);
  for (const p of [owner, ann, bea, cid]) await inVoice(p);
  let session = await currentSession();
  const detail = session ? await detailOf(owner.api, session) : null;
  if (!detail || detail.pluginId !== 'quiz' || detail.createdBy !== owner.uid) {
    session = await start('quiz');
    for (const p of [ann, bea, cid]) expect((await act(p.api, session, { type: 'join' })).status).toBe(200);
    expect((await act(owner.api, session, { type: 'start', source: 'custom', questions: QUESTIONS, secondsPerQuestion: 30, shuffle: false })).status).toBe(200);
  }
  for (const p of [owner, ann, bea, cid]) await openHub(p);

  // The host leaves the voice room (on purpose: no way back offered).
  await owner.page.getByTitle('Disconnect', { exact: true }).click();
  await expect(footerStatus(owner.page)).toHaveText('Voice Ready');
  const left = Date.now();
  for (const p of [ann, bea]) {
    await expect(p.page.getByText('The host left the voice channel. Someone here takes over in a moment.')).toBeVisible({ timeout: 45_000 });
  }
  // Nobody acts: the panels re-read at the due moment and hosting moves.
  await expect
    .poll(async () => (await detailOf(ann.api, session)).createdBy, { timeout: 120_000, intervals: [5_000] })
    .not.toBe(owner.uid);
  const after = await detailOf(ann.api, session);
  const newHost = [ann, bea, cid].find((p) => p.uid === after.createdBy);
  expect(newHost, 'hosting went to a player in the room').toBeTruthy();
  note(testInfo, { type: 'host transfer', description: `after ${Math.round((Date.now() - left) / 1000)} s to ${newHost!.name}` });
  expect(Date.now() - left).toBeGreaterThanOrEqual(58_000);
  await expect(newHost!.page.getByText('You are the host')).toBeVisible(SYNC);
  await expect(quizPanel(newHost!)).toBeVisible();
  await shootBothThemes(newHost!.page, shot(testInfo, 'activity-1-host-transferred'));
  // The old host coming back to voice does not take hosting back.
  await inVoice(owner);
  await owner.page.waitForTimeout(3_000);
  expect((await detailOf(owner.api, session)).createdBy).toBe(newHost!.uid);
  // Hosting really moved: another player (no Start Activity) is refused a
  // host action the new host — a guest without Start Activity too — may take.
  // (The old host here is the owner, whose Start Activity lets them run the
  // table anyway, by design — actions route, `role: 'host'`.)
  const other = [ann, bea, cid].find((p) => p !== newHost)!;
  const refused = await act(other.api, session, { type: 'end' });
  expect(refused.status).toBe(403);
  expect(refused.code).toBe('not_host');
  const ended = await act(newHost!.api, session, { type: 'end' });
  expect(ended.status, ended.text).toBe(200);
  expect(ended.state!.phase).toBe('ended');
  // The audit log tells the story.
  const audit = await send(() => owner.api.get(`/api/servers/${serverId}/audit-logs?limit=50`));
  expect(await audit.text()).toContain('activity.host_transfer');
});

// ── Hushle ───────────────────────────────────────────────────────────────

const hushle = (p: Player): Locator => p.page.locator('.lfui.hushle');

test('Hushle: the teammate never receives the card; stale card and turn moves are ignored; a dropped opponent resyncs', async () => {
  for (const p of [owner, ann, bea, cid]) await inVoice(p);
  const session = await start('hushle');
  // Everything the host's page receives (the host is Ann's teammate this turn).
  const received: string[] = [];
  owner.page.on('response', async (res) => {
    if (res.url().startsWith(baseUrl)) received.push(await res.text().catch(() => ''));
  });
  owner.page.on('websocket', (ws) => ws.on('framereceived', (frame) => received.push(String(frame.payload))));
  for (const p of [owner, ann, bea, cid]) await openHub(p);

  const begin = await act(owner.api, session, { type: 'start-game', packId: 'hushle-en-basic', language: 'en', cardsPerTurn: 5, turnDurationSeconds: 120, createdBy: owner.uid });
  expect(begin.status, begin.text).toBe(200);
  const teams = await act(owner.api, session, {
    type: 'set-teams',
    teams: [
      { name: 'Ice', playerIds: [ann.uid, owner.uid] },
      { name: 'Amber', playerIds: [bea.uid, cid.uid] },
    ],
  });
  expect(teams.status, teams.text).toBe(200);
  const ice = (teams.state!.teams as Array<{ id: string; name: string }>).find((t) => t.name === 'Ice')!.id;
  const turn = await act(owner.api, session, { type: 'start-turn', teamId: ice, explainerId: ann.uid, turnNumber: teams.state!.turnNumber ?? 0 });
  expect(turn.status, turn.text).toBe(200);
  expect(turn.state!.currentCard, 'the host is the explainer’s teammate: no card').toBeNull();

  // The explainer and the other team see the card; the teammate does not.
  const annView = await stateOf(ann.api, session);
  const word = annView.currentCard.word as string;
  expect(word).toBeTruthy();
  await expect(hushle(bea).locator('.hushle-word')).toHaveText(word, SYNC);
  await expect(hushle(owner).getByRole('article', { name: 'Word card' })).toHaveCount(0);
  await expect(hushle(owner)).not.toContainText(word);
  // Nothing the host's page received — HTTP or WebSocket — carries the card in play.
  await owner.page.waitForTimeout(1_500);
  expect(received.join(' '), 'the host received the card in play').not.toContain(`"${word}"`);

  // Stale card moves: a "Got it" for the card that is gone does nothing.
  const seq = annView.cardSeq as number;
  const got = await act(owner.api, session, { type: 'correct-guess', cardSeq: seq });
  expect(got.status).toBe(200);
  const scoreAfterOne = JSON.stringify((await stateOf(owner.api, session)).teams);
  const staleGot = await act(owner.api, session, { type: 'correct-guess', cardSeq: seq });
  expect(staleGot.status).toBe(200);
  expect(JSON.stringify((await stateOf(owner.api, session)).teams)).toBe(scoreAfterOne);

  // Bea drops; the host passes the card meanwhile; she comes back to the new one.
  const before = (await stateOf(bea.api, session)).currentCard.word as string;
  await bea.ctx.setOffline(true);
  const passed = await act(owner.api, session, { type: 'pass', cardSeq: seq + 1 });
  expect(passed.status).toBe(200);
  const fresh = (await stateOf(cid.api, session)).currentCard.word as string;
  expect(fresh).not.toBe(before);
  await bea.page.waitForTimeout(4_000);
  await bea.ctx.setOffline(false);
  await expect(hushle(bea).locator('.hushle-word')).toHaveText(fresh, SYNC);
  await expect(hushle(owner)).not.toContainText(fresh);
  expect(received.join(' '), 'the host received the new card').not.toContain(`"${fresh}"`);
  // Cid reloads mid-turn: back in voice by himself, the game view reopened, the same card.
  await cid.page.reload();
  await expect(footerStatus(cid.page)).toHaveText('Voice Connected', { timeout: 30_000 });
  await expect(hushle(cid).locator('.hushle-word')).toHaveText(fresh, SYNC);
  // … and BUST still works for him (the voice room is his again).
  await expect(hushle(cid).getByRole('button', { name: 'BUST! Forbidden word' })).toBeEnabled(SYNC);

  // Stale turn moves: End turn pressed twice for the same turn (a double
  // tap, or the host and a moderator together) ends ONE turn — the second
  // press must not end the next team's turn the moment it begins.
  const current = await stateOf(owner.api, session);
  const turnNo = current.turnNumber as number;
  const firstEnd = await act(owner.api, session, { type: 'end-turn', turnNumber: turnNo });
  expect(firstEnd.status).toBe(200);
  const afterFirst = await stateOf(owner.api, session);
  expect(afterFirst.turnNumber).toBe(turnNo + 1);
  const secondEnd = await act(owner.api, session, { type: 'end-turn', turnNumber: turnNo });
  expect(secondEnd.status).toBe(200);
  const afterSecond = await stateOf(owner.api, session);
  expect(afterSecond.turnNumber).toBe(turnNo + 1);
  expect(JSON.stringify(afterSecond.teams)).toBe(JSON.stringify(afterFirst.teams));

});

// ── Vampire Village ──────────────────────────────────────────────────────

test('Vampire Village (5 players): a villager who drops resyncs; no state carries another player’s role; a stale advance is ignored', async () => {
  const dot: Player = await (async () => {
    const person = await guestMember(browser, owner.api, serverId, `Dot ${RUN}`, { permissions: ['microphone'], viewport: { width: 1280, height: 860 } });
    const page = await person.ctx.newPage();
    page.on('dialog', (dialog) => void dialog.accept());
    return { ...person, page };
  })();
  try {
    const everyone = [owner, ann, bea, cid, dot];
    for (const p of everyone) await inVoice(p);
    const session = await start('vampire-village');
    for (const [i, p] of everyone.entries()) {
      const joined = await act(p.api, session, { type: 'join', name: ['Ada', 'Bram', 'Cleo', 'Dara', 'Eli'][i] });
      expect(joined.status, joined.text).toBe(200);
    }
    for (const p of everyone) expect((await act(p.api, session, { type: 'set-ready', ready: true })).status).toBe(200);
    await openHub(dot);
    await expect(dot.page.getByRole('button', { name: 'I’m ready' })).toHaveAttribute('aria-pressed', 'true', SYNC);
    const started = await act(owner.api, session, { type: 'start' });
    expect(started.status, started.text).toBe(200);

    // Each player sees their own role, and only theirs: the full table
    // (`secret`) stays on the server until the game ends; only a vampire
    // learns the pack.
    const views = await Promise.all(everyone.map((p) => stateOf(p.api, session)));
    const roles = views.map((v) => (v.me?.role ?? null) as string | null);
    expect(roles.every((r) => typeof r === 'string'), `every player has a role: ${JSON.stringify(roles)}`).toBe(true);
    expect(roles.filter((r) => r === 'vampire').length).toBeGreaterThanOrEqual(1);
    for (const [i, view] of views.entries()) {
      expect(view.secret, `${everyone[i]!.name} received the full table`).toBeUndefined();
      expect(view.me.id).toBe(everyone[i]!.uid);
      if (roles[i] !== 'vampire') expect(view.me.pack, `${everyone[i]!.name} (a ${roles[i]}) sees the pack`).toBeNull();
      else expect((view.me.pack?.members ?? []).length).toBe(roles.filter((r) => r === 'vampire').length);
    }

    // A villager drops for a moment and comes back to the same phase.
    const villager = everyone.find((_, i) => roles[i] !== 'vampire' && everyone[i] !== owner)!;
    await openHub(villager);
    await expect(villager.page.getByRole('region', { name: 'Your role' })).toBeVisible(SYNC);
    await villager.ctx.setOffline(true);
    const phase = (await stateOf(owner.api, session)).phaseId as number;
    const advanced = await act(owner.api, session, { type: 'advance', phaseId: phase });
    expect(advanced.status, advanced.text).toBe(200);
    const afterAdvance = (await stateOf(owner.api, session)).phaseId as number;
    // A second advance for the phase that just ended (a double tap) is ignored.
    const stale = await act(owner.api, session, { type: 'advance', phaseId: phase });
    expect(stale.status).toBe(200);
    expect((await stateOf(owner.api, session)).phaseId).toBe(afterAdvance);
    await villager.page.waitForTimeout(4_000);
    await villager.ctx.setOffline(false);
    await expect(villager.page.getByRole('region', { name: 'Your role' })).toBeVisible(SYNC);
    await expect.poll(async () => (await stateOf(villager.api, session)).phaseId, SYNC).toBe(afterAdvance);
  } finally {
    await endOpenActivities(owner.api, serverId, voiceId);
    await dot.ctx.close();
  }
});

// ── Watch Party ──────────────────────────────────────────────────────────

test('Watch Party: a viewer who drops comes back to the current queue', async () => {
  for (const p of [owner, ann, bea]) await inVoice(p);
  const session = await start('watch-party');
  for (const p of [owner, ann, bea]) {
    await openHub(p);
    await act(p.api, session, { type: 'join' });
  }
  const first = await act(owner.api, session, { type: 'set-video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  expect(first.status, first.text).toBe(200);
  await ann.ctx.setOffline(true);
  const queued = await act(owner.api, session, { type: 'queue-add', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0' });
  expect(queued.status, queued.text).toBe(200);
  const queueLength = (queued.state!.queue as unknown[]).length;
  await ann.page.waitForTimeout(4_000);
  await ann.ctx.setOffline(false);
  await expect.poll(async () => ((await stateOf(ann.api, session)).queue as unknown[]).length, SYNC).toBe(queueLength);
  // The panel re-read on its own (the online event), not only the API.
  const panelText = ann.page.locator('.lfui');
  await expect(panelText.first()).toBeVisible(SYNC);
});

// ── Rules ────────────────────────────────────────────────────────────────

test('voice_required: outside voice a player is refused and offered [Join]; watching needs no voice; Join lets them play', async ({}, testInfo) => {
  for (const p of [owner, ann]) await inVoice(p);
  const session = await start('quiz');
  // Cid leaves voice and opens the activity from the sidebar: he can watch.
  if ((await footerStatus(cid.page).textContent().catch(() => '')) === 'Voice Connected') {
    await cid.page.getByTitle('Disconnect', { exact: true }).click();
  }
  await cid.page.goto(`/lobby?server=${serverId}`);
  await openHub(cid);
  const bar = cid.page.getByTestId('activity-voice-join');
  await expect(bar).toBeVisible(SYNC);
  await expect(bar).toContainText('Join the voice channel to play');
  await expect(quizPanel(cid)).toBeVisible();
  await shootBothThemes(cid.page, shot(testInfo, 'activity-2-voice-required'));
  const refused = await act(cid.api, session, { type: 'join' });
  expect(refused.status).toBe(403);
  expect(refused.code).toBe('voice_required');
  // Watching needs no voice: the session reads fine.
  expect((await send(() => cid.api.get(`/api/servers/${serverId}/activities/${session}`))).status()).toBe(200);
  // One click on Join, and he plays.
  await bar.getByRole('button', { name: new RegExp(`Join`) }).click();
  await expect(footerStatus(cid.page)).toHaveText('Voice Connected', { timeout: 30_000 });
  await expect(bar).toHaveCount(0);
  expect((await act(cid.api, session, { type: 'join' })).status).toBe(200);
});

test('a timed-out member cannot play (403 timed_out) — and plays again once it is lifted', async () => {
  for (const p of [owner, ann]) await inVoice(p);
  const session = await start('dice-bot');
  await openHub(ann);
  const until = new Date(Date.now() + 10 * 60_000).toISOString();
  expect((await send(() => owner.api.put(`/api/servers/${serverId}/members/${ann.uid}/timeout`, { headers: ORIGIN, data: { until } }))).status()).toBe(200);
  try {
    const refused = await act(ann.api, session, { type: 'roll' });
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('timed_out');
    await rollButton(ann).click();
    await expect(dicePanel(ann).getByText(/timed out/i).or(ann.page.getByText(/You are timed out: you can't play/)).first()).toBeVisible(SYNC);
  } finally {
    await send(() => owner.api.put(`/api/servers/${serverId}/members/${ann.uid}/timeout`, { headers: ORIGIN, data: { until: null } }));
  }
  expect((await act(ann.api, session, { type: 'roll' })).status).toBe(200);
});

test('one activity per channel: two starts at the same moment → one 201, one 409 activity_exists', async () => {
  await endOpenActivities(owner.api, serverId, voiceId);
  const startOne = (pluginId: string) =>
    owner.api.post(`/api/servers/${serverId}/channels/${voiceId}/activities`, { headers: ORIGIN, data: { pluginId } });
  const [a, b] = await Promise.all([startOne('poll'), startOne('dice-bot')]);
  const statuses = [a.status(), b.status()].sort();
  expect(statuses).toEqual([201, 409]);
  const loser = a.status() === 409 ? a : b;
  const body = await json<{ code?: string; activity?: { id: string } }>(loser);
  expect(body.code).toBe('activity_exists');
  expect(body.activity?.id).toBeTruthy();
  await endOpenActivities(owner.api, serverId, voiceId);
});
