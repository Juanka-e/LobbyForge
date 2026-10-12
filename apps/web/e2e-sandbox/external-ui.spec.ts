import { expect, test, type Page } from '@playwright/test';
import { OTHER_SITE, PENDING_SITE, PORT, SITE, SITE_UI } from './playwright.config';

/**
 * Phase 2 of the plugin unlock (docs/PLUGIN_UNLOCK_PLAN.md) in a real
 * browser: outside origins the instance owner approved at install.
 *
 *  - A plugin's own files reach an approved API, and the frame's CSP refuses
 *    one it asked for but was not approved (the request never leaves).
 *  - A plugin whose UI is its author's own site (`ui: { url }`): the app's
 *    page policy admits exactly the approved sites in `frame-src`; the site
 *    runs with its own origin under
 *    `sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"`,
 *    cannot reach into the lobby, navigate it, open windows or show
 *    dialogs, and speaks protocol v1 with the vendored frame client, which
 *    learns the lobby's origin from the first init. Another site loaded into
 *    the same frame window is never heard, and hears nothing.
 *
 * The parent is a stand-in for the lobby — served on the app's origin with
 * the app's real page CSP (from the middleware) — applying PluginFrame's
 * rules: this iframe's window AND the declared origin, and posts to that
 * origin only. PluginFrame's own logic is covered by its component tests;
 * this proves what only a browser can.
 *
 * Chrome's Local Network Access refuses to let a public page frame a
 * loopback address, and the stand-in — fulfilled by Playwright, not served
 * over the network — counts as public; the permission below lets it frame
 * the 127.0.0.1 sites. In production both the instance and the site are
 * public, and none of what is proven here depends on it.
 */
test.use({ permissions: ['local-network-access'] });

const EXTERNAL_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';
const PLAYERS = [
  { userId: 'u1', name: 'Ayşe', isHost: true },
  { userId: 'u2', name: 'Can', isHost: false },
];
const FIXED_FRAME_SRC = "frame-src 'self' https://www.youtube-nocookie.com";

type Recorded = { url: string; headers: Record<string, string>; failure?: string; status?: number; raw: Promise<void> };

