/**
 * Watch Party, run by two people through the REAL lobby UI.
 *
 * The owner and an invited guest, each in their own browser context, join
 * the voice channel. The owner starts Watch Party from the activities hub
 * and hosts it:
 *
 *   - a link that is not a YouTube video is refused with a reason;
 *   - a real link loads YouTube's privacy-enhanced player for both, paused,
 *     and the app's CSP lets it frame (no "Refused to frame" anywhere);
 *   - the guest sees no host controls, just who controls playback, and
 *     queues a second video; the server refuses a non-host "play now";
 *   - the host plays: both see the room playing and the guest's timeline
 *     move; the host lets everyone control and the guest pauses for all;
 *   - the host hands the party to the guest, who moves on to the queued
 *     video; when the guest closes the party the host role comes back;
 *   - the owner ends it, freeing the channel.
 *
 * Every assertion is about the party's own UI and state, never about
 * YouTube actually playing — the stack may have no internet. When YouTube
 * does load, the viewers' sync states are logged for the record.
 *
 * Rate limits: the actions route allows 30 actions a minute PER CLIENT IP,
 * and without LOBBYFORGE_TRUSTED_PROXY every client shares one bucket.
 * This spec sends about a dozen; run it apart from the other activity
 * specs (or clear `*rate-limit*` in Redis between them).
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Re-runs on a warm
 * stack: the app is upserted and a leftover activity is ended first.
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

/** Long-lived, embeddable videos (YouTube's own API sample; Blender's Big Buck Bunny). */
const VIDEO_A = 'M7lc1UVf-VE';
const VIDEO_B = 'aqz-KE-bpKQ';
const EMBED = 'https://www.youtube-nocookie.com/embed/';

/**
 * Waits until the frame's `src` starts with the embed URL of `videoId`
 * (plus `?` and `rest`) — a plain prefix check, so the URL is never read as
 * a pattern whose dots match any character.
 */
async function expectEmbed(frame: Locator, videoId: string, rest = ''): Promise<void> {
  const prefix = `${EMBED}${videoId}?${rest}`;
  await expect
    .poll(async () => ((await frame.getAttribute('src')) ?? '').startsWith(prefix), { timeout: 15_000 })
    .toBe(true);
}

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

/** Browsers log a CSP refusal to the console; collect any about frames. */
function watchForFrameRefusals(page: Page, sink: string[]) {
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy/i.test(text) && /frame/i.test(text)) sink.push(text);
  });
}

/** "Click to join playback" appears only when the page has had no click yet; clear it if it is there. */
async function joinPlaybackIfAsked(panel: Locator) {
  const join = panel.getByRole('button', { name: 'Join playback', exact: true });
  if (await join.isVisible()) await join.click();
}

