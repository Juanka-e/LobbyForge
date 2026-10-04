/**
 * Bot protection end to end (docs/CAPTCHA.md), in real browsers with
 * protection ON — ALTCHA by default, Cloudflare Turnstile with its
 * published test keys:
 *
 *   (a) open sign-up: the ALTCHA widget appears, solves, and the account is
 *       created; an API sign-up without a token gets `captcha_required`;
 *   (b) a new guest from /login and from /join/<code>, and the automatic
 *       guest of /room/<name>: "One quick check", closed and opened again,
 *       then completed — the guest joins voice from the lobby;
 *   (c) adaptive sign-in: three wrong passwords, the fourth attempt shows
 *       the challenge and signs in once solved; afterwards the same browser
 *       (its `lf_device` cookie) is never asked, even while the account is
 *       over the threshold for everyone else;
 *   (d) a solved token sent twice is `captcha_invalid`; a filled honeypot and
 *       a too-fast form are `form_rejected` (API and the real form);
 *   (e) Admin → Settings → Authentication → Bot protection: the privacy
 *       dialog, Turnstile test keys ("Test configuration" with a bad, the
 *       always-fail and the always-pass secret), a sign-up through the real
 *       Turnstile widget on a page reached by client-side navigation (the
 *       CSP of the first page must allow it), the always-fail secret
 *       refusing a sign-up, then back to ALTCHA through the card;
 *   (f) a signed-out visit to a settings page lands on /login?next=… and
 *       signing in returns there.
 *
 * Needs a compose stack (LF_E2E_BASE_URL) and, for the client-side
 * navigation part of (e), the official-mode web on the same database
 * (LF_E2E_OFFICIAL_URL). (e) needs internet access from the browser and
 * the web container (challenges.cloudflare.com); it changes the instance's
 * bot protection for about a minute and restores ALTCHA at the end, so run
 * this file on its own (`--workers=1`), not next to other specs.
 *
 * Screenshots — light and dark, 1280 and 390 px wide — of the widget, the
 * guest dialog and the admin card go to LF_E2E_SHOTS_DIR when set, else the
 * test's output directory. Signed-out pages always render dark (the theme
 * comes from the account's settings), so their light shots switch the same
 * theme classes the app sets for a light-theme account.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
  type TestInfo,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORM_MIN_FILL_MS,
  clearRateLimitBuckets,
  getAltchaChallenge,
  getCaptchaConfig,
  registerAccount,
  signIn,
  solveAltcha,
} from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const officialUrl = process.env.LF_E2E_OFFICIAL_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const shotsDir = process.env.LF_E2E_SHOTS_DIR ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const PASSWORD = 'correct-horse-battery-staple';

// Cloudflare Turnstile test keys (developers.cloudflare.com/turnstile/troubleshooting/testing/).
const TURNSTILE_SITE_KEY_PASS = '1x00000000000000000000AA';
const TURNSTILE_SECRET_PASS = '1x0000000000000000000000000000000AA';
const TURNSTILE_SECRET_FAIL = '2x0000000000000000000000000000000AA';
const TURNSTILE_SECRET_BOGUS = '0x4AAAAAAAlobbyforgeE2eNotARealSecretKey';

const DEFAULT_SURFACES = { register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive' };
const ALTCHA_DEFAULTS = { provider: 'altcha', surfaces: DEFAULT_SURFACES, siteKey: '', secretKey: null, options: {}, attackMode: false };
// Sign-in and sign-up stay per-address buckets (10 and 5 per 15 minutes) and every
// context here is one address: the UI flows below start from fresh ones.
const AUTH_BUCKETS = ['auth-local-login', 'auth-local-register'];
const freshSignUps = () => clearRateLimitBuckets(['auth-local-register']);
const freshSignIns = () => clearRateLimitBuckets(['auth-local-login']);

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
// In order, one worker; a failure does not skip the tests after it.
test.describe.configure({ mode: 'default', timeout: 180_000 });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

function shotPath(testInfo: TestInfo, name: string): string {
  if (!shotsDir) return testInfo.outputPath(name);
  mkdirSync(shotsDir, { recursive: true });
  return join(shotsDir, name);
}

/** The theme classes AppearanceRuntime sets for an account's theme (signed-out pages stay dark otherwise). */
async function forceTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => {
    const root = document.documentElement;
    root.classList.toggle('dark', value !== 'light');
    root.classList.toggle('lf-theme-dark', value === 'dark');
    root.classList.toggle('lf-theme-dim', false);
    root.classList.toggle('lf-theme-light', value === 'light');
  }, theme);
  // Surfaces fade with `transition-colors`.
  await page.waitForTimeout(500);
}

