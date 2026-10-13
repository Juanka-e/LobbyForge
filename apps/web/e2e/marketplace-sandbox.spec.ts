/**
 * A sandboxed marketplace plugin, end to end on the real stack (ADR-007,
 * docs/PLUGIN_SDK.md "Marketplace plugin UI"): `examples/plugins/
 * sandbox-buzzer` runs in the QuickJS plugin worker, and its UI in an
 * `<iframe sandbox="allow-scripts">` served from /api/plugin-ui/….
 *
 *   - The owner enables the Buzzer ("Sandbox Buzzer") for the server and
 *     starts it in a voice room; two members open the same activity.
 *   - Inside the iframe: the host opens a round, member A buzzes, then B.
 *     Before the reveal nobody — B, nor the host, nor the state the API
 *     hands out — can see who buzzed first (the worker's projection). After
 *     the reveal everyone sees A first.
 *   - Isolation, checked from the parent page: the frame's origin is the
 *     opaque "null", it cannot read the parent's cookie or DOM, a fetch to
 *     /api from inside the frame is blocked while one to the plugin's own
 *     folder works (CSP connect-src = this version's folder, plus
 *     `webrtc 'block'` — security review PLUG-004, 2026-10-13: the policy
 *     is no longer `connect-src 'none'`), and navigating the frame away
 *     stops it — the lobby shows the error state.
 *   - Host effects (0.2.0 asks for `timers` + `storage`, approved in
 *     active.json by the install script): an open round nobody reveals
 *     reveals itself after 30 s, and the fastest reactions are kept in the
 *     community's storage — a new session starts with them.
 *   (Escape attempts from inside the QuickJS sandbox are unit-tested in
 *   apps/plugin-worker.)
 *
 * A second isolation test frames the real bundle from a stand-in parent page,
 * so the frame's own headers and sandbox are checked without the lobby.
 *
 * Needs the e2e stack started WITH infra/docker/docker-compose.e2e-plugins.yml
 * (plugin worker + LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED) and the bundle
 * installed by infra/docker/e2e-install-sandbox-plugin.sh; skips with that
 * reason otherwise. Screenshots go to the test's output directory.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Frame,
  type FrameLocator,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);
const PLUGIN_ID = 'sandbox-buzzer';
const PLUGIN_VERSION = '0.2.0';
/**
 * The name the lobby shows: 0.2.0 ships locales/<code>.json and names itself
 * in the viewer's language ("catalog.name": "Buzzer" in en.json); the
 * manifest's "Sandbox Buzzer" is only the fallback.
 */
const APP_NAME = 'Buzzer';
/** How a browser fetches a frame document (the asset route checks Fetch Metadata). */
const FRAME_FETCH = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' };
const FRAME_TITLE = `${APP_NAME} — app screen`;
/** The frame's connect-src / media-src: this version's own folder (lib/plugin-ui-assets.ts pluginUiAssetSource). */
const OWN_FOLDER = baseUrl ? `${new URL(baseUrl).origin}/api/plugin-ui/${PLUGIN_ID}/${PLUGIN_VERSION}/` : '';

/** The frame document's policy since PLUG-004: its own folder for fetch and media, WebRTC refused, scripts-only sandbox. */
function expectFramePolicy(csp: string) {
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain(`connect-src ${OWN_FOLDER};`);
  expect(csp).toContain(`media-src ${OWN_FOLDER} data: blob:`);
  expect(csp).toContain("webrtc 'block'");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).toContain('sandbox allow-scripts');
  // No outside origin was asked for, so none is approved and no frames may nest.
  expect(csp).not.toContain('frame-src');
}

const POSTGRES_CONTAINER = process.env.LF_E2E_POSTGRES_CONTAINER ?? 'lobbyforge-e2e-postgres';

/**
 * Wipe the community's leaderboard (the plugin's `best` storage key), so this
 * run's players are the board — it keeps the 5 fastest of every run otherwise.
 * Test data set-up, straight in the stack's Postgres.
 */
function clearLeaderboard() {
  execFileSync(
    'docker',
    ['exec', POSTGRES_CONTAINER, 'psql', '-U', 'lobbyforge', '-d', 'lobbyforge', '-c', `delete from plugin_data where plugin_id = '${PLUGIN_ID}' and key = 'best'`],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }
  );
}

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 150_000 });

