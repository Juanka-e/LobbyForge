/**
 * Voice: joining, the controls others see, and dropping out — through the
 * real lobby UI, several people at once (docs/VOICE_ROOM.md,
 * docs/ACTIVITY_INTEGRITY_AND_RESILIENCE.md §3.2, lib/voice-resume.ts).
 *
 *   basics        join / leave; mute, deafen, push-to-talk, camera and
 *                 screen share — and the other client's voice roster
 *                 follows every change
 *   short drop    ~10 s offline: LiveKit resumes by itself; the footer
 *                 says "Reconnecting..." meanwhile (not "Voice Ready"),
 *                 Disconnect still works, nothing to click afterwards
 *   long drop     past LiveKit's ~2 min window, signal AND media gone:
 *                 the other client sees the person leave (roster and
 *                 member list); "You dropped out of voice. [Back to #…]"
 *                 appears (also at 390 px); the online retry and the
 *                 tab-visible retry rejoin on their own; a record older
 *                 than 10 minutes is not retried
 *   reload        microphone allowed → back in voice by itself, mic off,
 *                 the activities view reopened; not allowed → the strip,
 *                 one click rejoins
 *   no resume     after leaving on purpose, switching channel, a
 *                 moderator disconnect, the room being deleted, a voice
 *                 block
 *   duplicated tab only the tab in voice stays in (Web Lock `lf-voice`)
 *
 * About "offline": `context.setOffline(true)` (CDP network emulation)
 * cuts HTTP and WebSockets — LiveKit's signal connection included — but
 * not WebRTC's UDP media, so on its own the SFU still sees the person.
 * The long drop also closes the page's RTCPeerConnections at the same
 * moment, which is what a real network loss does to the media path.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Screenshots, dark
 * and light, go to LF_E2E_SHOT_DIR (or the test output folder).
 */
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { resetRateLimits } from './helpers/auth';
import {
  baseUrl,
  createChannel,
  deleteChannel,
  firstServerId,
  guestMember,
  launchRealUi,
  ORIGIN,
  ownerContext,
  redisCli,
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
// In order, one worker; a failure does not skip the rest (each test puts Ada
// where it needs her first).
test.describe.configure({ mode: 'default' });

const RUN = Date.now().toString(36).slice(-5);
const ROOM_A = `drop-a-${RUN}`;
const ROOM_B = `drop-b-${RUN}`;

declare global {
  interface Window {
    __pcs: RTCPeerConnection[];
  }
}

/** Keep every RTCPeerConnection the app makes, so the long drop can cut the media path too. */
function hookPeerConnections() {
  const Native = window.RTCPeerConnection;
  window.__pcs = [];
  class Tracked extends Native {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      window.__pcs.push(this);
    }
  }
  window.RTCPeerConnection = Tracked as typeof RTCPeerConnection;
}

function shot(testInfo: { outputPath: (name: string) => string }, name: string) {
  return (theme: 'dark' | 'light') => (SHOT_DIR ? join(SHOT_DIR, `${name}-${theme}.png`) : testInfo.outputPath(`${name}-${theme}.png`));
}

function channelButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name }).filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
}

async function join_(page: Page, serverId: string, room: string, { navigate = true } = {}) {
  if (navigate) await page.goto(`/lobby?server=${serverId}`);
  await channelButton(page, room).click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
}

/** The roster row of `name` under the voice channel, in the sidebar. */
function rosterRow(page: Page, name: string): Locator {
  return page.getByTestId('mobile-nav-drawer').locator('li.cursor-pointer').filter({ hasText: name });
}

/** Ada in `room` and connected, whatever the previous test left behind. */
async function ensureInVoice(page: Page, serverId: string, room: string) {
  if (!page.url().includes('/lobby')) await page.goto(`/lobby?server=${serverId}`);
  const status = await footerStatus(page).textContent({ timeout: 10_000 }).catch(() => null);
  if (status === 'Voice Connected') return;
  if (status === null) await page.goto(`/lobby?server=${serverId}`);
  await join_(page, serverId, room, { navigate: false });
}