/**
 * Light and dark at 1280 and 390 px. `setTheme` switches the theme (the
 * signed-out class switch by default); `sections` shoots the viewport with
 * each scrolled to the top, otherwise the whole page.
 */
async function shootAll(
  page: Page,
  testInfo: TestInfo,
  name: string,
  {
    sections,
    setTheme = forceTheme,
  }: {
    /** Scroll each to the top and shoot the viewport (content inside a scrolling dialog). */
    sections?: () => Locator[];
    setTheme?: (page: Page, theme: 'light' | 'dark') => Promise<void>;
  } = {}
) {
  const original = page.viewportSize() ?? { width: 1280, height: 860 };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      const path = shotPath(testInfo, `${name}-${width}-${theme}.png`);
      if (sections) {
        let part = 0;
        for (const section of sections()) {
          part += 1;
          await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.replace(/\.png$/, `-${part}.png`) });
        }
      } else {
        await page.screenshot({ path, fullPage: true });
      }
    }
  }
  await setTheme(page, 'dark');
  await page.setViewportSize(original);
}

/**
 * Cloudflare's widget is up: its frame from challenges.cloudflare.com is loaded. (It renders
 * into a closed shadow root, so CSS cannot reach the iframe; the frame list can.)
 */
async function waitForTurnstile(page: Page) {
  await expect
    .poll(() => page.frames().some((frame) => frame.url().startsWith('https://challenges.cloudflare.com/')), {
      timeout: 30_000,
      message: 'the Turnstile frame loads',
    })
    .toBe(true);
}

type LoginExchange = { captchaToken?: string; status: number; error?: string };

/** Every POST to `path` from this page: what it sent (captcha fields) and what came back. */
function recordPosts(page: Page, path: string): LoginExchange[] {
  const list: LoginExchange[] = [];
  page.on('response', async (res) => {
    if (res.request().method() !== 'POST' || new URL(res.url()).pathname !== path) return;
    let error: string | undefined;
    try {
      error = ((await res.json()) as { error?: string }).error;
    } catch {
      /* not JSON */
    }
    const body = (res.request().postDataJSON() ?? {}) as { captchaToken?: string };
    list.push({ captchaToken: body.captchaToken, status: res.status(), error });
  });
  return list;
}