/** Every request the page and its frames start, with how it ended (a CSP block fails as net::ERR_BLOCKED_BY_CSP). */
function recordRequests(page: Page): Recorded[] {
  const seen: Recorded[] = [];
  const byRequest = new Map<unknown, Recorded>();
  page.on('request', (request) => {
    const entry: Recorded = { url: request.url(), headers: request.headers(), raw: Promise.resolve() };
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

/**
 * The app's real policy for its PAGES, and a nonce for the stand-in's
 * script. No page renders here without a database, but the middleware stamps
 * every page response first — the approved sites are added on pages only.
 */
async function pagePolicy(page: Page): Promise<{ csp: string; nonce: string }> {
  const res = await page.request.get('/lobby-policy-probe', { timeout: 180_000 });
  return { csp: res.headers()['content-security-policy'] ?? '', nonce: res.headers()['x-nonce'] ?? '' };
}

const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));

/**
 * A lobby stand-in on the app's origin, under the app's page policy, framing
 * `src` with `sandbox` and applying PluginFrame's rules: messages count only
 * from this iframe's window AND `declared`; posts go to `target`. It answers
 * `ready` with `init` and, once, follows with a second state; every message
 * (heard or not) is kept in `__raw`.
 */
async function openStandIn(page: Page, opts: { path: string; src: string; sandbox: string; declared: string; target: string }) {
  const { csp, nonce } = await pagePolicy(page);
  expect(directive(csp, 'frame-src')).toContain(FIXED_FRAME_SRC);
  const html = `<!doctype html>
<html lang="en" class="lf-theme-dark">
<head><meta charset="utf-8"><title>Lobby stand-in</title></head>
<body>
<iframe id="frame" sandbox="${opts.sandbox}" referrerpolicy="no-referrer" title="app"
  style="width:640px;height:420px;border:0" src="${opts.src}"></iframe>
<script nonce="${nonce}">
  const DECLARED = ${JSON.stringify(opts.declared)};
  const TARGET = ${JSON.stringify(opts.target)};
  window.__raw = [];
  window.__accepted = [];
  window.__actions = [];
  window.__inited = false;
  const frame = document.getElementById('frame');
  window.__post = (m) => frame.contentWindow.postMessage(m, TARGET);
  addEventListener('message', (e) => {
    const fromFrame = e.source === frame.contentWindow;
    window.__raw.push({ origin: e.origin, fromFrame, data: e.data });
    if (!fromFrame || e.origin !== DECLARED) return;
    window.__accepted.push({ origin: e.origin, type: e.data && e.data.type });
    const d = e.data || {};
    if (d.lf === 1 && d.type === 'ready') {
      window.__post({ lf: 1, type: 'init', viewer: { userId: 'u1', isHost: true }, players: ${JSON.stringify(PLAYERS)},
        locale: 'en', theme: { scheme: 'dark', vars: {} }, state: { step: 1 }, revision: 1 });
      if (!window.__inited) {
        window.__inited = true;
        setTimeout(() => window.__post({ lf: 1, type: 'state', state: { step: 2 }, revision: 2 }), 100);
      }
    }
    if (d.lf === 1 && d.type === 'action') {
      window.__actions.push(d.action);
      if (d.action.type === 'probe-results') window.__probe = d.action.results;
    }
  });
</script>
</body></html>`;
  await page.route(`**${opts.path}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp },
      body: html,
    })
  );
  await page.goto(opts.path);
}

/** PluginFrame's external mode for the approved site. */
const openExternal = (page: Page) =>
  openStandIn(page, { path: '/__lobby-stand-in-external', src: SITE_UI, sandbox: EXTERNAL_SANDBOX, declared: SITE, target: SITE });

type Raw = { origin: string; fromFrame: boolean; data: Record<string, unknown> | null };
const rawMessages = (page: Page) => page.evaluate(() => (window as unknown as { __raw: Raw[] }).__raw);
const probeResults = (page: Page) => page.evaluate(() => (window as unknown as { __probe: Record<string, unknown> }).__probe);
const siteFrame = (page: Page) => page.frames().find((f) => f.url().startsWith(SITE_UI));

test('the app’s pages may frame the approved external UI sites, and no other', async ({ page }) => {
  const { csp } = await pagePolicy(page);
  console.info('[page frame-src]', directive(csp, 'frame-src'));
  // ext-probe and ext-other are approved; ext-pending asked and was not.
  expect(directive(csp, 'frame-src')).toBe(`${FIXED_FRAME_SRC} ${SITE} ${OTHER_SITE}`);
  expect(csp).not.toContain(PENDING_SITE);
  // Granting frame-src grants nothing else.
  for (const name of ['script-src', 'connect-src', 'img-src', 'style-src']) {
    expect(directive(csp, name), name).not.toContain('127.0.0.1:196');
  }
  // API responses (never documents that frame anything) keep the fixed list.
  const api = await page.request.get('/api/plugin-ui/probe');
  expect(directive(api.headers()['content-security-policy'] ?? '', 'frame-src')).toBe(FIXED_FRAME_SRC);
});

test('an approved site runs with its own origin, cannot touch the lobby, and speaks protocol v1 with it', async ({ page, context }) => {
  await context.addCookies([
    { name: 'lf_guest', value: 'pretend-session', url: `http://localhost:${PORT}`, sameSite: 'Lax' },
  ]);
  const requests = recordRequests(page);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const popups: string[] = [];
  page.on('popup', (p) => popups.push(p.url()));

  await openExternal(page);
  await page.waitForFunction(
    () => (window as { __probe?: { lastState?: { revision?: number } } }).__probe?.lastState?.revision === 2,
    undefined,
    { timeout: 30_000 }
  );
  const probe = await probeResults(page);
  console.info('[external probe]', JSON.stringify(probe));

  // Its own origin (allow-same-origin), with storage of its own…
  expect(probe.origin).toBe(SITE);
  expect(probe.ownStorage).toBe('allowed:v');
  // …but the lobby is another origin: no DOM, no location, no navigation
  // (Chrome refuses the top navigation without throwing: the lobby stays put).
  expect(probe.parentDocument).toBe('blocked:SecurityError');
  expect(probe.parentLocation).toBe('blocked:SecurityError');
  expect(page.url()).toBe(`http://localhost:${PORT}/__lobby-stand-in-external`);
  expect(page.frames().map((f) => f.url())).toEqual([page.url(), SITE_UI]);
  // No popups and no dialogs (no allow-popups, no allow-modals).
  expect(probe.popup).toBe('allowed:null');
  expect(popups).toEqual([]);
  expect(dialogs).toEqual([]);
  // The app's API is another origin that sends no CORS headers: unreadable.
  expect(probe.appApi).toBe('blocked');

  // Protocol v1: the client learned the lobby's origin from init.
  expect(probe.parentOrigin).toBe(`http://localhost:${PORT}`);
  expect(probe.init).toEqual({ viewer: { userId: 'u1', isHost: true }, players: 2, locale: 'en', scheme: 'dark' });
  expect(probe.lastState).toEqual({ state: { step: 2 }, revision: 2 });
  const raw = await rawMessages(page);
  expect(raw.length).toBeGreaterThan(0);
  expect(raw.every((m) => m.fromFrame && m.origin === SITE)).toBe(true);
  const types = raw.map((m) => m.data?.type);
  expect(types).toContain('ready');
  expect(types).toContain('resize');
  expect(types).toContain('action');

  // The frame and the site's own files loaded from the site; its request to
  // the app went out without the viewer's session (another site: no Lax cookie).
  await Promise.all(requests.map((r) => r.raw));
  expect(requests.find((r) => r.url === SITE_UI)?.status).toBe(200);
  const toApp = requests.find((r) => r.url.includes('from=site'));
  expect(toApp, 'the site’s request to the app').toBeTruthy();
  expect(toApp?.headers.cookie).toBeUndefined();
  expect(toApp?.headers.origin).toBe(SITE);
  // The lobby sent no Referer to the site.
  expect(requests.find((r) => r.url === SITE_UI)?.headers.referer).toBeUndefined();
});