const strip = (page: Page) => page.getByTestId('voice-resume-strip').first();
const footerStatus = (page: Page) => page.getByText(/^(Voice Connected|Voice Ready|Connecting\.\.\.|Reconnecting\.\.\.)$/).first();

test.describe('voice: connect, controls, and dropping out', () => {
  let browser: Browser;
  let owner: Person;
  let serverId = '';
  let roomA = '';
  let roomB = '';
  let ada: Person; // the one who drops
  let ben: Person; // watches
  let adaPage: Page;
  let benPage: Page;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(180_000);
    resetRateLimits();
    browser = await launchRealUi(playwright, ['--auto-select-desktop-capture-source=Entire screen']);
    owner = await ownerContext(browser);
    serverId = await firstServerId(owner.api);
    roomA = await createChannel(owner.api, serverId, ROOM_A, 'voice');
    roomB = await createChannel(owner.api, serverId, ROOM_B, 'voice');
    const media = { permissions: ['microphone', 'camera'], viewport: { width: 1360, height: 860 }, colorScheme: 'dark' as const };
    ada = await guestMember(browser, owner.api, serverId, `Ada ${RUN}`, media);
    ben = await guestMember(browser, owner.api, serverId, `Ben ${RUN}`, media);
    await ada.ctx.addInitScript(hookPeerConnections);
    await ben.ctx.addInitScript(hookPeerConnections);
    adaPage = await ada.ctx.newPage();
    benPage = await ben.ctx.newPage();
    // Leaving a page while in voice asks first (beforeunload): say yes.
    for (const page of [adaPage, benPage]) page.on('dialog', (dialog) => void dialog.accept());
  });

  test.afterAll(async () => {
    for (const p of [ada, ben]) await p?.ctx.close().catch(() => undefined);
    if (owner && serverId) {
      for (const id of [roomA, roomB]) if (id) await deleteChannel(owner.api, serverId, id);
      // The voice-block check below leaves no block behind even when it fails half-way.
      if (ada?.uid) redisCli(['DEL', `lf:production:voice-block:${serverId}:${ada.uid}`]);
    }
    await owner?.ctx.close().catch(() => undefined);
    await browser?.close();
  });

  test('basics: join, mute, deafen, camera, screen share, push-to-talk, leave — the other roster follows', async ({}, testInfo) => {
    test.setTimeout(240_000);
    await join_(adaPage, serverId, ROOM_A);
    await join_(benPage, serverId, ROOM_A);
    const adaOnBen = rosterRow(benPage, ada.name);
    const benOnAda = rosterRow(adaPage, ben.name);
    await expect(adaOnBen).toHaveCount(1, { timeout: 15_000 });
    await expect(benOnAda).toHaveCount(1, { timeout: 15_000 });
    // Joined with the microphone on (voice activity is the default mode).
    await expect(adaPage.getByTitle('Mute', { exact: true })).toBeVisible();
    await expect(adaOnBen.getByText('mic_off')).toHaveCount(0);

    // ── Mute / unmute.
    await adaPage.getByTitle('Mute', { exact: true }).click();
    await expect(adaPage.getByTitle('Unmute', { exact: true })).toBeVisible();
    await expect(adaOnBen.getByText('mic_off')).toHaveCount(1, { timeout: 10_000 });
    await adaPage.getByTitle('Unmute', { exact: true }).click();
    await expect(adaOnBen.getByText('mic_off')).toHaveCount(0, { timeout: 10_000 });

    // ── Deafen: also closes the microphone (others see that); undeafen restores it.
    await adaPage.getByTitle('Deafen', { exact: true }).click();
    await expect(adaPage.getByTitle('Undeafen', { exact: true })).toBeVisible();
    await expect(adaPage.getByTitle('Unmute', { exact: true })).toBeVisible();
    await expect(adaOnBen.getByText('mic_off')).toHaveCount(1, { timeout: 10_000 });
    await adaPage.getByTitle('Undeafen', { exact: true }).click();
    await expect(adaPage.getByTitle('Mute', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(adaOnBen.getByText('mic_off')).toHaveCount(0, { timeout: 10_000 });

    // ── Camera.
    // Turning the camera or a screen share on opens the voice view over the
    // lobby; "Back to chat" returns to the sidebar and its footer.
    const backToChat = async () => {
      const back = adaPage.getByTestId('voice-focus-view').getByRole('button', { name: 'Back to chat' });
      await expect(back).toBeVisible({ timeout: 15_000 });
      await back.click();
      await expect(adaPage.getByTestId('voice-focus-view')).toHaveCount(0);
    };
    await adaPage.getByTitle('Turn on camera', { exact: true }).click();
    await backToChat();
    await expect(adaPage.getByTitle('Turn off camera', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(adaOnBen.getByLabel('Camera on')).toHaveCount(1, { timeout: 15_000 });

    // ── Screen share (with system audio when the browser offers it).
    await adaPage.getByTitle('Share your screen', { exact: true }).click();
    await backToChat();
    await expect(adaPage.getByTitle('Stop screen share', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(adaOnBen.getByLabel('Sharing screen')).toHaveCount(1, { timeout: 15_000 });
    const outboundAudio = await adaPage.evaluate(() =>
      window.__pcs.flatMap((pc) => (pc.connectionState === 'closed' ? [] : pc.getSenders())).filter((s) => s.track?.kind === 'audio' && s.track.readyState === 'live').length
    );
    note(testInfo, { type: 'screen share audio', description: `${outboundAudio} live outbound audio sender(s) while sharing (mic + screen audio = 2)` });
    await shootBothThemes(benPage, shot(testInfo, 'voice-1-roster-camera-screen'));
    await adaPage.getByTitle('Stop screen share', { exact: true }).click();
    await expect(adaOnBen.getByLabel('Sharing screen')).toHaveCount(0, { timeout: 15_000 });
    await adaPage.getByTitle('Turn off camera', { exact: true }).click();
    await expect(adaOnBen.getByLabel('Camera on')).toHaveCount(0, { timeout: 15_000 });

    // ── Push-to-talk, required by the community: the mic is closed until the key is held.
    const ptt = (requirePushToTalk: boolean) =>
      send(() => owner.api.patch(`/api/servers/${serverId}/voice-settings`, { headers: ORIGIN, data: { requirePushToTalk } }));
    expect((await ptt(true)).status()).toBe(200);
    try {
      await adaPage.getByTitle('Disconnect', { exact: true }).click();
      await join_(adaPage, serverId, ROOM_A, { navigate: false });
      await expect(adaPage.getByTitle('Unmute', { exact: true })).toBeVisible();
      await expect(rosterRow(benPage, ada.name).getByText('mic_off')).toHaveCount(1, { timeout: 15_000 });
      await adaPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await adaPage.keyboard.down('Space');
      await expect(rosterRow(benPage, ada.name).getByText('mic_off')).toHaveCount(0, { timeout: 10_000 });
      await adaPage.keyboard.up('Space');
      await expect(rosterRow(benPage, ada.name).getByText('mic_off')).toHaveCount(1, { timeout: 10_000 });
    } finally {
      expect((await ptt(false)).status()).toBe(200);
    }

    // ── Leave: gone from the other roster.
    await adaPage.getByTitle('Disconnect', { exact: true }).click();
    await expect(footerStatus(adaPage)).toHaveText('Voice Ready');
    await expect(rosterRow(benPage, ada.name)).toHaveCount(0, { timeout: 15_000 });
    await expect(strip(adaPage)).toHaveCount(0);
  });

  test('short drop (~10 s offline): LiveKit resumes by itself, nothing to click, the controls work again', async ({}, testInfo) => {
    test.setTimeout(120_000);
    await ensureInVoice(adaPage, serverId, ROOM_A);
    await ensureInVoice(benPage, serverId, ROOM_A);
    await expect(rosterRow(benPage, ada.name)).toHaveCount(1, { timeout: 15_000 });

    // What the footer says through the blink (sampled every 500 ms).
    const seen = new Set<string>();
    const sample = async (ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        seen.add((await footerStatus(adaPage).textContent().catch(() => '')) ?? '');
        await adaPage.waitForTimeout(500);
      }
    };
    await ada.ctx.setOffline(true);
    await sample(10_000);
    await ada.ctx.setOffline(false);
    await sample(5_000);
    note(testInfo, { type: 'footer during a 10 s blink', description: [...seen].join(' → ') });
    // Never shown as out of voice while LiveKit still holds the room.
    expect([...seen]).not.toContain('Voice Ready');

    await expect(footerStatus(adaPage)).toHaveText('Voice Connected', { timeout: 30_000 });
    await expect(strip(adaPage)).toHaveCount(0);
    // Still the same person in the same room for the others; the controls work again.
    await expect(rosterRow(benPage, ada.name)).toHaveCount(1);
    await expect(rosterRow(adaPage, ben.name)).toHaveCount(1);
    await adaPage.getByTitle('Mute', { exact: true }).click();
    await expect(rosterRow(benPage, ada.name).getByText('mic_off')).toHaveCount(1, { timeout: 10_000 });
    await adaPage.getByTitle('Unmute', { exact: true }).click();
    await expect(rosterRow(benPage, ada.name).getByText('mic_off')).toHaveCount(0, { timeout: 10_000 });
  });

  test('long drop (> 2 min, signal and media): the others see it, the strip appears, the online and tab-visible retries rejoin', async ({}, testInfo) => {
    test.setTimeout(420_000);
    await ensureInVoice(adaPage, serverId, ROOM_A);
    await ensureInVoice(benPage, serverId, ROOM_A);
    // Phone width for this one: the strip must be reachable without the drawer.
    await adaPage.setViewportSize({ width: 390, height: 844 });

    // The online retry's token request fails once (a server hiccup): the
    // tab-visible retry is the one that gets back.
    let tokenRequests = 0;
    await adaPage.route('**/api/livekit/token', async (route) => {
      tokenRequests += 1;
      if (tokenRequests === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"try again","retryable":true}' });
      else await route.continue();
    });

    const droppedAt = Date.now();
    await ada.ctx.setOffline(true);
    // LiveKit notices the dead signal connection and resumes it: the person
    // is still in the room, so the footer says "Reconnecting...", never
    // "Voice Ready", and leaving stays possible.
    await expect(footerStatus(adaPage)).toHaveText('Reconnecting...', { timeout: 45_000 });
    await expect(adaPage.getByTitle('Disconnect', { exact: true })).toBeEnabled();
    note(testInfo, { type: 'reconnecting shown after', description: `${Math.round((Date.now() - droppedAt) / 1000)} s` });
    await adaPage.setViewportSize({ width: 1360, height: 860 });
    await shootBothThemes(adaPage, shot(testInfo, 'voice-2-reconnecting'));
    await adaPage.setViewportSize({ width: 390, height: 844 });
    // A real network loss takes the media path with it.
    await adaPage.evaluate(() => window.__pcs.forEach((pc) => pc.close()));

    // ── The others: Ada leaves the voice roster once the SFU notices.
    await expect(rosterRow(benPage, ada.name)).toHaveCount(0, { timeout: 90_000 });
    note(testInfo, { type: 'roster drop seen after', description: `${Math.round((Date.now() - droppedAt) / 1000)} s` });
    // … and, once her presence runs out, the member list shows her offline.
    const adaMember = benPage.getByRole('button', { name: new RegExp(`Offline.*${ada.name}`) });
    await expect(adaMember).toBeVisible({ timeout: 180_000 });
    note(testInfo, { type: 'member list offline after', description: `${Math.round((Date.now() - droppedAt) / 1000)} s` });

    // ── Ada: LiveKit gives up after ~2 minutes; the way back is offered.
    await expect(strip(adaPage)).toBeVisible({ timeout: 200_000 });
    note(testInfo, { type: 'strip shown after', description: `${Math.round((Date.now() - droppedAt) / 1000)} s` });
    await expect(strip(adaPage)).toContainText('You dropped out of voice.');
    await expect(strip(adaPage).getByRole('button', { name: `Back to #${ROOM_A}` })).toBeVisible();
    await expect(strip(adaPage)).toBeInViewport();
    await shootBothThemes(adaPage, shot(testInfo, 'voice-3-dropped-strip-390px'));

    // ── Back online: the online retry fires (and hits the 503) …
    await ada.ctx.setOffline(false);
    await expect.poll(() => tokenRequests, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await expect(strip(adaPage)).toBeVisible();
    expect(tokenRequests).toBe(1);
    // … and coming back to the tab tries once more, which works.
    await adaPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(footerStatus(adaPage)).toHaveText('Voice Connected', { timeout: 30_000 });
    await expect(strip(adaPage)).toHaveCount(0);
    await adaPage.unroute('**/api/livekit/token');
    await adaPage.setViewportSize({ width: 1360, height: 860 });
    // An automatic return never opens the microphone.
    await expect(adaPage.getByTitle('Unmute', { exact: true })).toBeVisible();
    await expect(rosterRow(benPage, ada.name)).toHaveCount(1, { timeout: 20_000 });
  });

  test('a drop noticed more than 10 minutes later is not retried on its own; the strip still is one click', async () => {
    test.setTimeout(240_000);
    await ensureInVoice(adaPage, serverId, ROOM_A);
    await ada.ctx.setOffline(true);
    await adaPage.evaluate(() => window.__pcs.forEach((pc) => pc.close()));
    await expect(strip(adaPage)).toBeVisible({ timeout: 200_000 });
    // Pretend the tab was last in voice 11 minutes ago.
    await adaPage.evaluate(() => {
      const raw = sessionStorage.getItem('lf.voice.resume.v1');
      if (!raw) throw new Error('no resume record');
      const record = JSON.parse(raw);
      sessionStorage.setItem('lf.voice.resume.v1', JSON.stringify({ ...record, at: Date.now() - 11 * 60_000 }));
    });
    await ada.ctx.setOffline(false);
    await adaPage.waitForTimeout(6_000);
    await expect(footerStatus(adaPage)).toHaveText('Voice Ready');
    await expect(strip(adaPage)).toBeVisible();
    await strip(adaPage).getByRole('button', { name: `Back to #${ROOM_A}` }).click();
    await expect(footerStatus(adaPage)).toHaveText('Voice Connected', { timeout: 30_000 });
    await expect(strip(adaPage)).toHaveCount(0);
  });

  test('reload with the microphone allowed: back in voice by itself, mic off, activities view reopened', async ({}, testInfo) => {
    test.setTimeout(120_000);
    await ensureInVoice(adaPage, serverId, ROOM_A);
    await ensureInVoice(benPage, serverId, ROOM_A);
    await adaPage.getByTitle('Start a game or activity in this voice room').click();
    await expect(adaPage.getByRole('button', { name: 'Close activities', exact: true })).toBeVisible();
    await adaPage.reload();
    await expect(footerStatus(adaPage)).toHaveText('Voice Connected', { timeout: 30_000 });
    await expect(adaPage.getByTitle('Unmute', { exact: true })).toBeVisible();
    await expect(adaPage.getByRole('button', { name: 'Close activities', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(strip(adaPage)).toHaveCount(0);
    await expect(rosterRow(benPage, ada.name)).toHaveCount(1, { timeout: 20_000 });
    await shootBothThemes(adaPage, shot(testInfo, 'voice-4-reload-auto-rejoined'));
    await adaPage.getByRole('button', { name: 'Close activities', exact: true }).click();
  });

  test('reload without the microphone permission: the strip, and one click rejoins', async ({}, testInfo) => {
    test.setTimeout(120_000);
    // A person who never ticked "allow": the browser would ask again, so no automatic return.
    const cleo = await guestMember(browser, owner.api, serverId, `Cleo ${RUN}`, { viewport: { width: 1360, height: 860 }, colorScheme: 'dark' });
    try {
      const page = await cleo.ctx.newPage();
      page.on('dialog', (dialog) => void dialog.accept());
      await join_(page, serverId, ROOM_A);
      await page.reload();
      await expect(strip(page)).toBeVisible({ timeout: 20_000 });
      await expect(footerStatus(page)).toHaveText('Voice Ready');
      await shootBothThemes(page, shot(testInfo, 'voice-5-reload-no-permission-strip'));
      await strip(page).getByRole('button', { name: `Back to #${ROOM_A}` }).click();
      await expect(footerStatus(page)).toHaveText('Voice Connected', { timeout: 30_000 });
      await expect(strip(page)).toHaveCount(0);
      await expect(rosterRow(benPage, cleo.name)).toHaveCount(1, { timeout: 20_000 });
    } finally {
      await cleo.ctx.close();
    }
  });

  test('no way back after leaving on purpose', async () => {
    await ensureInVoice(adaPage, serverId, ROOM_A);
    await adaPage.getByTitle('Disconnect', { exact: true }).click();
    await expect(footerStatus(adaPage)).toHaveText('Voice Ready');
    await adaPage.reload();
    await adaPage.waitForTimeout(4_000);
    await expect(footerStatus(adaPage)).toHaveText('Voice Ready');
    await expect(strip(adaPage)).toHaveCount(0);
  });

  test('switching channel: a reload goes back to the new channel, never the old one', async () => {
    await ensureInVoice(adaPage, serverId, ROOM_A);
    await ensureInVoice(benPage, serverId, ROOM_A);
    await channelButton(adaPage, ROOM_B).click();
    // Settled in ROOM_B: out of Ben's room, and the tab remembers the new channel.
    await expect(rosterRow(benPage, ada.name)).toHaveCount(0, { timeout: 20_000 });
    await expect(footerStatus(adaPage)).toHaveText('Voice Connected', { timeout: 30_000 });
    await expect
      .poll(() => adaPage.evaluate(() => JSON.parse(sessionStorage.getItem('lf.voice.resume.v1') ?? 'null')?.channelId ?? null), { timeout: 15_000 })
      .toBe(roomB);
    await adaPage.reload();
    await expect(footerStatus(adaPage)).toHaveText('Voice Connected', { timeout: 30_000 });
    // In ROOM_B (its roster lists Ada, and Ben in ROOM_A no longer does).
    await expect(rosterRow(benPage, ada.name)).toHaveCount(0, { timeout: 20_000 });
    const record = await adaPage.evaluate(() => JSON.parse(sessionStorage.getItem('lf.voice.resume.v1') ?? 'null'));
    expect(record?.channelId).toBe(roomB);
    await adaPage.getByTitle('Disconnect', { exact: true }).click();
  });

  test('no way back after a moderator disconnect', async () => {
    await ensureInVoice(adaPage, serverId, ROOM_A);
    await ensureInVoice(benPage, serverId, ROOM_A);
    await expect(rosterRow(benPage, ada.name)).toHaveCount(1, { timeout: 15_000 });
    const kick = await send(() =>
      owner.api.post(`/api/servers/${serverId}/channels/${roomA}/members/${ada.uid}/voice/disconnect`, { headers: ORIGIN, data: {} })
    );
    expect(kick.status(), await kick.text()).toBe(200);
    await expect(adaPage.getByRole('alert').filter({ hasText: 'You were removed from the voice channel.' })).toBeVisible({ timeout: 15_000 });
    await expect(strip(adaPage)).toHaveCount(0);
    await adaPage.reload();
    await adaPage.waitForTimeout(4_000);
    await expect(footerStatus(adaPage)).toHaveText('Voice Ready');
    await expect(strip(adaPage)).toHaveCount(0);
  });

  test('no way back after a voice block', async () => {
    await ensureInVoice(adaPage, serverId, ROOM_A);
    // What the LiveKit webhook does to someone who published a forbidden
    // track (lib/voice-block.ts) — set directly here.
    expect(redisCli(['SET', `lf:production:voice-block:${serverId}:${ada.uid}`, '1', 'EX', '600'])).not.toBeNull();
    try {
      // The reload's automatic return is refused (403 voice_blocked): the
      // record goes, and the reason is shown instead of a way back.
      await adaPage.reload();
      await expect(adaPage.getByRole('alert').filter({ hasText: /removed from the voice channel for sending a track/ })).toBeVisible({ timeout: 20_000 });
      await expect(strip(adaPage)).toHaveCount(0);
      await adaPage.reload();
      await adaPage.waitForTimeout(4_000);
      await expect(footerStatus(adaPage)).toHaveText('Voice Ready');
      await expect(strip(adaPage)).toHaveCount(0);
    } finally {
      redisCli(['DEL', `lf:production:voice-block:${serverId}:${ada.uid}`]);
    }
  });

  test('no way back after the room is deleted — and deleting it ends the call', async () => {
    const doomedName = `drop-gone-${RUN}`;
    const doomed = await createChannel(owner.api, serverId, doomedName, 'voice');
    try {
      await adaPage.goto(`/lobby?server=${serverId}`);
      await join_(adaPage, serverId, doomedName, { navigate: false });
      await join_(benPage, serverId, doomedName);
      await expect(rosterRow(benPage, ada.name)).toHaveCount(1, { timeout: 15_000 });
      await deleteChannel(owner.api, serverId, doomed);
      // Nobody stays in a voice room whose channel is gone.
      for (const page of [adaPage, benPage]) {
        await expect(page.getByRole('alert').filter({ hasText: 'The voice channel was closed.' })).toBeVisible({ timeout: 20_000 });
        await expect(footerStatus(page)).toHaveText('Voice Ready');
        await expect(strip(page)).toHaveCount(0);
      }
      await adaPage.reload();
      await adaPage.waitForTimeout(4_000);
      await expect(footerStatus(adaPage)).toHaveText('Voice Ready');
      await expect(strip(adaPage)).toHaveCount(0);
    } finally {
      await deleteChannel(owner.api, serverId, doomed);
    }
  });

  test('a duplicated tab never joins the room the first tab is in (Web Lock lf-voice)', async () => {
    await ensureInVoice(adaPage, serverId, ROOM_A);
    const record = await adaPage.evaluate(() => sessionStorage.getItem('lf.voice.resume.v1'));
    expect(record).toBeTruthy();
    // A duplicated tab starts with a copy of the first tab's sessionStorage,
    // and its first load counts as a reload here (the strongest case: the
    // microphone is allowed, so it would go back on its own).
    const twin = await ada.ctx.newPage();
    twin.on('dialog', (dialog) => void dialog.accept());
    await twin.addInitScript((value) => {
      if (!sessionStorage.getItem('lf.twin.seeded')) {
        sessionStorage.setItem('lf.voice.resume.v1', value);
        sessionStorage.setItem('lf.twin.seeded', '1');
      }
    }, record!);
    await twin.goto(`/lobby?server=${serverId}`);
    await twin.reload();
    await twin.waitForTimeout(6_000);
    await expect(footerStatus(twin)).toHaveText('Voice Ready');
    await expect(strip(twin)).toHaveCount(0);
    expect(await twin.evaluate(() => sessionStorage.getItem('lf.voice.resume.v1'))).toBeNull();
    // The first tab was never kicked out ("joined from another tab").
    await expect(footerStatus(adaPage)).toHaveText('Voice Connected');
    await expect(adaPage.getByRole('alert').filter({ hasText: 'from another tab' })).toHaveCount(0);
    await twin.close();
    await adaPage.getByTitle('Disconnect', { exact: true }).click();
  });
});
