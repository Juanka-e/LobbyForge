import { expect, test, type Page } from '@playwright/test';
import { BUZZER_VERSION, PORT } from './playwright.config';

/**
 * ADR-007 in a real browser: a marketplace plugin's UI in
 * `<iframe sandbox="allow-scripts">`, served by the real /api/plugin-ui route.
 *
 * The parent here is a stand-in for the lobby — served on the app's origin
 * with the app's real CSP (from the middleware) — that speaks frame protocol
 * v1 the way PluginFrame does. PluginFrame's own logic is covered by its
 * component tests; this proves what only a browser can: the opaque origin,
 * the CSP, the Fetch Metadata labels and the module-script loading.
 */

const PLUGIN_UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; " +
  'sandbox allow-scripts';

const PLAYERS = [
  { userId: 'u1', name: 'Ayşe', isHost: true },
  { userId: 'u2', name: 'Can', isHost: false },
];

type Recorded = { url: string; headers: Record<string, string>; failure?: string; status?: number; raw: Promise<void> };

/**
 * Every request the page and its frames start, with how it ended. Chrome
 * reports a CSP-blocked load as a request that FAILED with
 * net::ERR_BLOCKED_BY_CSP: it never reached the network.
 */
function recordRequests(page: Page): Recorded[] {
  const seen: Recorded[] = [];
  const byRequest = new Map<unknown, Recorded>();
  page.on('request', (request) => {
    const entry: Recorded = { url: request.url(), headers: request.headers(), raw: Promise.resolve() };
    // The raw headers (Sec-Fetch-*, Cookie) arrive a moment later.
    entry.raw = request.allHeaders().then(
      (headers) => {
        entry.headers = headers;
      },
      () => undefined
    );
    byRequest.set(request, entry);
    seen.push(entry);
  });
  page.on('requestfailed', (request) => {
    const entry = byRequest.get(request);
    if (entry) entry.failure = request.failure()?.errorText ?? 'failed';
  });
  page.on('response', (response) => {
    const entry = byRequest.get(response.request());
    if (entry) entry.status = response.status();
  });
  return seen;
}

/** Nothing for example.com got a response: each attempt was blocked by CSP in the browser. */
function expectNothingLeft(requests: Recorded[]) {
  const external = requests.filter((r) => r.url.includes('example.com'));
  for (const r of external) {
    expect(r.status, r.url).toBeUndefined();
    expect(r.failure, r.url).toMatch(/csp/i);
  }
}

/**
 * Open a lobby stand-in that frames `pluginId@version`, answers `ready` with
 * `init(initialState)` and records every message and action from the frame.
 */
async function openHarness(page: Page, pluginId: string, version: string, initialState: unknown, afterInit = '') {
  // The app's real policy for its pages (frame-src 'self' …) and its nonce,
  // from a live response: the middleware stamps every app route.
  const app = await page.request.get('/api/plugin-ui/probe');
  const csp = app.headers()['content-security-policy'] ?? '';
  const nonce = app.headers()['x-nonce'] ?? '';
  expect(csp).toContain("frame-src 'self' https://www.youtube-nocookie.com");
  const html = `<!doctype html>
<html lang="en" class="lf-theme-light" style="--lf-surface:#ffffff;--lf-text-primary:#101826">
<head><meta charset="utf-8"><title>Lobby stand-in</title></head>
<body>
<iframe id="frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="app"
  style="width:640px;height:420px;border:0" src="/api/plugin-ui/${pluginId}/${version}/index.html"></iframe>
<script nonce="${nonce}">
  window.__messages = [];
  window.__actions = [];
  window.__inited = false;
  const frame = document.getElementById('frame');
  window.__post = (m) => frame.contentWindow.postMessage(m, '*');
  window.__state = ${JSON.stringify(initialState)};
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    window.__messages.push({ origin: e.origin, data: e.data });
    const d = e.data || {};
    if (d.lf === 1 && d.type === 'ready') {
      window.__post({ lf: 1, type: 'init', viewer: { userId: 'u1', isHost: true }, players: ${JSON.stringify(PLAYERS)},
        locale: 'en', theme: { scheme: 'light', vars: { '--lf-surface': '#ffffff', '--lf-text-primary': '#101826' } },
        state: window.__state, revision: 1 });
      if (!window.__inited) { window.__inited = true; ${afterInit} }
    }
    if (d.lf === 1 && d.type === 'action') {
      window.__actions.push(d.action);
      if (d.action.type === 'probe-results') window.__probe = d.action.results;
    }
  });
</script>
</body></html>`;
  await page.route('**/__lobby-stand-in', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp },
      body: html,
    })
  );
  await page.goto('/__lobby-stand-in');
}