test.describe('Watch Party with two people, through the lobby', () => {
  let ownBrowser: Browser;
  let ownerCtx: BrowserContext;
  let guestCtx: BrowserContext;
  let owner: Page;
  let guest: Page;
  let serverId = '';
  let voiceChannelId = '';
  let ownerName = '';
  let guestName = '';
  const frameRefusals: string[] = [];

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    // Own browser WITHOUT the config's --disable-web-security: that flag makes
    // Chromium drop the Origin header (the CSRF guard rejects every action) —
    // and it would hide exactly the CSP behaviour this spec checks.
    ownBrowser = await playwright.chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    ownerCtx = await newUserContext(ownBrowser);
    guestCtx = await newUserContext(ownBrowser);

    // Owner session: fresh stack → first-run setup; warm stack → login.
    const setup = await ownerCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Watch Party E2E',
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
      data: { pluginId: 'watch-party', enabled: true },
    });
    expect(install.status(), 'install watch-party').toBe(200);
    await endOpenActivities(ownerCtx.request, serverId, voiceChannelId);

    // Guest: a guest identity that redeems the owner's invite.
    const guestAuth = await createGuest(guestCtx.request, {
      headers: ORIGIN,
      data: { displayNameSeed: 'Watcher' },
    });
    expect(guestAuth.status()).toBe(200);
    const inviteRes = await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    // The redeem route allows NO body — omit data.
    expect((await guestCtx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);

    // Display names: the party shows people by name once they have acted.
    const nameOf = async (ctx: BrowserContext) =>
      ((await (await ctx.request.get('/api/auth/guest')).json()) as { guest: { name: string } }).guest.name;
    ownerName = await nameOf(ownerCtx);
    guestName = await nameOf(guestCtx);
    expect(ownerName.trim()).not.toBe('');
    expect(guestName.trim()).not.toBe('');

    owner = await ownerCtx.newPage();
    guest = await guestCtx.newPage();
    watchForFrameRefusals(owner, frameRefusals);
    watchForFrameRefusals(guest, frameRefusals);
  });

  test.afterAll(async () => {
    if (ownerCtx && serverId && voiceChannelId) {
      await endOpenActivities(ownerCtx.request, serverId, voiceChannelId).catch(() => undefined);
    }
    await ownerCtx?.close();
    await guestCtx?.close();
    await ownBrowser?.close();
  });

  test('the app’s pages allow framing exactly one third-party origin: YouTube’s privacy-enhanced player', async () => {
    const lobby = await ownerCtx.request.get('/lobby');
    const csp = lobby.headers()['content-security-policy'] ?? '';
    const directives = csp.split(';').map((d) => d.trim());
    // 'self' is the sandboxed marketplace plugin UI (ADR-007).
    expect(directives).toContain("frame-src 'self' https://www.youtube-nocookie.com");
    expect(directives).toContain("frame-ancestors 'none'");
  });

  test('host a party: load, play and pause together, hand over the host, move through the queue, end', async () => {
    test.setTimeout(240_000);
    await joinVoice(owner, serverId);
    await joinVoice(guest, serverId);

    // ── The owner starts Watch Party: nothing on screen yet, and they host it.
    await openActivities(owner);
    await appCard(owner, 'Watch Party').click();
    const hostPanel = owner.getByRole('region', { name: 'Watch Party', exact: true });
    await expect(hostPanel.getByText('Nothing playing yet', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(hostPanel.getByText("You're hosting")).toBeVisible();
    await expect(hostPanel.getByText(/You're responsible for what you play/)).toBeVisible();

    // A link that is not a YouTube video is refused before anything is sent.
    const hostLink = hostPanel.getByRole('textbox', { name: 'Add a YouTube link', exact: true });
    await hostLink.fill('https://vimeo.com/76979871');
    await hostPanel.getByRole('button', { name: 'Load video', exact: true }).click();
    await expect(hostPanel.getByRole('alert')).toContainText("That isn't a YouTube video link");

    // A real link (with a start time) loads the privacy-enhanced player, paused.
    await hostLink.fill(`https://youtu.be/${VIDEO_A}?t=5`);
    await hostPanel.getByRole('button', { name: 'Load video', exact: true }).click();
    const hostFrame = hostPanel.locator('iframe');
    await expectEmbed(hostFrame, VIDEO_A, 'enablejsapi=1&origin=');
    await expect(hostFrame).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(hostFrame).not.toHaveAttribute('sandbox', /allow-top-navigation/);
    await expect(hostPanel.getByText('Paused', { exact: true })).toBeVisible();
    await joinPlaybackIfAsked(hostPanel);

    // ── The guest opens the running party: same video, no host controls.
    await openActivities(guest);
    const guestPanel = guest.getByRole('region', { name: 'Watch Party', exact: true });
    await expectEmbed(guestPanel.locator('iframe'), VIDEO_A);
    await joinPlaybackIfAsked(guestPanel);
    await expect(guestPanel.getByRole('button', { name: 'Play for everyone' })).toHaveCount(0);
    await expect(guestPanel.getByText(`${ownerName} is hosting, so only they can play, pause and seek.`)).toBeVisible();
    await expect(guestPanel.getByText(`Hosted by ${ownerName}`)).toBeVisible();
    await expect(guestPanel.getByRole('progressbar', { name: 'Playback position' })).toHaveAttribute(
      'aria-valuetext',
      /^0:05 of /
    );
    // Both are on the watching list — by name, once the guest has joined.
    for (const panel of [hostPanel, guestPanel]) {
      await expect(panel.getByText('2 people watching')).toBeVisible({ timeout: 15_000 });
    }
    await expect(hostPanel.getByRole('listitem').filter({ hasText: guestName })).toBeVisible({ timeout: 15_000 });
    await expect(guestPanel.getByRole('listitem').filter({ hasText: `${guestName} (you)` })).toBeVisible({
      timeout: 15_000,
    });

    // ── The guest queues a video; both see it under "Up next".
    await guestPanel.getByRole('textbox', { name: 'Add a YouTube link', exact: true }).fill(
      `https://www.youtube.com/watch?v=${VIDEO_B}`
    );
    await guestPanel.getByRole('button', { name: 'Add to queue', exact: true }).click();
    for (const panel of [hostPanel, guestPanel]) {
      const upNext = panel.getByRole('list', { name: 'Up next' }).getByRole('listitem');
      await expect(upNext).toHaveCount(1, { timeout: 15_000 });
      await expect(upNext).toContainText(`youtu.be/${VIDEO_B}`);
    }
    await expect(guestPanel.getByRole('list', { name: 'Up next' })).toContainText('added by you');
    await expect(hostPanel.getByRole('list', { name: 'Up next' })).toContainText(`added by ${guestName}`);

    // The server decides, not the page: a guest's "play now" changes nothing…
    const [session] = await openActivitiesIn(ownerCtx.request, serverId, voiceChannelId);
    expect(session?.pluginId).toBe('watch-party');
    const act = (body: Record<string, unknown>) =>
      guestCtx.request.post(`/api/servers/${serverId}/activities/${session!.id}/actions`, { headers: ORIGIN, data: body });
    const sneaky = await act({ type: 'set-video', url: `https://youtu.be/${VIDEO_B}` });
    expect(sneaky.status()).toBe(200);
    const sneakyState = ((await sneaky.json()) as { activity: { state: { current: { videoId: string } } } }).activity.state;
    expect(sneakyState.current.videoId).toBe(VIDEO_A);
    // …and a link that is not a YouTube video never reaches the reducer.
    const bogus = await act({ type: 'queue-add', url: 'https://evil.example/watch?v=M7lc1UVf-VE' });
    expect(bogus.status()).toBe(400);

    // ── The host plays for everyone: both see the room playing, and the
    // guest's timeline moves on from the server's clock.
    await hostPanel.getByRole('button', { name: 'Play for everyone', exact: true }).click();
    for (const panel of [hostPanel, guestPanel]) {
      await expect(panel.getByText(/^(Playing|All in sync|\d+ (is|are) buffering)$/)).toBeVisible({ timeout: 15_000 });
    }
    await expect(hostPanel.getByRole('button', { name: 'Pause for everyone', exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await guestPanel.getByRole('progressbar', { name: 'Playback position' }).getAttribute('aria-valuetext')) ?? '',
        { timeout: 15_000 }
      )
      .toMatch(/^0:(0[7-9]|[1-5]\d) of /);

    // ── The host lets everyone control; the guest pauses for all.
    await hostPanel
      .getByRole('group', { name: 'Who controls playback' })
      .getByRole('button', { name: 'Everyone', exact: true })
      .click();
    const guestPause = guestPanel.getByRole('button', { name: 'Pause for everyone', exact: true });
    await expect(guestPause).toBeVisible({ timeout: 15_000 });
    await guestPause.click();
    for (const panel of [hostPanel, guestPanel]) {
      await expect(panel.getByText('Paused', { exact: true })).toBeVisible({ timeout: 15_000 });
    }

    // For the record: what each viewer's own player reported (only if YouTube loaded).
    const statuses = await hostPanel.getByRole('listitem').allInnerTexts();
    console.info('[watch-party] watching list as the host sees it:', statuses);

    // ── The host hands the party over; the guest now runs it.
    await hostPanel.getByRole('button', { name: `Make ${guestName} the host`, exact: true }).click();
    await expect(guestPanel.getByText("You're hosting")).toBeVisible({ timeout: 15_000 });
    await expect(hostPanel.getByText(`Hosted by ${guestName}`)).toBeVisible({ timeout: 15_000 });
    // The owner started the session, so they can always take the controls back.
    await expect(hostPanel.getByRole('button', { name: 'Take the controls back', exact: true })).toBeVisible();

    // The new host moves on to the queued video, for everyone.
    await guestPanel.getByRole('button', { name: 'Play next', exact: true }).click();
    for (const panel of [hostPanel, guestPanel]) {
      await expectEmbed(panel.locator('iframe'), VIDEO_B);
      await expect(panel.getByText('Nothing queued yet.')).toBeVisible();
    }

    // ── The guest (host) closes the party: the host role comes back to the owner.
    await guest.getByRole('button', { name: 'Close activities', exact: true }).click();
    await expect(hostPanel.getByText("You're hosting")).toBeVisible({ timeout: 15_000 });
    await expect(hostPanel.getByText('1 person watching')).toBeVisible({ timeout: 15_000 });

    // The player was framed, not refused, on both screens.
    expect(frameRefusals).toEqual([]);

    // ── Done: the owner ends it, which frees the channel.
    await owner.getByTitle('End this activity for everyone').click();
    await expect(appCard(owner, 'Watch Party')).toBeVisible({ timeout: 15_000 });
  });
});