test('another site in the same frame window is never heard, and hears nothing', async ({ page }) => {
  await openExternal(page);
  await page.waitForFunction(() => Boolean((window as { __probe?: unknown }).__probe), undefined, { timeout: 30_000 });
  const before = (await page.evaluate(() => (window as unknown as { __actions: unknown[] }).__actions)).length;

  // The site sends its frame to another site that frame-src allows (another
  // plugin's approved UI): the iframe's window stays the same object.
  await siteFrame(page)!.evaluate((url) => {
    location.href = url;
  }, `${OTHER_SITE}/impostor`);
  await page.waitForFunction(
    (other) => (window as unknown as { __raw: Raw[] }).__raw.some((m) => m.origin === other && m.data?.type === 'ready'),
    OTHER_SITE,
    { timeout: 15_000 }
  );
  // The lobby keeps talking to the plugin — to the declared origin only.
  await page.evaluate(() =>
    (window as unknown as { __post: (m: unknown) => void }).__post({ lf: 1, type: 'state', state: { secret: true }, revision: 3 })
  );
  await page.waitForFunction(
    () => (window as unknown as { __raw: Raw[] }).__raw.some((m) => m.data && 'impostorReport' in m.data),
    undefined,
    { timeout: 15_000 }
  );

  const raw = await rawMessages(page);
  const fromImpostor = raw.filter((m) => m.origin === OTHER_SITE);
  console.info('[impostor]', JSON.stringify(fromImpostor));
  // Same window — so the source check alone would have let it in…
  expect(fromImpostor.length).toBeGreaterThanOrEqual(4);
  expect(fromImpostor.every((m) => m.fromFrame)).toBe(true);
  // …and the origin check kept every message out.
  const accepted = await page.evaluate(() => (window as unknown as { __accepted: Array<{ origin: string }> }).__accepted);
  expect(accepted.every((m) => m.origin === SITE)).toBe(true);
  const actions = await page.evaluate(() => (window as unknown as { __actions: Array<{ type: string }> }).__actions);
  expect(actions.length).toBe(before);
  expect(actions.some((a) => a.type === 'forged')).toBe(false);
  // Posted to the declared origin, nothing reached the other site.
  const report = fromImpostor.find((m) => m.data && 'impostorReport' in m.data)!.data!.impostorReport;
  expect(report).toEqual([]);
});