const headerValues = (all: Array<{ name: string; value: string }>, name: string) =>
  all.filter((h) => h.name.toLowerCase() === name).map((h) => h.value);

test('the asset route answers with the sandbox policy, and nothing that forbids the lobby frame', async ({ request }) => {
  const res = await request.get('/api/plugin-ui/probe/1.0.0/index.html', {
    headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
  });
  expect(res.status()).toBe(200);
  const all = res.headersArray();
  console.info('[asset route headers]', JSON.stringify(all));
  // Exactly one CSP — the middleware and next.config add none of theirs.
  expect(headerValues(all, 'content-security-policy')).toEqual([PLUGIN_UI_CSP]);
  expect(headerValues(all, 'x-frame-options')).toEqual([]);
  expect(headerValues(all, 'x-content-type-options')).toEqual(['nosniff']);
  expect(headerValues(all, 'cross-origin-resource-policy')).toEqual(['cross-origin']);
  expect(headerValues(all, 'access-control-allow-origin')).toEqual(['*']);
  expect(headerValues(all, 'cache-control')).toEqual(['public, max-age=31536000, immutable']);
  expect(headerValues(all, 'vary').join(',')).toContain('Sec-Fetch-Dest');
  expect(headerValues(all, 'set-cookie')).toEqual([]);

  // A page of the app keeps the app policy.
  const notUi = await request.get('/api/plugin-ui/probe');
  expect(notUi.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  // And next.config's fallback headers still reach paths the middleware
  // skips: its narrowed source pattern only leaves out /api/plugin-ui/.
  const skippedByMiddleware = await request.get('/favicon.ico');
  expect(skippedByMiddleware.headers()['x-frame-options']).toBe('DENY');
});

test('the frame runs in an opaque origin: no cookies, storage, parent DOM or network; protocol v1 round-trips', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'lf_guest', value: 'pretend-session', url: `http://localhost:${PORT}`, sameSite: 'Lax' },
  ]);
  const requests = recordRequests(page);
  const popups: string[] = [];
  page.on('popup', (p) => popups.push(p.url()));
  await openHarness(
    page,
    'probe',
    '1.0.0',
    { step: 1 },
    "setTimeout(() => window.__post({ lf: 1, type: 'state', state: { step: 2 }, revision: 2 }), 100);"
  );
  await page.waitForFunction(() => (window as { __probe?: { lastState?: { revision?: number } } }).__probe?.lastState?.revision === 2);
  const probe = await page.evaluate(() => (window as unknown as { __probe: Record<string, unknown> }).__probe);
  console.info('[probe]', JSON.stringify(probe));

  expect(probe.origin).toBe('null');
  expect(probe.inlineScriptRan).toBe(false);
  expect(probe.cookie).toBe('blocked:SecurityError');
  expect(probe.parentDocument).toBe('blocked:SecurityError');
  expect(probe.parentCookie).toBe('blocked:SecurityError');
  expect(String(probe.localStorage)).toMatch(/^blocked:/);
  expect(probe.popup).toBe('allowed:null');
  expect(popups).toEqual([]);
  expect(probe.appFetch).toBe('blocked');
  expect(probe.ownFileFetch).toBe('blocked');
  expect(probe.externalFetch).toBe('blocked');
  expect(probe.externalImage).toBe('blocked');
  expect(probe.ownImage).toBe('loaded');
  const violations = probe.violations as string[];
  expect(violations.some((v) => v.startsWith('connect-src'))).toBe(true);
  expect(violations.some((v) => v.startsWith('img-src https://example.com'))).toBe(true);
  // (The inline <script> was refused before probe.js could listen for the
  // violation; inlineScriptRan === false above is the proof.)

  // The frame client applied the theme and language from init.
  expect(probe.init).toEqual({
    viewer: { userId: 'u1', isHost: true },
    players: 2,
    locale: 'en',
    scheme: 'light',
    appliedSurface: '#ffffff',
    dataTheme: 'light',
    lang: 'en',
  });
  expect(probe.lastState).toEqual({ state: { step: 2 }, revision: 2 });

  // What the parent saw: every message from origin "null", ready + resize.
  const messages = await page.evaluate(
    () => (window as unknown as { __messages: Array<{ origin: string; data: { type: string; height?: number } }> }).__messages
  );
  expect(new Set(messages.map((m) => m.origin))).toEqual(new Set(['null']));
  expect(messages.some((m) => m.data.type === 'ready')).toBe(true);
  expect(messages.some((m) => m.data.type === 'resize' && (m.data.height ?? 0) > 0)).toBe(true);

  // The frame's own requests carry Origin: null and no session cookie (the
  // parent's requests do carry it), and its module scripts loaded — ACAO *
  // is what lets an opaque origin load modules. They were served (200) where
  // the same file requested by an app page is refused (next test): the
  // browser labelled them cross-site, as the Fetch Metadata policy expects.
  // (Request interception hides Sec-Fetch-* from Playwright, so the labels
  // are proven by those outcomes rather than read here.)
  await Promise.all(requests.map((r) => r.raw));
  const parentDoc = requests.find((r) => r.url.endsWith('/__lobby-stand-in'));
  expect(parentDoc?.headers.cookie).toContain('lf_guest=');
  for (const file of ['probe.js', 'lobbyforge-frame.js', 'dot.svg']) {
    const req = requests.find((r) => r.url.endsWith(`/probe/1.0.0/${file}`));
    expect(req?.status, file).toBe(200);
    expect(req?.headers.cookie, file).toBeUndefined();
    if (file.endsWith('.js')) expect(req?.headers.origin, file).toBe('null');
  }
  expectNothingLeft(requests);
});