test.describe('bot protection (CAPTCHA)', () => {
  let browser: Browser;
  let owner: APIRequestContext;
  let serverId = '';
  const contexts: BrowserContext[] = [];
  const apis: APIRequestContext[] = [];
  let pwRequest: PlaywrightWorkerArgs['playwright']['request'];

  async function newApi(base = baseUrl): Promise<APIRequestContext> {
    const ctx = await pwRequest.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
    apis.push(ctx);
    return ctx;
  }

  async function newPage(base = baseUrl, options: { colorScheme?: 'dark' | 'light'; width?: number } = {}): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: base,
      locale: 'en-US',
      viewport: { width: options.width ?? 1280, height: 860 },
      colorScheme: options.colorScheme ?? 'dark',
      permissions: ['microphone', 'camera'],
    });
    contexts.push(ctx);
    return ctx.newPage();
  }

  /** A fresh account through the API (its own context: the browser under test stays signed out). */
  async function newAccount(seed: string): Promise<{ email: string; name: string }> {
    const email = `cap-${seed}-${RUN}@e2e.local`;
    const name = `Cap ${seed} ${RUN.slice(-4)}`;
    const api = await newApi();
    const res = await registerAccount(api, { data: { email, password: PASSWORD, displayName: name } });
    expect(res.status(), await res.text()).toBe(201);
    return { email, name };
  }

  async function putCaptcha(body: Record<string, unknown>) {
    const res = await owner.put('/api/admin/captcha', { data: body });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as { provider: string; secretSet: boolean; secretHint: string | null; siteKey: string | null };
  }

  test.beforeAll(async ({ playwright }) => {
    pwRequest = playwright.request;
    // Fake media for the voice step, and WITHOUT the config's
    // --disable-web-security (it drops the Origin header, which the CSRF
    // guard then refuses). Local Network Access checks off, as the config
    // does: the page on :19620 talks to LiveKit on another loopback port.
    browser = await playwright.chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
      ],
    });
    clearRateLimitBuckets(AUTH_BUCKETS);
    owner = await playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
    const setup = await owner.post('/api/setup/complete', {
      data: {
        setupToken,
        instanceName: 'Captcha E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await signIn(owner, { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    // Start from the documented defaults (an earlier run may have stopped half way).
    await putCaptcha(ALTCHA_DEFAULTS);
  });

  // The pages here come from our own browser, not the fixture: keep a picture of each on failure.
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    let index = 0;
    for (const ctx of contexts) {
      for (const page of ctx.pages()) {
        index += 1;
        await page.screenshot({ path: testInfo.outputPath(`failure-page-${index}.png`), fullPage: true }).catch(() => undefined);
      }
    }
  });

  test.afterAll(async () => {
    // Whatever happened above: back to ALTCHA with the defaults, no keys kept.
    if (owner) await owner.put('/api/admin/captcha', { data: ALTCHA_DEFAULTS }).catch(() => undefined);
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    for (const api of apis) await api.dispose().catch(() => undefined);
    await owner?.dispose();
    await browser?.close();
  });

  test('(a) open sign-up: the ALTCHA widget solves and the account is created; no token, no account', async ({}, testInfo) => {
    freshSignUps();
    const page = await newPage();
    const registers = recordPosts(page, '/api/auth/register');
    await page.goto('/login?mode=register');
    await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');

    const check = page.getByRole('group', { name: 'Security check' });
    await expect(check).toHaveAttribute('data-captcha-provider', 'altcha');
    const widget = check.locator('altcha-widget');
    await expect(widget).toBeVisible();
    // auto="onload": it solves as soon as it appears.
    await expect(widget.getByText('Verified')).toBeVisible({ timeout: 30_000 });
    await shootAll(page, testInfo, 'altcha-signup');

    const email = `cap-signup-${RUN}@e2e.local`;
    await page.getByLabel('Display name', { exact: true }).fill(`Cap Signup ${RUN.slice(-4)}`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/lobby(\?|$)/, { timeout: 20_000 });

    expect(registers).toHaveLength(1);
    expect(registers[0]!.status).toBe(201);
    expect(registers[0]!.captchaToken, 'the form sent the ALTCHA payload').toBeTruthy();
    // The account works: the lobby shows its session.
    const me = await page.request.get('/api/auth/guest');
    expect(me.status()).toBe(200);

    // The same sign-up straight to the API, without a token: refused before anything is written.
    const bot = await newApi();
    const refused = await bot.post('/api/auth/register', {
      data: { email: `cap-bot-${RUN}@e2e.local`, password: PASSWORD, displayName: 'Cap Bot' },
    });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual({ error: 'captcha_required' });
    expect((await bot.get('/api/auth/guest')).status(), 'no session for the refused sign-up').toBe(401);
  });

  test('(b1) a new guest from /login passes the check and joins voice from the lobby', async ({}, testInfo) => {
    const page = await newPage();
    const guests = recordPosts(page, '/api/auth/guest');
    await page.goto('/login');
    // The guest form's widget appears once the form is used.
    await expect(page.locator('altcha-widget')).toHaveCount(0);
    await page.getByLabel('Guest display name').fill(`Cap Guest ${RUN.slice(-4)}`);
    const widget = page.locator('altcha-widget');
    await expect(widget).toBeVisible();
    await expect(widget.getByText('Verified')).toBeVisible({ timeout: 30_000 });
    await shootAll(page, testInfo, 'altcha-guest-login');

    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await expect(page).toHaveURL(/\/lobby(\?|$)/, { timeout: 20_000 });
    await expect.poll(() => guests.length).toBeGreaterThanOrEqual(1);
    expect(guests.at(-1)!.status).toBe(200);
    expect(guests.at(-1)!.captchaToken).toBeTruthy();

    // A real guest: into a voice channel.
    const voice = page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
    await expect(voice).toBeVisible({ timeout: 20_000 });
    await voice.click();
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
  });

  test('(b4) pressing "Continue as guest" while the check is still solving waits for it', async () => {
    const page = await newPage();
    const guests = recordPosts(page, '/api/auth/guest');
    await page.goto('/login');
    await page.getByLabel('Guest display name').fill(`Cap Quick ${RUN.slice(-4)}`);
    // At once — the widget has only just appeared and is still verifying.
    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await expect(page, 'the form waits for the check and then signs in (no second press)').toHaveURL(/\/lobby(\?|$)/, {
      timeout: 20_000,
    });
    expect(guests.at(-1)!.status).toBe(200);
    expect(guests.at(-1)!.captchaToken).toBeTruthy();
  });

  test('(b2) a new guest from /join/<code>', async () => {
    const inviteRes = await owner.post(`/api/servers/${serverId}/invites`, { data: { maxUses: 5 } });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };

    const page = await newPage();
    const guests = recordPosts(page, '/api/auth/guest');
    await page.goto(`/join/${invite.code}`);
    await expect(page.getByRole('heading', { name: 'Join a server' })).toBeVisible();
    // No session yet: the check shows next to "Sign in as guest".
    const widget = page.locator('altcha-widget');
    await expect(widget).toBeVisible({ timeout: 15_000 });
    await expect(widget.getByText('Verified')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Sign in as guest' }).click();
    await expect(page.getByText(/^Signed in as /)).toBeVisible({ timeout: 20_000 });
    expect(guests.at(-1)!.status).toBe(200);
    expect(guests.at(-1)!.captchaToken).toBeTruthy();
    // Once signed in there is nothing left to check.
    await expect(widget).toHaveCount(0);

    await page.getByRole('button', { name: 'Accept invite' }).click();
    await expect(page.getByText(/^Joined /)).toBeVisible({ timeout: 15_000 });
  });

  test('(b3) the automatic guest of /room/<name>: "One quick check", closed, opened again, completed', async ({}, testInfo) => {
    const { channels } = (await (await owner.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string; name: string }>;
    };
    const voiceChannel = channels.find((c) => c.type === 'voice')!;
    const page = await newPage();
    const guests = recordPosts(page, '/api/auth/guest');
    await page.goto(`/room/${encodeURIComponent(voiceChannel.name)}?serverId=${serverId}&channelId=${voiceChannel.id}`);

    const dialog = page.getByRole('dialog', { name: 'One quick check' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText('Confirm you are not a bot to continue as a guest.')).toBeVisible();
    // The first contact was refused for the missing challenge — no guest yet.
    await expect.poll(() => guests.map((g) => g.error)).toContain('captcha_required');
    expect((await page.request.get('/api/auth/guest')).status()).toBe(401);
    await expect(dialog.locator('altcha-widget').getByText('Verified')).toBeVisible({ timeout: 30_000 });
    await shootAll(page, testInfo, 'guest-dialog');

    // Closing it leaves a way back — never a dead page.
    await dialog.getByRole('button', { name: /close/i }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Confirm you are not a bot to start your session.')).toBeVisible();
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('altcha-widget').getByText('Verified')).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog).toHaveCount(0, { timeout: 20_000 });

    const me = await page.request.get('/api/auth/guest');
    expect(me.status()).toBe(200);
    expect(guests.at(-1)!.status).toBe(200);
    expect(guests.at(-1)!.captchaToken).toBeTruthy();

    // A brand-new guest is not a member of the server yet (the room page
    // says so); the lobby lets it in, and then it joins voice.
    await page.goto(`/lobby?server=${serverId}`);
    const voice = page.getByRole('button', { name: voiceChannel.name }).filter({ has: page.locator('span', { hasText: 'volume_up' }) });
    await expect(voice.first()).toBeVisible({ timeout: 20_000 });
    await voice.first().click();
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
  });

  /** The sign-in form: fill and send, resolving with the route's answer. */
  function signInForm(page: Page, email: string) {
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    return {
      submit,
      attempt: async (password: string) => {
        await page.getByLabel('Email').fill(email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        const answered = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/auth/login'));
        await submit.click();
        return answered;
      },
    };
  }

  test('(c1) adaptive sign-in: after 3 wrong passwords the 4th attempt shows the check and signs in once solved', async ({}, testInfo) => {
    freshSignIns();
    const account = await newAccount('adaptive');
    const page = await newPage();
    const logins = recordPosts(page, '/api/auth/login');
    await page.goto('/login');
    const form = signInForm(page, account.email);

    for (let i = 1; i <= 3; i += 1) {
      const res = await form.attempt(`wrong-password-${i}`);
      expect(res.status(), `wrong password #${i}`).toBe(401);
      await expect(page.getByText('Invalid email or password.')).toBeVisible();
      // Adaptive: nothing to solve yet.
      await expect(page.locator('altcha-widget')).toHaveCount(0);
    }

    // Hold the solved retry a moment, so the challenge can be seen on screen.
    await page.route('**/api/auth/login', async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { captchaToken?: string };
      if (body.captchaToken) await sleep(3_000);
      await route.continue();
    });
    // ONE press with the right password: refused for the missing challenge,
    // the widget appears and solves, and the form sends again by itself.
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await form.submit.click();
    const widget = page.locator('altcha-widget');
    await expect(widget).toBeVisible({ timeout: 15_000 });
    await expect(widget.getByText('Verified')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: shotPath(testInfo, 'altcha-signin-challenge-1280-dark.png'), fullPage: true });
    await expect(page.getByText('Complete the security check to continue.'), 'no "incomplete" error once the widget is solving').toHaveCount(0);
    await expect(page, 'one press signs in once the challenge is solved').toHaveURL(/\/lobby(\?|$)/, { timeout: 30_000 });
    await page.unroute('**/api/auth/login');

    // The 4th attempt: refused for the missing challenge (not counted), then sent again solved.
    await expect.poll(() => logins.length).toBe(5);
    expect(logins.slice(0, 3).map((l) => l.status)).toEqual([401, 401, 401]);
    expect(logins.slice(0, 3).every((l) => !l.captchaToken)).toBe(true);
    expect(logins[3]).toMatchObject({ status: 400, error: 'captcha_required' });
    expect(logins[3]!.captchaToken).toBeFalsy();
    expect(logins[4]!.status).toBe(200);
    expect(logins[4]!.captchaToken).toBeTruthy();
  });

  test('(c2) adaptive sign-in: a browser holding the device cookie is never asked, even over the threshold', async () => {
    freshSignIns();
    const account = await newAccount('device');
    const page = await newPage();
    const logins = recordPosts(page, '/api/auth/login');
    const form = signInForm(page, account.email);

    // A first, clean sign-in in this browser leaves the device cookie.
    await page.goto('/login');
    expect((await form.attempt(PASSWORD)).status()).toBe(200);
    await expect(page).toHaveURL(/\/lobby(\?|$)/, { timeout: 20_000 });
    expect((await page.context().cookies()).some((c) => c.name === 'lf_device'), 'device cookie after sign-in').toBe(true);
    // Sign out: the session goes, the device cookie stays.
    expect((await page.request.post('/api/auth/logout', { headers: ORIGIN })).status()).toBe(200);
    expect((await page.context().cookies()).some((c) => c.name === 'lf_device')).toBe(true);

    // Three wrong passwords from SOMEWHERE ELSE put the account over the threshold…
    const elsewhere = await newApi();
    for (let i = 1; i <= 3; i += 1) {
      const res = await elsewhere.post('/api/auth/login', { data: { email: account.email, password: `elsewhere-wrong-${i}` } });
      expect(res.status()).toBe(401);
    }
    // …where even the right password now needs the challenge.
    const control = await elsewhere.post('/api/auth/login', { data: { email: account.email, password: PASSWORD } });
    expect(control.status()).toBe(400);
    expect(await control.json()).toEqual({ error: 'captcha_required' });

    // This browser: wrong, then right — never asked.
    const before = logins.length;
    await page.goto('/login');
    expect((await form.attempt('device-wrong')).status()).toBe(401);
    await expect(page.getByText('Invalid email or password.')).toBeVisible();
    await expect(page.locator('altcha-widget')).toHaveCount(0);
    expect((await form.attempt(PASSWORD)).status()).toBe(200);
    await expect(page).toHaveURL(/\/lobby(\?|$)/, { timeout: 20_000 });
    await expect.poll(() => logins.length - before).toBe(2);
    const deviceRun = logins.slice(before);
    expect(deviceRun.map((l) => l.status)).toEqual([401, 200]);
    expect(deviceRun.every((l) => !l.captchaToken && l.error !== 'captcha_required')).toBe(true);
    await expect(page.locator('altcha-widget')).toHaveCount(0);
  });


  test('(d) replay, honeypot and too-fast submit are refused', async () => {
    freshSignUps();
    // One solved challenge for a new guest…
    const first = await newApi();
    const config = await getCaptchaConfig(first, 'guest');
    const challenge = await getAltchaChallenge(first, 'guest');
    const token = await solveAltcha(challenge);
    await sleep(FORM_MIN_FILL_MS);
    const ok = await first.post('/api/auth/guest', { data: { captchaToken: token, captchaProvider: 'altcha', formToken: config.formToken } });
    expect(ok.status(), await ok.text()).toBe(200);

    // …sent again from another browser with its own fresh form: used up.
    const replayer = await newApi();
    const replayConfig = await getCaptchaConfig(replayer, 'guest');
    await sleep(FORM_MIN_FILL_MS);
    const replay = await replayer.post('/api/auth/guest', {
      data: { captchaToken: token, captchaProvider: 'altcha', formToken: replayConfig.formToken },
    });
    expect(replay.status()).toBe(400);
    expect(await replay.json()).toEqual({ error: 'captcha_invalid' });
    expect((await replayer.get('/api/auth/guest')).status()).toBe(401);

    // The honeypot filled, everything else valid.
    const filler = await newApi();
    const fillerConfig = await getCaptchaConfig(filler, 'guest');
    const fillerToken = await solveAltcha(await getAltchaChallenge(filler, 'guest'));
    await sleep(FORM_MIN_FILL_MS);
    const honeypot = await filler.post('/api/auth/guest', {
      data: { captchaToken: fillerToken, captchaProvider: 'altcha', formToken: fillerConfig.formToken, website: 'https://spam.example' },
    });
    expect(honeypot.status()).toBe(400);
    expect(await honeypot.json()).toEqual({ error: 'form_rejected' });

    // Too fast: a solved token, but the form is a few milliseconds old.
    const rusher = await newApi();
    const rushToken = await solveAltcha(await getAltchaChallenge(rusher, 'guest'));
    const rushConfig = await getCaptchaConfig(rusher, 'guest');
    const rushed = await rusher.post('/api/auth/guest', {
      data: { captchaToken: rushToken, captchaProvider: 'altcha', formToken: rushConfig.formToken },
    });
    expect(rushed.status()).toBe(400);
    expect(await rushed.json()).toEqual({ error: 'form_rejected' });

    // A forged form token is refused the same way.
    const forger = await newApi();
    const forgedToken = await solveAltcha(await getAltchaChallenge(forger, 'guest'));
    const forged = await forger.post('/api/auth/guest', {
      data: { captchaToken: forgedToken, captchaProvider: 'altcha', formToken: `${Date.now() - 10_000}.guest.forged` },
    });
    expect(forged.status()).toBe(400);
    expect(await forged.json()).toEqual({ error: 'form_rejected' });

    // The real form with its hidden honeypot filled (as a form-filling bot would).
    const page = await newPage();
    const registers = recordPosts(page, '/api/auth/register');
    await page.goto('/login?mode=register');
    await expect(page.locator('altcha-widget').getByText('Verified')).toBeVisible({ timeout: 30_000 });
    await page.locator('input[name="website"]').first().fill('https://spam.example', { force: true });
    await page.getByLabel('Display name', { exact: true }).fill('Cap Honeypot');
    await page.getByLabel('Email').fill(`cap-honeypot-${RUN}@e2e.local`);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Something went wrong, try again.')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
    expect(registers.at(-1)).toMatchObject({ status: 400, error: 'form_rejected' });
  });

  test('(e) admin card: privacy dialog, Turnstile test keys, a real Turnstile sign-up, then back to ALTCHA', async ({}, testInfo) => {
    test.setTimeout(300_000);
    freshSignUps(); // three sign-ups through the real widget below
    freshSignIns();
    const cloudflare = await owner.get('https://challenges.cloudflare.com/turnstile/v0/api.js', { maxRedirects: 0 }).catch(() => null);
    test.skip(!cloudflare, 'challenges.cloudflare.com is not reachable from here.');

    const adminPage = await newPage();
    // The owner's session in the browser.
    const login = await signIn(adminPage.context().request, { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    expect(login.status()).toBe(200);
    const setAccountTheme = async (page: Page, theme: 'light' | 'dark') => {
      expect((await page.context().request.patch('/api/settings/me', { headers: ORIGIN, data: { theme } })).status()).toBe(200);
      await page.reload();
      await expect(page.locator('html')).toHaveClass(theme === 'light' ? /lf-theme-light/ : /lf-theme-dark/);
      await page.waitForTimeout(500);
    };
    // The card is long and sits in the settings dialog's scroll area: shoot it in three parts.
    const cardSections = () => {
      const region = adminPage.getByRole('region', { name: 'Bot protection' });
      return [
        region.getByRole('heading', { name: 'Bot protection' }),
        region.getByText('Where to ask', { exact: true }).first(),
        region.getByRole('button', { name: 'Test configuration' }),
      ];
    };
    try {
      await adminPage.goto('/admin/settings/authentication');
      const card = adminPage.getByRole('region', { name: 'Bot protection' });
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByRole('radio', { name: /^ALTCHA \(built in\)/ })).toBeChecked();
      await shootAll(adminPage, testInfo, 'admin-card-altcha', { sections: cardSections, setTheme: setAccountTheme });

      // Choosing an external provider explains the data transfer first.
      // .click(), not .check(): the radio only turns on once the dialog is confirmed.
      await card.getByRole('radio', { name: /^Cloudflare Turnstile/ }).click();
      const privacy = adminPage.getByRole('dialog', { name: 'Before you switch to Cloudflare Turnstile' });
      await expect(privacy).toBeVisible();
      await expect(privacy.getByText(/we use Cloudflare Turnstile, a service of Cloudflare, Inc\./)).toBeVisible();
      await shootAll(adminPage, testInfo, 'admin-privacy-dialog', { setTheme: forceTheme });
      await privacy.getByRole('button', { name: 'Use Cloudflare Turnstile' }).click();
      await expect(privacy).toHaveCount(0);
      await expect(card.getByRole('radio', { name: /^Cloudflare Turnstile/ })).toBeChecked();

      // Test configuration: a bad secret, the always-fail and the always-pass test secrets.
      await card.getByLabel('Site key').fill(TURNSTILE_SITE_KEY_PASS);
      const secret = card.getByLabel('Secret key');
      const testButton = card.getByRole('button', { name: 'Test configuration' });
      const runTest = async (value: string) => {
        await secret.fill(value);
        const answered = adminPage.waitForResponse((r) => r.url().endsWith('/api/admin/captcha/test'));
        await testButton.click();
        const res = await answered;
        expect(res.status()).toBe(200);
        return ((await res.json()) as { result: string; detail?: string });
      };
      expect((await runTest(TURNSTILE_SECRET_BOGUS)).result).toBe('bad_secret');
      await expect(card.getByText('The provider refused the secret key.')).toBeVisible();
      const failing = await runTest(TURNSTILE_SECRET_FAIL);
      testInfo.annotations.push({ type: 'always-fail secret test result', description: JSON.stringify(failing) });
      expect(failing.result, 'the always-fail secret is a valid secret: reachable').toBe('ok');
      const passing = await runTest(TURNSTILE_SECRET_PASS);
      expect(passing.result).toBe('ok');
      await expect(card.getByText('Reachable, and the keys work.')).toBeVisible();

      // Always visible, so the widget can be seen (and photographed).
      await card.getByRole('radio', { name: 'Always visible' }).check();
      // Another process (the official web, same database) caches the settings
      // for 5 s: prime it with the old provider just before the save, then
      // time how soon its pages carry Turnstile (lib/captcha/csp.ts: past the
      // TTL, the first page refreshes, capped at 300 ms, before it goes out).
      // Compare whole CSP source tokens, not a substring of the header.
      const otherCsp = async () =>
        ((await owner.get(`${officialUrl}/landing`, { maxRedirects: 0 })).headers()['content-security-policy'] ?? '')
          .split(/[\s;]+/)
          .includes('https://challenges.cloudflare.com');
      if (officialUrl) expect(await otherCsp(), 'the official process still on ALTCHA before the save').toBe(false);
      await card.getByRole('button', { name: 'Save bot protection' }).click();
      await expect(card.getByText('Bot protection saved.')).toBeVisible();
      if (officialUrl) {
        const savedAt = Date.now();
        const samples: string[] = [];
        let caughtUpAt = -1;
        while (Date.now() - savedAt < 9_000) {
          const has = await otherCsp();
          samples.push(`${Date.now() - savedAt}ms:${has ? 'turnstile' : 'altcha'}`);
          if (has) {
            caughtUpAt = Date.now() - savedAt;
            break;
          }
          await sleep(1_000);
        }
        console.info(`[captcha] official process CSP after the save: ${samples.join(' ')}`);
        testInfo.annotations.push({ type: 'official CSP catch-up', description: samples.join(' ') });
        expect(caughtUpAt, 'the first page after the 5 s TTL carries the new provider').toBeGreaterThanOrEqual(0);
        expect(caughtUpAt).toBeLessThan(7_000);
      }
      const saved =(await (await owner.get('/api/admin/captcha')).json()) as {
        provider: string;
        siteKey: string;
        secretSet: boolean;
        secretHint: string;
        options: { turnstileAppearance: string };
      };
      expect(saved).toMatchObject({ provider: 'turnstile', siteKey: TURNSTILE_SITE_KEY_PASS, secretSet: true, options: { turnstileAppearance: 'always' } });
      expect(JSON.stringify(saved), 'the secret never comes back').not.toContain(TURNSTILE_SECRET_PASS);
      await shootAll(adminPage, testInfo, 'admin-card-turnstile', { sections: cardSections, setTheme: setAccountTheme });

      // The public config names Turnstile, and every page's CSP allows it.
      const publicConfig = await getCaptchaConfig(owner, 'register');
      expect(publicConfig).toMatchObject({ provider: 'turnstile', siteKey: TURNSTILE_SITE_KEY_PASS, required: true });
      const loginDoc = await owner.get('/login');
      expect(loginDoc.headers()['content-security-policy'] ?? '').toContain('https://challenges.cloudflare.com');

      // A sign-up through the real Turnstile widget (self-hosted /login).
      const signup = await newPage();
      const registers = recordPosts(signup, '/api/auth/register');
      await signup.goto('/login?mode=register');
      const check = signup.getByRole('group', { name: 'Security check' });
      await expect(check).toHaveAttribute('data-captcha-provider', 'turnstile', { timeout: 15_000 });
      await waitForTurnstile(signup);
      await signup.waitForTimeout(3_000); // the test key passes within a second or two
      await shootAll(signup, testInfo, 'turnstile-signup');
      await signup.getByLabel('Display name', { exact: true }).fill(`Cap Turnstile ${RUN.slice(-4)}`);
      await signup.getByLabel('Email').fill(`cap-turnstile-${RUN}@e2e.local`);
      await signup.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await signup.getByRole('button', { name: 'Create account' }).click();
      await expect(signup).toHaveURL(/\/lobby(\?|$)/, { timeout: 30_000 });
      expect(registers.at(-1)!.status).toBe(201);
      expect(registers.at(-1)!.captchaToken, 'Cloudflare test sitekey token').toBe('XXXX.DUMMY.TOKEN.XXXX');

      // Client-side navigation: the hub landing (official mode, same
      // database) → "Get started" → sign-up without a new document. The
      // CSP of /landing must already allow Cloudflare.
      if (officialUrl) {
        const hub = await newPage(officialUrl);
        await hub.addInitScript(() => {
          (window as unknown as { __csp: string[] }).__csp = [];
          document.addEventListener('securitypolicyviolation', (event) => {
            (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
          });
        });
        const landing = await hub.goto('/landing');
        expect(landing?.headers()['content-security-policy'] ?? '').toContain('https://challenges.cloudflare.com');
        await hub.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
        await hub.getByRole('link', { name: 'Get started' }).first().click();
        await expect(hub.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible({ timeout: 20_000 });
        expect(await hub.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), 'reached by client-side navigation').toBe(true);
        const hubCheck = hub.getByRole('group', { name: 'Security check' });
        await expect(hubCheck).toHaveAttribute('data-captcha-provider', 'turnstile', { timeout: 15_000 });
        await waitForTurnstile(hub);
        const hubName = `Cap Hub ${RUN.slice(-4)}`;
        const hubRegisters = recordPosts(hub, '/api/auth/register');
        await hub.getByLabel('Display name', { exact: true }).fill(hubName);
        await hub.getByLabel('Email').fill(`cap-hub-${RUN}@e2e.local`);
        await hub.getByLabel('Password', { exact: true }).fill(PASSWORD);
        await hub.getByRole('checkbox', { name: /I agree/ }).check();
        await hub.getByRole('button', { name: 'Create account' }).click();
        await expect(hub.getByRole('heading', { level: 1 })).toContainText(hubName, { timeout: 30_000 });
        expect(hubRegisters.at(-1)!.status).toBe(201);
        expect(hubRegisters.at(-1)!.captchaToken).toBe('XXXX.DUMMY.TOKEN.XXXX');
        expect(await hub.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
      } else {
        testInfo.annotations.push({ type: 'skipped', description: 'client-side navigation check: LF_E2E_OFFICIAL_URL not set' });
      }

      // The always-fail secret: the widget passes in the browser, the server's siteverify refuses.
      await putCaptcha({
        provider: 'turnstile',
        surfaces: DEFAULT_SURFACES,
        siteKey: TURNSTILE_SITE_KEY_PASS,
        secretKey: TURNSTILE_SECRET_FAIL,
        options: { turnstileAppearance: 'always' },
        attackMode: false,
      });
      const refusedPage = await newPage();
      const refusedRegisters = recordPosts(refusedPage, '/api/auth/register');
      await refusedPage.goto('/login?mode=register');
      await waitForTurnstile(refusedPage);
      await refusedPage.waitForTimeout(3_000);
      await refusedPage.getByLabel('Display name', { exact: true }).fill('Cap Refused');
      await refusedPage.getByLabel('Email').fill(`cap-refused-${RUN}@e2e.local`);
      await refusedPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await refusedPage.getByRole('button', { name: 'Create account' }).click();
      await expect(refusedPage.getByText('Verification failed, try again.')).toBeVisible({ timeout: 20_000 });
      await expect(refusedPage).toHaveURL(/\/login/);
      expect(refusedRegisters.at(-1)).toMatchObject({ status: 400, error: 'captcha_invalid' });

      // Back to ALTCHA through the card.
      await adminPage.reload();
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.getByRole('radio', { name: /^ALTCHA \(built in\)/ }).check();
      // No privacy dialog for the built-in provider (the settings page itself is a dialog).
      await expect(adminPage.getByRole('dialog', { name: /^Before you switch to/ })).toHaveCount(0);
      await card.getByRole('button', { name: 'Save bot protection' }).click();
      await expect(card.getByText('Bot protection saved.')).toBeVisible();
      const restored = (await (await owner.get('/api/admin/captcha')).json()) as { provider: string };
      expect(restored.provider).toBe('altcha');
      expect((await getCaptchaConfig(owner, 'register')).provider).toBe('altcha');
      expect((await owner.get('/login')).headers()['content-security-policy'] ?? '').not.toContain('challenges.cloudflare.com');
    } finally {
      await adminPage.context().request.patch('/api/settings/me', { headers: ORIGIN, data: { theme: 'dark' } }).catch(() => undefined);
      await putCaptcha(ALTCHA_DEFAULTS);
    }
  });

  test('(f) a signed-out visit to settings goes to /login?next=… and comes back after signing in', async () => {
    freshSignIns();
    const account = await newAccount('settings');
    const page = await newPage();
    for (const path of ['/settings/appearance', '/settings/notifications', '/settings/voice-video']) {
      await page.goto(path);
      await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('next') === path);
    }
    await page.goto('/settings');
    await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('next') === '/settings');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings', { timeout: 20_000 });
    await expect(page.getByRole('dialog', { name: 'User Settings' })).toBeVisible();
  });
});