/** The ids a fixture site's `/ping` has seen. */
async function hits(page: Page, site: string): Promise<string[]> {
  return (await (await page.request.get(`${site}/hits`)).json()) as string[];
}

test('the frame cannot take itself to a site that was never approved', async ({ page }) => {
  const id = `nav-${Date.now()}`;
  const requests = recordRequests(page);
  await openExternal(page);
  await page.waitForFunction(() => Boolean((window as { __probe?: unknown }).__probe), undefined, { timeout: 30_000 });
  // ext-pending asked for this (live) site; the owner never approved it.
  await siteFrame(page)!.evaluate((url) => {
    location.href = url;
  }, `${PENDING_SITE}/ping?id=${id}`);
  await page.waitForTimeout(1500);
  const attempts = requests.filter((r) => r.url.startsWith(PENDING_SITE));
  console.info('[pending navigation]', JSON.stringify(attempts.map((r) => ({ url: r.url, failure: r.failure }))));
  for (const r of attempts) {
    expect(r.status, r.url).toBeUndefined();
    expect(r.failure, r.url).toMatch(/csp/i);
  }
  // The lobby's frame-src refused it: the site never saw the request.
  expect(await hits(page, PENDING_SITE)).not.toContain(id);
  expect(page.frames().some((f) => f.url().startsWith(PENDING_SITE))).toBe(false);
});

test('a plugin’s own files reach the approved API, and the policy refuses the one that was not approved', async ({ page }) => {
  const id = `run-${Date.now()}`;
  // The document's policy names the approved origin only, and is never cached.
  const doc = await page.request.get('/api/plugin-ui/net-probe/1.0.0/index.html', {
    headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
  });
  expect(doc.status()).toBe(200);
  const csp = doc.headers()['content-security-policy'] ?? '';
  expect(directive(csp, 'connect-src')).toBe(`connect-src http://localhost:${PORT}/api/plugin-ui/net-probe/1.0.0/ ${SITE}`);
  expect(csp).not.toContain(OTHER_SITE);
  expect(directive(csp, 'frame-src')).toBeUndefined();
  expect(csp).toContain('sandbox allow-scripts');
  expect(doc.headers()['cache-control']).toBe('no-cache');

  await openStandIn(page, {
    path: '/__lobby-stand-in-files',
    src: `/api/plugin-ui/net-probe/1.0.0/index.html?id=${id}`,
    sandbox: 'allow-scripts',
    declared: 'null',
    target: '*',
  });
  await page.waitForFunction(() => Boolean((window as { __probe?: unknown }).__probe), undefined, { timeout: 30_000 });
  const probe = await probeResults(page);
  console.info('[net probe]', JSON.stringify(probe));
  expect(probe.origin).toBe('null');
  expect(probe.approved).toBe('allowed');
  expect(probe.askedNotApproved).toBe('blocked');
  expect(probe.neverAsked).toBe('blocked');
  const violations = probe.violations as string[];
  expect(violations).toContain(`connect-src ${OTHER_SITE}/ping?id=${id}`);
  expect(violations).toContain(`connect-src ${PENDING_SITE}/ping?id=${id}`);
  expect(violations.some((v) => v.includes(`${SITE}/`))).toBe(false);

  // The approved request reached its server; the refused ones never left the browser.
  expect(await hits(page, SITE)).toContain(id);
  expect(await hits(page, OTHER_SITE)).not.toContain(id);
  expect(await hits(page, PENDING_SITE)).not.toContain(id);
});