test('the frame cannot navigate itself off the app: the parent’s frame-src stops it', async ({ page }) => {
  const requests = recordRequests(page);
  await openHarness(page, 'probe', '1.0.0', { step: 1 });
  await page.waitForFunction(() => Boolean((window as { __probe?: unknown }).__probe));
  const frame = page.frames().find((f) => f.url().includes('/api/plugin-ui/probe/'));
  expect(frame).toBeTruthy();
  await frame!.evaluate(() => {
    location.href = 'https://example.com/?leak=1';
  });
  await page.waitForTimeout(1500);
  expectNothingLeft(requests);
  expect(requests.some((r) => r.url.includes('leak=1') && r.status !== undefined)).toBe(false);
  expect(page.frames().some((f) => f.url().startsWith('https://example.com'))).toBe(false);
  console.info('[after navigation]', JSON.stringify(page.frames().map((f) => f.url())), JSON.stringify(requests.filter((r) => r.url.includes('example.com')).map((r) => ({ url: r.url, failure: r.failure }))));
});

test('the app’s own pages cannot run a plugin file, and its HTML never opens top-level', async ({ page }) => {
  await openHarness(page, 'probe', '1.0.0', { step: 1 });
  // Wait until the frame has loaded probe.js itself (so it is cached for the frame).
  await page.waitForFunction(() => Boolean((window as { __probe?: unknown }).__probe));
  const gadget = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const s = document.createElement('script');
        s.src = '/api/plugin-ui/probe/1.0.0/probe.js';
        s.onload = () => resolve('loaded');
        s.onerror = () => resolve('blocked');
        document.head.appendChild(s);
      })
  );
  expect(gadget).toBe('blocked');

  const top = await page.goto('/api/plugin-ui/probe/1.0.0/index.html');
  expect(top?.status()).toBe(403);
});

test('the sandbox-buzzer example renders the projected state and dispatches through the parent', async ({ page }) => {
  // What server.js projectState sends while a round is open: a count and
  // "did I buzz", never names or order.
  await openHarness(page, 'sandbox-buzzer', BUZZER_VERSION, {
    v: 1,
    phase: 'open',
    round: 3,
    tone: 'teal',
    openedAt: 1000,
    buzzCount: 1,
    youBuzzed: false,
    buzzes: null,
    winner: null,
    scores: { u2: 2 },
  });
  const frame = page.frameLocator('#frame');
  await expect(frame.getByText('Round 3')).toBeVisible();
  await expect(frame.getByText('1 buzz so far')).toBeVisible();
  const buzz = frame.getByRole('button', { name: 'Buzz!' });
  await expect(buzz).toBeEnabled();
  await buzz.click();
  // The viewer is the host here, so the host controls are shown.
  await frame.getByRole('button', { name: 'Reveal' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __actions: Array<{ type: string }> }).__actions))
    .toEqual([{ type: 'buzz' }, { type: 'reveal' }]);

  // Revealed: everyone sees the order, by name, with reaction times.
  await page.evaluate(() => {
    (window as unknown as { __post: (m: unknown) => void }).__post({
      lf: 1,
      type: 'state',
      state: {
        v: 1,
        phase: 'revealed',
        round: 3,
        tone: 'teal',
        openedAt: 1000,
        buzzCount: 2,
        youBuzzed: true,
        buzzes: [
          { playerId: 'u2', ms: 420 },
          { playerId: 'u1', ms: 615 },
        ],
        winner: 'u2',
        scores: { u2: 3 },
      },
      revision: 2,
    });
  });
  await expect(frame.getByText('Can buzzed first')).toBeVisible();
  await expect(frame.getByText('2. Ayşe (you)')).toBeVisible();
  await expect(frame.getByText('3 points')).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Buzz!' })).toBeDisabled();
  await expect(frame.getByRole('button', { name: 'Next round' })).toBeVisible();
});