interface Player {
  ctx: BrowserContext;
  page: Page;
  uid: string;
  name: string;
}

function buzzer(page: Page): FrameLocator {
  return page.frameLocator(`iframe[title="${FRAME_TITLE}"]`);
}

function buzzerFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes(`/api/plugin-ui/${PLUGIN_ID}/`));
  if (!frame) throw new Error('the plugin frame is not on the page');
  return frame;
}

async function shootBothThemes(page: Page, path: (theme: string) => string) {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path(colorScheme) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

test.describe('sandboxed marketplace plugin: Sandbox Buzzer', () => {
  let browser: Browser;
  let owner: APIRequestContext;
  let host: Player;
  let alice: Player;
  let bob: Player;
  let serverId = '';
  let voiceChannelId = '';
  let sessionId = '';
  const roomName = `buzzer-room-${RUN}`;

  async function newPlayer(seed: string | null): Promise<Player> {
    const ctx = await browser.newContext({
      baseURL: baseUrl,
      locale: 'en-US',
      viewport: { width: 1360, height: 900 },
      colorScheme: 'dark',
      permissions: ['microphone', 'camera'],
    });
    if (seed === null) {
      const setup = await ctx.request.post('/api/setup/complete', {
        headers: ORIGIN,
        data: {
          setupToken,
          instanceName: 'Sandbox E2E',
          ownerDisplayName: 'Owner',
          ownerEmail: OWNER_EMAIL,
          ownerPassword: OWNER_PASSWORD,
          registrationMode: 'open',
          guestAccessEnabled: true,
          seoIndexingEnabled: false,
        },
      });
      if (setup.status() !== 200) {
        const login = await signIn(ctx.request, { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
        expect(login.status(), 'owner login on a warm stack').toBe(200);
      }
    } else {
      expect((await createGuest(ctx.request, { headers: ORIGIN, data: { displayNameSeed: `${seed} ${RUN.slice(-4)}` } })).status()).toBe(200);
      const invite = await owner.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
      expect(invite.status()).toBe(201);
      const { invite: inv } = (await invite.json()) as { invite: { code: string } };
      expect((await ctx.request.post(`/api/invites/${inv.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    }
    const me = (await (await ctx.request.get('/api/auth/guest')).json()) as { guest: { uid: string; name: string } };
    return { ctx, page: await ctx.newPage(), uid: me.guest.uid, name: me.guest.name };
  }

  async function joinRoom(page: Page) {
    await page.goto(`/lobby?server=${serverId}`);
    const channel = page.getByRole('button', { name: roomName }).filter({ has: page.locator('span', { hasText: 'volume_up' }) });
    await expect(channel.first()).toBeVisible({ timeout: 15_000 });
    await channel.first().click();
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
  }

  async function openActivities(page: Page) {
    await page.getByTitle('Start a game or activity in this voice room').click();
    await expect(page.getByRole('button', { name: 'Close activities', exact: true })).toBeVisible();
  }

  async function viewerState(player: Player) {
    const res = await player.ctx.request.get(`/api/servers/${serverId}/activities/${sessionId}`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { activity: { state: Record<string, unknown> } }).activity.state;
  }

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    test.setTimeout(120_000);
    // Fake media, and WITHOUT --disable-web-security (it drops the Origin
    // header, and the CSRF guard refuses every POST from the page).
    // The stand-in parent below is served by route interception, which
    // Chromium treats as a public address space: switch off Local Network
    // Access checks (as the Playwright config does) so it can frame localhost.
    browser = await playwright.chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
      ],
    });
    host = await newPlayer(null);
    owner = host.ctx.request;
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;

    // Is the bundle installed on this stack at all? The asset route reads the
    // install directory directly (it does not depend on the plugin registry).
    const asset = await owner.get(`/api/plugin-ui/${PLUGIN_ID}/${PLUGIN_VERSION}/index.html`, { headers: FRAME_FETCH });
    test.skip(
      asset.status() === 404,
      'Sandbox Buzzer is not installed: start the stack with docker-compose.e2e-plugins.yml and run infra/docker/e2e-install-sandbox-plugin.sh.'
    );
    expect(asset.status()).toBe(200);
    // Before any session of this run reads it (createInitialState copies the board).
    clearLeaderboard();

    // A voice room of its own; the app is enabled by the first test (the
    // lobby builds its launch cards when it renders, so that comes first).
    const room = await owner.post(`/api/servers/${serverId}/channels`, { headers: ORIGIN, data: { name: roomName, type: 'voice' } });
    expect(room.status()).toBe(201);
    voiceChannelId = ((await room.json()) as { channel: { id: string } }).channel.id;

    alice = await newPlayer('Alice');
    bob = await newPlayer('Bob');
  });

  test.afterAll(async () => {
    if (owner && sessionId) await owner.post(`/api/servers/${serverId}/activities/${sessionId}/end`, { headers: ORIGIN, data: {} }).catch(() => undefined);
    if (owner && voiceChannelId) await owner.delete(`/api/servers/${serverId}/channels/${voiceChannelId}`, { headers: ORIGIN }).catch(() => undefined);
    for (const p of [host, alice, bob]) await p?.ctx.close();
    await browser?.close();
  });

  test('the installed plugin is offered: listed, enabled, framed', async () => {
    // Found by this spec on 2026-10-04: the registry was a module-level Map
    // that only the instrumentation chunk had warmed, so routes never saw an
    // installed plugin (404 "Unknown plugin"). It now lives on globalThis.
    const { apps } = (await (await owner.get(`/api/servers/${serverId}/apps`)).json()) as { apps: Array<{ id: string }> };
    expect(apps.map((a) => a.id)).toContain(PLUGIN_ID);
    const enable = await owner.post(`/api/servers/${serverId}/apps`, { headers: ORIGIN, data: { pluginId: PLUGIN_ID, enabled: true } });
    expect(enable.status(), await enable.text()).toBe(200);
    const frameInfo = await owner.get(`/api/plugin-ui/${PLUGIN_ID}`);
    expect(frameInfo.status()).toBe(200);
    expect(((await frameInfo.json()) as { frame: { version: string; hasProjection: boolean } }).frame).toMatchObject({
      version: PLUGIN_VERSION,
      hasProjection: true,
    });
  });

  test('isolation against the real asset route: opaque origin, no cookies, no parent, no network beyond its own folder', async ({}, testInfo) => {
    // A stand-in parent at the app origin frames the REAL bundle exactly as
    // the lobby does (<iframe sandbox="allow-scripts">); only the parent page
    // is served by route interception, the frame comes from the stack with
    // its real headers. Independent of the plugin registry.
    const page = await host.ctx.newPage();
    const src = `/api/plugin-ui/${PLUGIN_ID}/${PLUGIN_VERSION}/index.html`;
    await page.route('**/lf-sandbox-parent.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><iframe title="${FRAME_TITLE}" sandbox="allow-scripts" src="${src}" style="width:900px;height:600px;border:0"></iframe></body></html>`,
      })
    );
    const frameResponse = page.waitForResponse((res) => res.url().endsWith(src));
    await page.goto(new URL('/lf-sandbox-parent.html', baseUrl).toString());
    const served = await frameResponse;
    expect(served.status()).toBe(200);
    expectFramePolicy(served.headers()['content-security-policy'] ?? '');
    expect(served.headers()['x-content-type-options']).toBe('nosniff');
    await expect.poll(() => page.frames().some((f) => f.url().includes(src))).toBe(true);
    const frame = page.frames().find((f) => f.url().includes(src))!;
    await frame.waitForLoadState('load');

    expect(await frame.evaluate(() => window.origin)).toBe('null');
    const reads = await frame.evaluate(async () => {
      const attempt = async (fn: () => unknown) => {
        try {
          const value = await fn();
          return `read:${String(value).slice(0, 40)}`;
        } catch (err) {
          return `blocked:${(err as Error).name}`;
        }
      };
      return {
        cookie: await attempt(() => document.cookie),
        parentCookie: await attempt(() => window.parent.document.cookie),
        parentLocation: await attempt(() => window.parent.location.href),
        storage: await attempt(() => window.localStorage.length),
        fetchApi: await attempt(async () => (await fetch('/api/servers', { credentials: 'include' })).status),
        fetchOutside: await attempt(async () => (await fetch('https://example.com/')).status),
        // Its own folder is what connect-src allows (the sound it ships, for instance).
        fetchOwn: await attempt(async () => (await fetch('./buzz.wav')).status),
      };
    });
    console.info('[sandbox] reads from inside the frame', reads);
    expect(reads.fetchOwn).toBe('read:200');
    expect(reads.cookie).toBe('blocked:SecurityError');
    expect(reads.parentCookie).toBe('blocked:SecurityError');
    expect(reads.parentLocation).toBe('blocked:SecurityError');
    expect(reads.storage).toBe('blocked:SecurityError');
    expect(reads.fetchApi).toBe('blocked:TypeError');
    expect(reads.fetchOutside).toBe('blocked:TypeError');
    // …while the parent's session cookie exists.
    expect((await host.ctx.cookies(baseUrl)).some((c) => c.name === 'lf_guest')).toBe(true);
    // Opened top-level (not as a frame), the bundle page is refused.
    const topLevel = await host.ctx.request.get(src, { headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } });
    expect(topLevel.status()).toBe(403);
    await page.screenshot({ path: testInfo.outputPath('0-standin-parent.png') });
    await page.close();
  });

  test('three people play a round inside the iframe; nobody sees who buzzed first before the reveal', async ({}, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    for (const p of [host, alice, bob]) await joinRoom(p.page);

    // The owner starts it from the activities hub.
    await openActivities(host.page);
    await host.page.getByRole('button').filter({ has: host.page.getByText(APP_NAME, { exact: true }) }).filter({ hasText: 'Start' }).click();
    const hostFrame = buzzer(host.page);
    await expect(hostFrame.getByText('Open a round when everyone is ready.')).toBeVisible({ timeout: 20_000 });
    const sessions = (await (await owner.get(`/api/servers/${serverId}/channels/${voiceChannelId}/activities`)).json()) as {
      activities: Array<{ id: string; pluginId: string; status: string }>;
    };
    sessionId = sessions.activities.find((a) => a.pluginId === PLUGIN_ID && a.status !== 'ended')!.id;

    // The iframe really is sandboxed to scripts only, served by the plugin-ui route.
    const iframe = host.page.locator(`iframe[title="${FRAME_TITLE}"]`);
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(await iframe.getAttribute('src')).toMatch(new RegExp(`^/api/plugin-ui/${PLUGIN_ID}/\\d+\\.\\d+\\.\\d+/index\\.html`));

    // The members open the same activity.
    for (const p of [alice, bob]) {
      await openActivities(p.page);
      await expect(buzzer(p.page).getByText('Waiting for the host to open a round.')).toBeVisible({ timeout: 20_000 });
    }

    // Round 1: open, Alice buzzes, then Bob.
    await hostFrame.getByRole('button', { name: 'Open round' }).click();
    for (const p of [alice, bob]) await expect(buzzer(p.page).getByText('Buzz as fast as you can!')).toBeVisible({ timeout: 15_000 });
    await buzzer(alice.page).getByRole('button', { name: 'Buzz!' }).click();
    await expect(buzzer(alice.page).getByText('You buzzed. Waiting for the host to reveal…')).toBeVisible();
    await expect(buzzer(alice.page).getByRole('button', { name: 'Buzz!' })).toBeDisabled();
    await expect(buzzer(bob.page).getByText('1 buzz so far')).toBeVisible({ timeout: 15_000 });

    // Projection: Bob — and the host — know a buzz happened, not whose.
    for (const p of [bob, host]) {
      const frame = buzzer(p.page);
      await expect(frame.getByText(/buzzed first/)).toHaveCount(0);
      await expect(frame.getByText(alice.name)).toHaveCount(0);
    }
    for (const p of [bob, host]) {
      const state = await viewerState(p);
      expect(state.phase).toBe('open');
      expect(state.buzzCount).toBe(1);
      expect(state.buzzes).toBeNull();
      expect(state.winner).toBeNull();
      expect(JSON.stringify(state)).not.toContain(alice.uid);
    }
    await shootBothThemes(bob.page, shot('1-open-round-bob'));

    await buzzer(bob.page).getByRole('button', { name: 'Buzz!' }).click();
    await expect(buzzer(host.page).getByText('2 buzzes so far')).toBeVisible({ timeout: 15_000 });

    // Reveal: everyone sees Alice first.
    await hostFrame.getByRole('button', { name: 'Reveal' }).click();
    for (const p of [host, alice, bob]) {
      const frame = buzzer(p.page);
      await expect(frame.getByText(/buzzed first/)).toBeVisible({ timeout: 15_000 });
      await expect(frame.getByText(/buzzed first/)).toContainText(alice.name);
    }
    const revealed = await viewerState(bob);
    expect(revealed.phase).toBe('revealed');
    expect((revealed.winner as { playerId?: string } | string | null) && JSON.stringify(revealed.winner)).toContain(alice.uid);
    await shootBothThemes(bob.page, shot('2-revealed-bob'));
  });

  test('isolation inside the lobby, checked from the parent page', async () => {
    const page = host.page;
    const frame = buzzerFrame(page);

    // An opaque origin: not the app's.
    expect(await frame.evaluate(() => window.origin)).toBe('null');
    // (`location.origin` still spells the URL's origin in a sandboxed frame;
    // the security origin is `window.origin`.) The parent's DOM is out of reach.
    expect(
      await frame.evaluate(() => {
        try {
          return `read:${window.parent.document.title}`;
        } catch (err) {
          return `blocked:${(err as Error).name}`;
        }
      })
    ).toBe('blocked:SecurityError');
    // No cookie of its own to read, and no way into the parent's.
    const cookie = await frame.evaluate(() => {
      try {
        return `read:${document.cookie}`;
      } catch (err) {
        return `blocked:${(err as Error).name}`;
      }
    });
    expect(cookie).toBe('blocked:SecurityError');
    const parentCookie = await frame.evaluate(() => {
      try {
        return `read:${window.parent.document.cookie}`;
      } catch (err) {
        return `blocked:${(err as Error).name}`;
      }
    });
    expect(parentCookie).toBe('blocked:SecurityError');
    // The parent's session cookie exists — the frame just cannot see it.
    expect((await host.ctx.cookies(baseUrl)).some((c) => c.name === 'lf_guest')).toBe(true);

    // A fetch to the app's API from inside the frame is blocked by its CSP.
    const fetched = await frame.evaluate(async () => {
      try {
        const res = await fetch('/api/servers', { credentials: 'include' });
        return `answered:${res.status}`;
      } catch (err) {
        return `blocked:${(err as Error).name}`;
      }
    });
    expect(fetched).toBe('blocked:TypeError');
    const asset = await host.ctx.request.get(`/api/plugin-ui/${PLUGIN_ID}`);
    const { frame: info } = (await asset.json()) as { frame: { version: string } };
    const html = await host.ctx.request.get(`/api/plugin-ui/${PLUGIN_ID}/${info.version}/index.html`, {
      headers: { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(info.version).toBe(PLUGIN_VERSION);
    expectFramePolicy(html.headers()['content-security-policy'] ?? '');
  });

  test('navigating the frame away stops it: the lobby shows the error state', async ({}, testInfo) => {
    const page = alice.page;
    const frame = buzzerFrame(page);
    await frame.evaluate(() => {
      window.location.href = 'about:blank#escaped';
    });
    const alert = page.getByRole('alert').filter({ hasText: /This app didn.t start/ });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(`${APP_NAME} didn`);
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The navigated frame no longer runs the plugin UI.
    await expect(buzzer(page).getByRole('button', { name: 'Buzz!' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('3-frame-error-state.png') });

    // Try again brings the real plugin back.
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(buzzer(page).getByText(/buzzed first/)).toBeVisible({ timeout: 20_000 });
  });

  test('timers and storage: a round nobody reveals reveals itself after 30 s; the fastest reactions outlive the session', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    const hostFrame = buzzer(host.page);
    type Best = Array<{ playerId: string; name: string; ms: number }>;
    /** The "Fastest reactions" list inside a player's frame. */
    const board = (p: Player) => buzzer(p.page).locator('#best-list');

    // Round 1's reveal put Alice's reaction on the community's board (a
    // `storage.set` effect); every screen lists it.
    const before = await viewerState(bob);
    expect((before.best as Best).map((e) => e.playerId)).toEqual([alice.uid]);
    for (const p of [host, alice, bob]) await expect(buzzer(p.page).getByText('Fastest reactions')).toBeVisible({ timeout: 15_000 });
    await expect(board(alice).getByText(`1. ${alice.name} (you)`)).toBeVisible();

    // Round 2: Bob buzzes, and nobody presses Reveal.
    await hostFrame.getByRole('button', { name: 'Next round' }).click();
    const openedAt = Date.now();
    for (const p of [alice, bob]) await expect(buzzer(p.page).getByText('Buzz as fast as you can!')).toBeVisible({ timeout: 15_000 });
    await expect(hostFrame.getByText(/^Reveals by itself in \d+ s$/)).toBeVisible();
    await buzzer(bob.page).getByRole('button', { name: 'Buzz!' }).click();
    await expect(buzzer(bob.page).getByText('You buzzed. Waiting for the host to reveal…')).toBeVisible();
    const open = await viewerState(host);
    expect(open.phase).toBe('open');
    expect(open.round).toBe(2);
    expect((open.revealAt as number) - (open.openedAt as number)).toBe(30_000);
    expect(open.winner).toBeNull();
    await shootBothThemes(host.page, shot('4-auto-reveal-countdown-host'));

    // The host's timer (no client can send `auto-reveal`) reveals it ~30 s
    // after it opened: Bob first, on every screen.
    for (const p of [host, alice, bob]) {
      await expect(buzzer(p.page).getByText(/buzzed first/)).toContainText(bob.name, { timeout: 75_000 });
    }
    expect(Date.now() - openedAt, 'not before the 30 s timer').toBeGreaterThanOrEqual(28_000);
    const revealed = await viewerState(alice);
    expect(revealed.phase).toBe('revealed');
    expect(revealed.winner).toBe(bob.uid);
    expect(revealed.revealAt).toBeNull();
    // One entry per player, fastest first: both now hold a record.
    const best = revealed.best as Best;
    expect(best.map((e) => e.playerId).sort()).toEqual([alice.uid, bob.uid].sort());
    expect(best[0]!.ms).toBeLessThanOrEqual(best[1]!.ms);
    await expect(board(bob).getByText(`${bob.name} (you)`, { exact: false })).toBeVisible();
    await expect(board(bob).getByRole('listitem')).toHaveCount(2);
    await shootBothThemes(alice.page, shot('5-auto-revealed-alice'));

    // Storage outlives the session: end it and start a new one — it opens
    // with the board before a single round is played.
    const end = await owner.post(`/api/servers/${serverId}/activities/${sessionId}/end`, { headers: ORIGIN, data: {} });
    expect(end.status(), await end.text()).toBe(200);
    const ended = sessionId;
    // The ended activity gives the room back: the hub, or its button.
    const hub = host.page.getByRole('heading', { name: 'Start something together' });
    await expect(hub.or(host.page.getByTitle('Start a game or activity in this voice room'))).toBeVisible({ timeout: 20_000 });
    if (!(await hub.isVisible())) await openActivities(host.page);
    await host.page.getByRole('button').filter({ has: host.page.getByText(APP_NAME, { exact: true }) }).filter({ hasText: 'Start' }).click();
    await expect(hostFrame.getByText('Open a round when everyone is ready.')).toBeVisible({ timeout: 20_000 });
    const sessions = (await (await owner.get(`/api/servers/${serverId}/channels/${voiceChannelId}/activities`)).json()) as {
      activities: Array<{ id: string; pluginId: string; status: string }>;
    };
    sessionId = sessions.activities.find((a) => a.pluginId === PLUGIN_ID && a.status !== 'ended')!.id;
    expect(sessionId).not.toBe(ended);
    const fresh = await viewerState(host);
    expect(fresh.phase).toBe('idle');
    expect(fresh.round).toBe(0);
    expect(fresh.scores).toEqual({});
    expect((fresh.best as Best).map((e) => e.playerId).sort()).toEqual([alice.uid, bob.uid].sort());
    await expect(hostFrame.getByText('Fastest reactions')).toBeVisible();
    await expect(board(host).getByText(bob.name, { exact: false })).toBeVisible();
    await expect(board(host).getByText(alice.name, { exact: false })).toBeVisible();
    await shootBothThemes(host.page, shot('6-new-session-keeps-board-host'));
  });
});
