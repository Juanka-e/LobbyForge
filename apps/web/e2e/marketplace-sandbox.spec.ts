/**
 * A sandboxed marketplace plugin, end to end on the real stack (ADR-007,
 * docs/PLUGIN_SDK.md "Marketplace plugin UI"): `examples/plugins/
 * sandbox-buzzer` runs in the QuickJS plugin worker, and its UI in an
 * `<iframe sandbox="allow-scripts">` served from /api/plugin-ui/….
 *
 *   - The owner enables "Sandbox Buzzer" for the server and starts it in a
 *     voice room; two members open the same activity.
 *   - Inside the iframe: the host opens a round, member A buzzes, then B.
 *     Before the reveal nobody — B, nor the host, nor the state the API
 *     hands out — can see who buzzed first (the worker's projection). After
 *     the reveal everyone sees A first.
 *   - Isolation, checked from the parent page: the frame's origin is the
 *     opaque "null", it cannot read the parent's cookie or DOM, a fetch to
 *     /api from inside the frame is blocked (CSP connect-src 'none'), and
 *     navigating the frame away stops it — the lobby shows the error state.
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

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);
const PLUGIN_ID = 'sandbox-buzzer';
const PLUGIN_VERSION = '0.1.0';
const APP_NAME = 'Sandbox Buzzer';
/** How a browser fetches a frame document (the asset route checks Fetch Metadata). */
const FRAME_FETCH = { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' };
const FRAME_TITLE = `${APP_NAME} — app screen`;

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
        const login = await ctx.request.post('/api/auth/login', { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
        expect(login.status(), 'owner login on a warm stack').toBe(200);
      }
    } else {
      expect((await ctx.request.post('/api/auth/guest', { headers: ORIGIN, data: { displayNameSeed: `${seed} ${RUN.slice(-4)}` } })).status()).toBe(200);
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

  test('isolation against the real asset route: opaque origin, no cookies, no parent, no network', async ({}, testInfo) => {
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
    const csp = served.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('sandbox allow-scripts');
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
      };
    });
    console.info('[sandbox] reads from inside the frame', reads);
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
    const csp = html.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('sandbox allow-scripts');
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
});
