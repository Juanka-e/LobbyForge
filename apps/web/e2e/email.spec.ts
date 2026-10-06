/**
 * Email end to end (docs/EMAIL.md): mail through the e2e stack's Mailpit
 * (infra/docker/docker-compose.e2e-mail.yml), in real browsers with several
 * accounts at once, reading every email through Mailpit's HTTP API.
 *
 *   (a) Admin → Settings → Email: the Mailpit preset (mailpit:1025 in a
 *       production build), saved; "Required" stays disabled until a test of
 *       the SAVED settings passes; the test email arrives; then Optional;
 *  (a2) the saved SMTP password never follows the connection elsewhere: a
 *       new provider, host or user name needs it typed again (save and test,
 *       400 `password_required`);
 *   (b) a sign-up gets the verification email; the 6-digit code typed into
 *       the lobby banner verifies it and the banner goes away;
 *   (c) the link opened in another (signed-out) browser: the GET only shows
 *       a button, the button's POST verifies, and the first tab unlocks when
 *       it gets focus again — without a reload;
 *   (d) Required: a new account is restricted (messages, voice, invites, an
 *       avatar upload, a join-request note) with the friendly notices and
 *       disabled controls, and everything works once it verifies; an account
 *       from before enforcement, an invite sign-up (out of the default scope)
 *       and the owner are never restricted; mail cannot be switched off
 *       while Required (409 `transport_required`);
 *   (e) change email: the current password is required, the code goes to the
 *       new address, a notice to the old one, the other sessions end;
 *   (f) forgot → reset by link and by code, every session ends, and an
 *       unknown address gets exactly the same answer; a failed code is
 *       always `invalid_code`;
 *  (f2) the forgot form sends a second request after "Use a different
 *       address" (a fresh formToken);
 *   (g) the disposable-domain block (sign-up and email change), and the
 *       admin's allow list on top of it; (g2) the sign-up form says why in
 *       words, and for a taken address too;
 *   (h) the resend cooldown and the code-attempt limits (5 per code, 10 per
 *       account); the link still works after the code is dead;
 *   (i) no mail: forgot says "ask your administrator", and sign-up, sign-in,
 *       chat and an (immediate) email change still work.
 *
 * Needs the compose stack (LF_E2E_BASE_URL) with the mail overlay, Mailpit's
 * API (LF_E2E_MAILPIT_URL, default http://localhost:19626) and the SMTP host
 * the web container reaches it at (LF_E2E_SMTP_HOST / LF_E2E_SMTP_PORT,
 * default mailpit:1025). It changes the instance's email settings and puts
 * back what it found at the end (by default: no email, verification off),
 * so run it on its own (`--workers=1`).
 *
 * Screenshots — light and dark, 1280 and 390 px — of the lobby banner, the
 * restricted lobby, the admin Email screen, /verify-email, /forgot-password
 * and /reset-password go to LF_E2E_SHOTS_DIR when set, else the test's
 * output directory.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
  type TestInfo,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { registerAccount, requestPasswordReset, resetRateLimits, signIn } from './helpers/auth';
import { Mailpit, codeOf, linkOf } from './helpers/mailpit';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const shotsDir = process.env.LF_E2E_SHOTS_DIR ?? '';
const SMTP_HOST = process.env.LF_E2E_SMTP_HOST ?? 'mailpit';
const SMTP_PORT = Number(process.env.LF_E2E_SMTP_PORT ?? '1025');
const POSTGRES_CONTAINER = process.env.LF_E2E_POSTGRES_CONTAINER ?? 'lobbyforge-e2e-postgres';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-brand-new-password-2026';
// Per run: the last test counts while the configuration in force has its fingerprint
// (EMAIL.md §5), so an identical From would revive an earlier run's test in (a).
const FROM = `LobbyForge E2E ${RUN.slice(-5)} <no-reply@e2e.local>`;
const DISPOSABLE_DOMAIN = 'mailinator.com';

const SUBJECT = {
  verify: /^Verify your email address$/,
  changeConfirm: /^Confirm your new email address$/,
  changeNotice: /^Your email address was changed$/,
  reset: /^Reset your password$/,
  test: /^Test email from /,
};

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
// In order, one worker; a failure does not skip the tests after it.
test.describe.configure({ mode: 'default', timeout: 180_000 });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ── The instance's mail settings (GET/PUT /api/admin/mail) ─────────────

type Mode = 'off' | 'optional' | 'required';

interface AdminMail {
  provider: string;
  region: string | null;
  host: string | null;
  port: number | null;
  security: string | null;
  username: string | null;
  passwordSet: boolean;
  from: string | null;
  dailyLimit: number | null;
  lastTest: { at: string | null; result: string | null };
  verification: {
    mode: Mode;
    scope: { open_register: boolean; invite_register: boolean };
    enforcedSince: string | null;
    existingDeadline: string | null;
  };
  disposable: { block: boolean; allow: string[]; blockExtra: string[] };
}

type MailPatch = Partial<Omit<AdminMail, 'verification' | 'lastTest' | 'passwordSet' | 'disposable'>> & {
  /** A password to set, null to clear; left out: keep the saved one. */
  password?: string | null;
  verification?: Partial<Omit<AdminMail['verification'], 'enforcedSince'>>;
  disposable?: Partial<AdminMail['disposable']>;
};

/** The PUT body for `current` with `patch` on top (the PUT takes the whole shape). */
function putBody(current: AdminMail, patch: MailPatch): Record<string, unknown> {
  const verification = { ...current.verification, ...patch.verification };
  return {
    provider: patch.provider ?? current.provider,
    region: 'region' in patch ? patch.region : current.region,
    host: 'host' in patch ? patch.host : current.host,
    port: 'port' in patch ? patch.port : current.port,
    security: 'security' in patch ? patch.security : current.security,
    username: 'username' in patch ? patch.username : current.username,
    from: 'from' in patch ? patch.from : current.from,
    dailyLimit: 'dailyLimit' in patch ? patch.dailyLimit : current.dailyLimit,
    ...('password' in patch ? { password: patch.password } : {}),
    verification: { mode: verification.mode, scope: verification.scope, existingDeadline: verification.existingDeadline },
    disposable: { ...current.disposable, ...patch.disposable },
  };
}

// ── Pictures ────────────────────────────────────────────────────────────

function shotPath(testInfo: TestInfo, name: string): string {
  if (!shotsDir) return testInfo.outputPath(name);
  mkdirSync(shotsDir, { recursive: true });
  return join(shotsDir, name);
}

/** The theme classes AppearanceRuntime sets (signed-out pages render dark otherwise). */
async function forceTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => {
    const root = document.documentElement;
    root.classList.toggle('dark', value !== 'light');
    root.classList.toggle('lf-theme-dark', value === 'dark');
    root.classList.toggle('lf-theme-dim', false);
    root.classList.toggle('lf-theme-light', value === 'light');
  }, theme);
  await page.waitForTimeout(500);
}

/** A signed-in page: the account's own theme setting, then a reload. */
async function setAccountTheme(page: Page, theme: 'light' | 'dark') {
  const res = await page.context().request.patch('/api/settings/me', { headers: ORIGIN, data: { theme } });
  expect(res.status(), await res.text()).toBe(200);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(theme === 'light' ? /lf-theme-light/ : /lf-theme-dark/);
  await page.waitForTimeout(600);
}

/**
 * Light and dark at 1280 and 390 px. `sections`: scroll each into view and
 * shoot the viewport (content in a scrolling column); otherwise the page.
 */
async function shootAll(
  page: Page,
  testInfo: TestInfo,
  name: string,
  {
    setTheme = forceTheme,
    sections,
    ready,
  }: {
    setTheme?: (page: Page, theme: 'light' | 'dark') => Promise<void>;
    sections?: () => Locator[];
    /** Wait for the state to be on screen again (after a reload). */
    ready?: () => Promise<void>;
  } = {}
) {
  const original = page.viewportSize() ?? { width: 1280, height: 860 };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(page, theme);
      if (ready) await ready();
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
  if (ready) await ready();
  await page.setViewportSize(original);
}

// ── Small things ───────────────────────────────────────────────────────

/** A 256×256 PNG (the avatar minimum), as a data URL. */
function avatarDataUrl(): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const size = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) row.set([0x3d, 0x7a, 0xb8], 1 + x * 3);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function psql(sql: string): string {
  return execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', 'lobbyforge', '-d', 'lobbyforge', '-Atc', sql], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim();
}

async function errorOf(res: { json(): Promise<unknown> }): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

interface EmailStatus {
  email: string | null;
  verified: boolean;
  mode: Mode;
  restricted: boolean;
  pendingChange: string | null;
  resendAvailableAt: string | null;
  mailConfigured: boolean;
}

async function emailStatus(api: APIRequestContext): Promise<EmailStatus> {
  const res = await api.get('/api/auth/email/status');
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as EmailStatus;
}

/**
 * Wait for the bot-protection widget, when the surface shows one, to finish
 * (it renders once the surface's config has loaded — give it a moment).
 */
async function captchaSolved(scope: Page | Locator) {
  const widget = scope.locator('altcha-widget');
  const shown = await widget
    .first()
    .waitFor({ state: 'attached', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (shown) await expect(widget.getByText('Verified')).toBeVisible({ timeout: 30_000 });
}

/** The form's own alert (not Next's empty route announcer). */
const formAlert = (page: Page) => page.getByRole('alert').filter({ hasText: /\S/ });

test.describe('email: providers, verification, change and reset', () => {
  let browser: Browser;
  let owner: APIRequestContext;
  let mailpit: Mailpit;
  let original: AdminMail | null = null;
  let serverId = '';
  let textChannelId = '';
  let voiceChannelId = '';
  const contexts: BrowserContext[] = [];
  const apis: APIRequestContext[] = [];
  const addresses: string[] = [];
  let pwRequest: PlaywrightWorkerArgs['playwright']['request'];

  const address = (seed: string, domain = 'e2e.local') => {
    const value = `mail-${seed}-${RUN}@${domain}`;
    addresses.push(value);
    return value;
  };

  async function newApi(): Promise<APIRequestContext> {
    const ctx = await pwRequest.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
    apis.push(ctx);
    return ctx;
  }

  async function newPage(options: { width?: number } = {}): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: baseUrl,
      locale: 'en-US',
      viewport: { width: options.width ?? 1280, height: 860 },
      colorScheme: 'dark',
      permissions: ['microphone', 'camera'],
    });
    contexts.push(ctx);
    return ctx.newPage();
  }

  async function ownerPage(): Promise<Page> {
    const page = await newPage();
    const login = await signIn(page.context().request, { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    expect(login.status(), 'owner sign-in').toBe(200);
    return page;
  }

  async function mailSettings(): Promise<AdminMail> {
    const res = await owner.get('/api/admin/mail');
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as AdminMail;
  }

  async function putMail(patch: MailPatch): Promise<AdminMail> {
    const res = await owner.put('/api/admin/mail', { data: putBody(await mailSettings(), patch) });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as AdminMail;
  }

  /**
   * Mail through Mailpit with a passing test of the saved settings, and the
   * given verification mode — set up through the API, so each test stands
   * on its own ((a) does the same through the admin screen).
   */
  async function ensureMail(mode: Mode = 'optional') {
    let current = await mailSettings();
    const connected =
      current.provider === 'mailpit' &&
      current.host === SMTP_HOST &&
      current.port === SMTP_PORT &&
      current.security === 'none' &&
      current.username === null &&
      !current.passwordSet &&
      current.from === FROM;
    if (!connected) {
      current = await putMail({
        provider: 'mailpit',
        region: null,
        host: SMTP_HOST,
        port: SMTP_PORT,
        security: 'none',
        username: null,
        password: null,
        from: FROM,
        verification: { mode: current.verification.mode === 'required' ? 'optional' : current.verification.mode },
      });
    }
    if (current.lastTest.result !== 'ok') {
      const res = await owner.post('/api/admin/mail/test', { data: {} });
      expect(await res.json(), 'a test of the saved settings').toEqual({ result: 'ok' });
    }
    current = await mailSettings();
    if (current.verification.mode !== mode || current.disposable.block) {
      await putMail({ verification: { mode }, disposable: { block: false, allow: [], blockExtra: [] } });
    }
  }

  /** A new account through the API in `api` (a browser context's request shares its cookies). */
  async function apiAccount(api: APIRequestContext, seed: string, domain?: string) {
    const email = address(seed, domain);
    const name = `Mail ${seed} ${RUN.slice(-4)}`;
    const res = await registerAccount(api, { headers: ORIGIN, data: { email, password: PASSWORD, displayName: name } });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { user?: { id?: string }; verificationEmailSent?: boolean };
    const me = (await (await api.get('/api/auth/guest')).json()) as { guest: { uid: string } };
    return { email, name, uid: me.guest.uid, verificationEmailSent: body.verificationEmailSent === true };
  }

  /** The sign-up form, as a person fills it in. Returns the register answer. */
  async function signUpInBrowser(page: Page, seed: string): Promise<{ email: string; name: string; body: Record<string, unknown> }> {
    const email = address(seed);
    const name = `Mail ${seed} ${RUN.slice(-4)}`;
    await page.goto('/login?mode=register');
    await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
    await captchaSolved(page);
    await page.getByLabel('Display name', { exact: true }).fill(name);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/register');
    await page.getByRole('button', { name: 'Create account' }).click();
    const res = await answered;
    expect(res.status(), await res.text()).toBe(201);
    await expect(page).toHaveURL(/\/lobby(\?|$)/, { timeout: 20_000 });
    return { email, name, body: (await res.json()) as Record<string, unknown> };
  }

  const banner = (page: Page) => page.locator('[data-email-banner="lobby"]');

  test.beforeAll(async ({ playwright }) => {
    pwRequest = playwright.request;
    browser = await playwright.chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
      ],
    });
    mailpit = await Mailpit.connect();
    expect(await mailpit.reachable(), 'Mailpit answers (infra/docker/docker-compose.e2e-mail.yml)').toBe(true);
    resetRateLimits();
    owner = await playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
    const setup = await owner.post('/api/setup/complete', {
      data: {
        setupToken,
        instanceName: 'Email E2E',
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
      expect(login.status(), 'owner sign-in on a warm stack').toBe(200);
    }
    original = await mailSettings();
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    const { channels } = (await (await owner.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    textChannelId = channels.find((c) => c.type === 'text')!.id;
    voiceChannelId = channels.find((c) => c.type === 'voice')!.id;
    // Start from no email and verification off (an earlier run may have stopped half way).
    await putMail({
      provider: 'none',
      region: null,
      host: null,
      port: null,
      security: null,
      username: null,
      from: null,
      dailyLimit: null,
      verification: { mode: 'off', scope: { open_register: true, invite_register: false }, existingDeadline: null },
      disposable: { block: false, allow: [], blockExtra: [] },
    });
  });

  test.beforeEach(() => {
    // Every context here is the same client address: a fresh window per test.
    resetRateLimits();
  });

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
    // Put back what we found (by default: no email, verification off).
    if (owner && original) {
      const current = await mailSettings().catch(() => null);
      if (current) {
        const back = putBody(current, {
          provider: original.provider,
          region: original.region,
          host: original.host,
          port: original.port,
          security: original.security,
          username: original.username,
          from: original.from,
          dailyLimit: original.dailyLimit,
          // `required` needs a passing test of the restored settings: settle for optional.
          verification: {
            mode: original.verification.mode === 'required' ? 'optional' : original.verification.mode,
            scope: original.verification.scope,
            existingDeadline: original.verification.existingDeadline,
          },
          disposable: original.disposable,
        });
        const res = await owner.put('/api/admin/mail', { data: back }).catch(() => null);
        if (res && res.status() !== 200) console.warn(`[email.spec] restoring the mail settings: HTTP ${res.status()} ${await res.text()}`);
      }
    }
    await mailpit?.deleteFor(addresses).catch(() => undefined);
    await mailpit?.dispose();
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    for (const api of apis) await api.dispose().catch(() => undefined);
    await owner?.dispose();
    await browser?.close();
  });

  test('(a) admin: the Mailpit preset, test email, Required only after a passing test, then Optional', async ({}, testInfo) => {
    const page = await ownerPage();
    await page.goto('/admin/settings/email');
    const card = page.getByRole('region', { name: 'Mail and verification' });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('radio', { name: /^No email/ })).toBeChecked();
    const required = card.getByRole('radio', { name: /^Required/ });
    await expect(required, 'no transport: Required is not available').toBeDisabled();

    // The development preset, offered on every instance but the official hub
    // (EMAIL.md §2.2) — in a production build its compose variant, mailpit:1025.
    const preset = card.getByRole('radio', { name: /^Mailpit/ });
    await expect(preset).toBeVisible();
    await preset.check();
    await expect(card.getByLabel('SMTP host')).toHaveValue(SMTP_HOST);
    await expect(card.getByLabel('Port')).toHaveValue(String(SMTP_PORT));
    await expect(card.getByLabel('Encryption')).toHaveValue('none');
    await expect(card.getByLabel('Encryption'), 'the preset decides the encryption').toBeDisabled();
    await card.getByLabel('From address').fill(FROM);
    await expect(required, 'unsaved connection: still not available').toBeDisabled();
    await card.getByRole('button', { name: 'Save email settings' }).click();
    await expect(card.getByText('Email settings saved.')).toBeVisible({ timeout: 15_000 });
    await expect(required, 'saved but never tested: still not available').toBeDisabled();
    await expect(card.getByText(/send a successful test with the saved settings first/)).toBeVisible();

    // The test email: to the admin's own address by default.
    const seen = new Set((await mailpit.inbox(OWNER_EMAIL)).map((m) => m.ID));
    await card.getByRole('button', { name: 'Send test email' }).click();
    await expect(card.getByText('Test email sent. Check the inbox.', { exact: true })).toBeVisible({ timeout: 30_000 });
    const mail = await mailpit.waitFor(OWNER_EMAIL, { subject: SUBJECT.test, seen });
    expect(mail.From.Address).toBe('no-reply@e2e.local');
    expect(mail.Text).toContain('If you can read it, the server can send email.');
    await expect(card.getByText(/^Last test of the saved settings: .* — Test email sent\./)).toBeVisible();

    await expect(required, 'a passing test unlocks Required').toBeEnabled();
    await card.getByRole('radio', { name: /^Optional/ }).check();
    await card.getByRole('button', { name: 'Save email settings' }).click();
    await expect(card.getByText('Email settings saved.')).toBeVisible({ timeout: 15_000 });
    expect(await mailSettings()).toMatchObject({
      provider: 'mailpit',
      host: SMTP_HOST,
      port: SMTP_PORT,
      security: 'none',
      from: FROM,
      lastTest: { result: 'ok' },
      verification: { mode: 'optional' },
    });

    await shootAll(page, testInfo, 'admin-email', {
      setTheme: setAccountTheme,
      ready: () => expect(card.getByRole('radio', { name: /^Mailpit/ })).toBeChecked({ timeout: 20_000 }),
      sections: () => [
        page.getByRole('heading', { name: 'Email', exact: true }),
        card.getByRole('radio', { name: /^Mailpit/ }),
        card.getByRole('heading', { name: 'Connection' }),
        card.getByRole('heading', { name: 'Test email' }),
        card.getByRole('heading', { name: 'Verification', exact: true }),
        card.getByRole('heading', { name: 'Disposable addresses' }),
      ],
    });
  });

  test('(a2) the saved SMTP password is only reused for the same provider, host and user', async () => {
    await ensureMail('optional');
    const elsewhere: MailPatch = { host: 'smtp.example.org', port: 587, security: 'starttls' };
    try {
      // A server that signs in: user name and password saved.
      await putMail({ provider: 'custom', username: 'e2e-user', password: 'first-secret-value' });
      const current = await mailSettings();
      expect(current).toMatchObject({ provider: 'custom', host: SMTP_HOST, username: 'e2e-user', passwordSet: true });

      // Another host, user name or provider without the password: refused, nothing saved.
      const moves: Array<[string, MailPatch]> = [
        ['host', elsewhere],
        ['user name', { username: 'someone-else' }],
        ['provider', { provider: 'brevo', region: null, host: null, port: null, security: null }],
      ];
      for (const [what, patch] of moves) {
        const res = await owner.put('/api/admin/mail', { data: putBody(current, patch) });
        expect([what, res.status(), await errorOf(res)]).toEqual([what, 400, 'password_required']);
      }
      expect(await mailSettings()).toMatchObject({ provider: 'custom', host: SMTP_HOST, username: 'e2e-user' });
      // Nor does the test endpoint try another server with the saved secret.
      const test = await owner.post('/api/admin/mail/test', { data: elsewhere });
      expect([test.status(), await errorOf(test)]).toEqual([400, 'password_required']);
      // A change that keeps the server (the daily limit) needs nothing.
      const same = await owner.put('/api/admin/mail', { data: putBody(current, { dailyLimit: 5000 }) });
      expect(same.status(), await same.text()).toBe(200);

      // The admin screen says so before sending anything.
      const page = await ownerPage();
      await page.goto('/admin/settings/email');
      const card = page.getByRole('region', { name: 'Mail and verification' });
      await expect(card.getByRole('radio', { name: /^Custom SMTP/ })).toBeChecked({ timeout: 20_000 });
      await card.getByLabel('SMTP host').fill('smtp.example.org');
      await card.getByRole('button', { name: 'Save email settings' }).click();
      await expect(card.getByText('Enter the password again: the saved password is only reused for the same server.').first()).toBeVisible();
      expect((await mailSettings()).host).toBe(SMTP_HOST);

      // Typed again, the move is fine.
      const moved = await owner.put('/api/admin/mail', { data: putBody(await mailSettings(), { ...elsewhere, password: 'first-secret-value' }) });
      expect(moved.status(), await moved.text()).toBe(200);
    } finally {
      // Back to Mailpit, which signs nobody in: no password asked for or kept.
      await putMail({ provider: 'mailpit', host: SMTP_HOST, port: SMTP_PORT, security: 'none', username: null, password: null, dailyLimit: null });
    }
  });

  test('(b) sign-up: the code from the email, typed into the lobby banner, verifies the address', async ({}, testInfo) => {
    await ensureMail('optional');
    const page = await newPage();
    const { email, body } = await signUpInBrowser(page, 'b');
    expect(body.verificationEmailSent, 'the register answer says an email went out').toBe(true);

    const strip = banner(page);
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(strip.getByRole('heading', { name: 'Verify your email address' })).toBeVisible();
    await expect(strip.getByText(`We sent a 6-digit code to ${email}.`, { exact: false })).toBeVisible();
    // Optional mode: nothing is locked.
    await expect(page.getByRole('combobox', { name: /^Message #/ })).toBeVisible();

    const mail = await mailpit.waitFor(email, { subject: SUBJECT.verify });
    expect(mail.Subject, 'the code is never in the subject').not.toMatch(/\d{6}/);
    const code = codeOf(mail);
    expect(linkOf(mail)).toMatch(new RegExp(`^${baseUrl}/verify-email\\?t=`));

    await shootAll(page, testInfo, 'lobby-banner', { setTheme: setAccountTheme, ready: () => expect(strip).toBeVisible({ timeout: 20_000 }) });

    const field = strip.getByLabel('6-digit code');
    const submit = strip.getByRole('button', { name: 'Verify', exact: true });
    await expect(submit, 'nothing to send yet').toBeDisabled();
    // Pasted with a space, as people do.
    await field.fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await expect(field).toHaveValue(code);
    await submit.click();
    await expect(strip, 'the banner goes away once the address is verified').toHaveCount(0, { timeout: 15_000 });
    expect(await emailStatus(page.context().request)).toMatchObject({ email, verified: true, restricted: false });
    // And stays away.
    await page.reload();
    await expect(page.getByRole('combobox', { name: /^Message #/ })).toBeVisible({ timeout: 20_000 });
    await expect(strip).toHaveCount(0);
  });

  test('(c) the link in another browser: GET shows a button, the POST verifies, the first tab unlocks on focus', async ({}, testInfo) => {
    await ensureMail('optional');
    const page = await newPage();
    const account = await apiAccount(page.context().request, 'c');
    expect(account.verificationEmailSent).toBe(true);
    await page.goto('/lobby');
    const strip = banner(page);
    await expect(strip).toBeVisible({ timeout: 20_000 });

    const link = linkOf(await mailpit.waitFor(account.email, { subject: SUBJECT.verify }));
    // A mail scanner opening the link verifies nothing.
    const scanner = await pwRequest.newContext();
    apis.push(scanner);
    expect((await scanner.get(link)).status()).toBe(200);
    // The phone the email was read on: signed out, another browser.
    const phone = await newPage({ width: 390 });
    await phone.goto(link);
    await expect(phone.getByRole('heading', { name: 'Confirm your email address' })).toBeVisible();
    const button = phone.getByRole('button', { name: 'Verify my email' });
    await expect(button).toBeVisible();
    expect((await emailStatus(page.context().request)).verified, 'two GETs of the link verified nothing').toBe(false);
    await shootAll(phone, testInfo, 'verify-email', { ready: () => expect(button).toBeVisible() });

    const posted = phone.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/email/verify');
    await button.click();
    expect((await posted).status()).toBe(200);
    await expect(phone.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();
    await expect(phone.getByRole('link', { name: 'Sign in' }), 'the link never signs anyone in').toBeVisible();
    expect((await phone.context().request.get('/api/auth/guest')).status(), 'no session on the phone').toBe(401);
    await shootAll(phone, testInfo, 'verify-email-done', {
      ready: () => expect(phone.getByRole('heading', { name: 'Your email is verified' })).toBeVisible(),
    });

    // The first tab has not been told yet …
    await expect(strip).toBeVisible();
    // … until it is the active tab again (the store re-reads on focus, at most every 2 s).
    await sleep(2_500);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(strip, 'the first tab unlocks without a reload').toHaveCount(0, { timeout: 10_000 });

    // The used link again: nothing left to do.
    const again = await newPage();
    await again.goto(link);
    await again.getByRole('button', { name: 'Verify my email' }).click();
    await expect(again.getByRole('heading', { name: /^(Your email is verified|This link isn't valid)$/ })).toBeVisible();
  });

  test('(d) Required: a new account is locked out of messages, voice, invites, uploads and join notes until it verifies; older accounts, invite sign-ups and the owner never', async ({}, testInfo) => {
    test.setTimeout(300_000);
    await ensureMail('optional');

    // An account from before enforcement. `enforcedSince` is set the first
    // time the mode becomes Required and kept, so on a stack that was
    // Required before, "before" is made by dating the account back.
    const elder = await newApi();
    const elderAccount = await apiAccount(elder, 'd-elder');
    const enforcedBefore = (await mailSettings()).verification.enforcedSince;
    if (enforcedBefore) {
      psql(`update users set created_at = timestamptz '${enforcedBefore}' - interval '1 day' where id = '${elderAccount.uid}'`);
      testInfo.annotations.push({ type: 'pre-enforcement account', description: `dated back before ${enforcedBefore}` });
    }

    // Required, through the admin screen.
    const admin = await ownerPage();
    await admin.goto('/admin/settings/email');
    const card = admin.getByRole('region', { name: 'Mail and verification' });
    await expect(card.getByRole('radio', { name: /^Optional/ })).toBeChecked({ timeout: 20_000 });
    await card.getByRole('radio', { name: /^Required/ }).check();
    await card.getByRole('button', { name: 'Save email settings' }).click();
    await expect(card.getByText('Email settings saved.')).toBeVisible({ timeout: 15_000 });
    expect((await mailSettings()).verification).toMatchObject({ mode: 'required' });
    expect((await mailSettings()).verification.enforcedSince).toBeTruthy();

    try {
      // While Required, mail cannot be switched off: the card says why, the API refuses.
      await expect(card.getByRole('radio', { name: /^No email/ })).toBeDisabled();
      await expect(card.getByText("Email can't be turned off while verification is Required")).toBeVisible();
      const off = await owner.put('/api/admin/mail', { data: putBody(await mailSettings(), { provider: 'none', host: null, port: null, security: null }) });
      expect([off.status(), await errorOf(off)]).toEqual([409, 'transport_required']);
      expect((await mailSettings()).provider).toBe('mailpit');

      // A new member signs up.
      const page = await newPage();
      const { email } = await signUpInBrowser(page, 'd');
      const req = page.context().request;
      const strip = banner(page);
      await expect(strip.getByRole('heading', { name: 'Verify your email to unlock your account' })).toBeVisible({ timeout: 20_000 });
      await expect(strip.getByText(/Until then you can read, but you can't send messages/)).toBeVisible();
      expect(await emailStatus(req)).toMatchObject({ mode: 'required', restricted: true, verified: false });

      // Messages: the composer is a notice instead.
      await expect(page.getByText('Verify your email to send messages.')).toBeVisible();
      await expect(page.getByRole('combobox', { name: /^Message #/ })).toHaveCount(0);
      const message = await req.post(`/api/servers/${serverId}/channels/${textChannelId}/messages`, { headers: ORIGIN, data: { content: 'hello' } });
      expect([message.status(), await errorOf(message)]).toEqual([403, 'email_unverified']);

      // Voice: the channels say why, and a click leads to the code field instead of connecting.
      await expect(page.getByText('Verify your email to join voice channels.')).toBeVisible();
      const voiceButton = page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
      await voiceButton.click();
      await expect(strip.getByLabel('6-digit code')).toBeFocused();
      await expect(page.getByText('Voice Connected')).toHaveCount(0);
      const token = await req.post('/api/livekit/token', { headers: ORIGIN, data: { serverId, channelId: voiceChannelId } });
      expect([token.status(), await errorOf(token)]).toEqual([403, 'email_unverified']);

      // Invites (a member has CREATE_INVITE; the lobby has no invite form for members — the API answers).
      const invite = await req.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: { maxUses: 1 } });
      expect([invite.status(), await errorOf(invite)]).toEqual([403, 'email_unverified']);

      await shootAll(page, testInfo, 'lobby-restricted', {
        setTheme: setAccountTheme,
        ready: () => expect(page.getByText('Verify your email to send messages.')).toBeVisible({ timeout: 20_000 }),
      });

      // Uploads: the avatar and banner buttons are off; the text fields are not.
      const profile = await newPageSharing(page);
      await profile.goto('/settings/profile');
      await expect(profile.getByText('Verify your email to upload files.')).toBeVisible({ timeout: 20_000 });
      await expect(profile.getByRole('button', { name: 'Change avatar' })).toBeDisabled();
      await expect(profile.getByRole('button', { name: 'Add banner' })).toBeDisabled();
      const upload = await req.post('/api/users/me/avatar', { headers: ORIGIN, data: { dataUrl: avatarDataUrl() } });
      expect([upload.status(), await errorOf(upload)]).toEqual([403, 'email_unverified']);
      await profile.close();

      // The account from before enforcement, and the owner: never restricted.
      expect(await emailStatus(elder)).toMatchObject({ mode: 'required', restricted: false, verified: false });
      const elderMessage = await elder.post(`/api/servers/${serverId}/channels/${textChannelId}/messages`, { data: { content: `elder ${RUN}` } });
      expect(elderMessage.status(), await elderMessage.text()).toBe(201);
      expect((await elder.post('/api/livekit/token', { data: { serverId, channelId: voiceChannelId } })).status()).toBe(200);
      expect(await emailStatus(owner)).toMatchObject({ restricted: false });
      const ownerMessage = await owner.post(`/api/servers/${serverId}/channels/${textChannelId}/messages`, { data: { content: `owner ${RUN}` } });
      expect(ownerMessage.status(), await ownerMessage.text()).toBe(201);

      // A join request may be filed, but not with a note (free text to the moderators).
      const noted = await req.post(`/api/servers/${serverId}/join-requests/mine`, { headers: ORIGIN, data: { note: 'let me in, please' } });
      expect([noted.status(), await errorOf(noted)]).toEqual([403, 'email_unverified']);
      const bare = await req.post(`/api/servers/${serverId}/join-requests/mine`, { headers: ORIGIN, data: {} });
      expect(await errorOf(bare), 'asking without a note is not gated').not.toBe('email_unverified');

      // A sign-up with an invite is outside the default scope: no email, no lock.
      const inviteRes = await owner.post(`/api/servers/${serverId}/invites`, { data: { maxUses: 1 } });
      expect(inviteRes.status(), await inviteRes.text()).toBe(201);
      const { invite: inviteRow } = (await inviteRes.json()) as { invite: { code: string } };
      const invited = await newApi();
      const invitedEmail = address('d-invited');
      const invitedRes = await registerAccount(invited, {
        data: { email: invitedEmail, password: PASSWORD, displayName: `Mail invited ${RUN.slice(-4)}`, inviteCode: inviteRow.code },
      });
      expect(invitedRes.status(), await invitedRes.text()).toBe(201);
      expect(((await invitedRes.json()) as { verificationEmailSent?: boolean }).verificationEmailSent).toBeUndefined();
      expect(await emailStatus(invited)).toMatchObject({ mode: 'required', restricted: false, verified: false });
      const invitedMessage = await invited.post(`/api/servers/${serverId}/channels/${textChannelId}/messages`, { data: { content: `invited ${RUN}` } });
      expect(invitedMessage.status(), await invitedMessage.text()).toBe(201);
      expect(await mailpit.count(invitedEmail), 'no verification email for an invite sign-up').toBe(0);

      // Verify with the code — everything opens up without a reload.
      const code = codeOf(await mailpit.waitFor(email, { subject: SUBJECT.verify }));
      await strip.getByLabel('6-digit code').fill(code);
      await strip.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(strip).toHaveCount(0, { timeout: 15_000 });
      const composer = page.getByRole('combobox', { name: /^Message #/ });
      await expect(composer).toBeVisible();
      const text = `verified and talking ${RUN}`;
      await composer.fill(text);
      await composer.press('Enter');
      await expect(page.getByText(text)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Verify your email to join voice channels.')).toHaveCount(0);
      await voiceButton.click();
      await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
      const inviteAfter = await req.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: { maxUses: 1 } });
      expect(inviteAfter.status(), await inviteAfter.text()).toBe(201);
      const uploadAfter = await req.post('/api/users/me/avatar', { headers: ORIGIN, data: { dataUrl: avatarDataUrl() } });
      expect(uploadAfter.status(), await uploadAfter.text()).toBe(200);
      const profileAfter = await newPageSharing(page);
      await profileAfter.goto('/settings/profile');
      await expect(profileAfter.getByRole('button', { name: 'Change avatar' })).toBeEnabled({ timeout: 20_000 });
      await expect(profileAfter.getByText('Verify your email to upload files.')).toHaveCount(0);
      await profileAfter.close();
    } finally {
      // Never leave the instance in Required.
      await putMail({ verification: { mode: 'optional' } });
    }
  });

  /** Another tab of the same browser (same cookies). */
  async function newPageSharing(page: Page): Promise<Page> {
    return page.context().newPage();
  }

  test('(e) change email: password required, code to the new address, notice to the old one, other sessions end', async () => {
    await ensureMail('optional');
    const page = await newPage();
    const req = page.context().request;
    const account = await apiAccount(req, 'e');
    // Start verified (the code from the sign-up email).
    const verifyCode = codeOf(await mailpit.waitFor(account.email, { subject: SUBJECT.verify }));
    expect((await req.post('/api/auth/email/verify', { headers: ORIGIN, data: { code: verifyCode } })).status()).toBe(200);
    // A second session of the same account (another device).
    const other = await newApi();
    expect((await signIn(other, { data: { email: account.email, password: PASSWORD } })).status()).toBe(200);
    expect((await other.get('/api/auth/guest')).status()).toBe(200);

    await page.goto('/settings/my-account');
    await expect(page.getByText(account.email)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('p').filter({ hasText: account.email })).toContainText('Verified');
    await page.getByRole('button', { name: 'Change email' }).click();
    await expect(page.getByRole('heading', { name: 'Change your email address' })).toBeVisible();
    const newEmail = address('e-new');
    await page.getByLabel('New email address').fill(newEmail);
    await page.getByLabel('Current password').fill('not-the-password-at-all');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByText("That password isn't right.")).toBeVisible();
    expect(await mailpit.count(newEmail), 'nothing sent without the password').toBe(0);

    // Straight after the sign-up email: the change has its own cooldown.
    await page.getByLabel('Current password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your new inbox' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`We sent a 6-digit code to ${newEmail}.`, { exact: false })).toBeVisible();
    // Nothing changed yet.
    expect(await emailStatus(req)).toMatchObject({ email: account.email, pendingChange: newEmail });
    expect((await other.get('/api/auth/guest')).status(), 'the other session lives until the change is applied').toBe(200);

    const confirm = await mailpit.waitFor(newEmail, { subject: SUBJECT.changeConfirm });
    expect(confirm.Text).toContain('Enter this code to confirm the change.');
    await page.getByLabel('6-digit code').fill(codeOf(confirm));
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page.getByText(`Your email address is now ${newEmail}. Your other devices were signed out.`)).toBeVisible({ timeout: 15_000 });

    const notice = await mailpit.waitFor(account.email, { subject: SUBJECT.changeNotice });
    // The old inbox learns of the change, but not the whole new address.
    expect(notice.Text).toContain(`was changed to ${newEmail[0]}***@e2e.local`);
    expect(notice.Text).not.toContain(newEmail);
    expect(await emailStatus(req), 'this session survives and has the new, verified address').toMatchObject({
      email: newEmail,
      verified: true,
      pendingChange: null,
    });
    expect((await other.get('/api/auth/guest')).status(), 'the other session was signed out').toBe(401);
    // The new address signs in; the old one no longer does.
    const fresh = await newApi();
    expect((await signIn(fresh, { data: { email: newEmail, password: PASSWORD } })).status()).toBe(200);
    const stale = await newApi();
    expect((await signIn(stale, { data: { email: account.email, password: PASSWORD } })).status()).toBe(401);
  });

  test('(f) forgot → reset by link and by code: every session ends; an unknown address gets the same answer', async ({}, testInfo) => {
    test.setTimeout(240_000);
    await ensureMail('optional');
    // The account, signed in on two devices.
    const lobby = await newPage();
    const account = await apiAccount(lobby.context().request, 'f');
    await lobby.goto('/lobby');
    await expect(lobby.getByRole('combobox', { name: /^Message #/ })).toBeVisible({ timeout: 20_000 });
    const device = await newApi();
    expect((await signIn(device, { data: { email: account.email, password: PASSWORD } })).status()).toBe(200);

    // Someone who forgot: the sign-in page's link.
    const page = await newPage();
    await page.goto('/login');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await page.getByLabel('Email').fill(account.email);
    await captchaSolved(page);
    await shootAll(page, testInfo, 'forgot-password', { ready: () => expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible() });
    const forgotPosts: Array<{ status: number; body: string }> = [];
    page.on('response', async (r) => {
      if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/password/forgot') {
        forgotPosts.push({ status: r.status(), body: await r.text() });
      }
    });
    await page.getByRole('button', { name: 'Send reset email' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`If an account exists for ${account.email}`, { exact: false })).toBeVisible();
    await shootAll(page, testInfo, 'forgot-password-sent', { ready: () => expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible() });

    // An unknown address: the same page, the same answer, no email.
    const unknown = address('f-nobody');
    await page.getByRole('button', { name: 'Use a different address' }).click();
    await page.getByLabel('Email').fill(unknown);
    await page.getByRole('button', { name: 'Send reset email' }).click();
    await expect(page.getByText(`If an account exists for ${unknown}`, { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => forgotPosts.length).toBe(2);
    expect(forgotPosts[1], 'identical answer for an unknown address').toEqual(forgotPosts[0]);
    expect(forgotPosts[0]).toEqual({ status: 202, body: '{"sent":true}' });

    // By link.
    const resetMail = await mailpit.waitFor(account.email, { subject: SUBJECT.reset });
    const link = linkOf(resetMail);
    expect(link).toMatch(new RegExp(`^${baseUrl}/reset-password\\?t=`));
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await shootAll(page, testInfo, 'reset-password', { ready: () => expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible() });
    // Too short: the meter says so and nothing is sent.
    await page.getByLabel('New password').fill('short');
    await expect(page.getByText('Too short — at least 12 characters')).toBeVisible();
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel('New password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('heading', { name: 'Your password was changed' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('You were signed out on every device. Sign in with your new password.')).toBeVisible();
    expect(await mailpit.count(unknown), 'no email for an address without an account').toBe(0);

    // Every session ended: the API device and the lobby tab.
    expect((await device.get('/api/auth/guest')).status()).toBe(401);
    await lobby.reload();
    await expect(lobby).toHaveURL(/\/login/, { timeout: 20_000 });
    const oldPassword = await newApi();
    expect((await signIn(oldPassword, { data: { email: account.email, password: PASSWORD } })).status()).toBe(401);
    const newPassword = await newApi();
    expect((await signIn(newPassword, { data: { email: account.email, password: NEW_PASSWORD } })).status()).toBe(200);
    expect(await emailStatus(newPassword), 'a reset also proves the address').toMatchObject({ verified: true });

    // By code: another reset email, the code form.
    const seen = new Set((await mailpit.inbox(account.email)).map((m) => m.ID));
    const asked = await requestPasswordReset(await newApi(), account.email);
    expect(asked.status()).toBe(202);
    const code = codeOf(await mailpit.waitFor(account.email, { subject: SUBJECT.reset, seen }));
    const codePage = await newPage();
    await codePage.goto('/reset-password');
    await expect(codePage.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await codePage.getByLabel('Email').fill(account.email);
    await codePage.getByLabel('6-digit code').fill(code);
    await shootAll(codePage, testInfo, 'reset-password-code', { ready: () => expect(codePage.getByLabel('6-digit code')).toBeVisible() });
    await codePage.getByLabel('New password').fill(PASSWORD);
    await codePage.getByRole('button', { name: 'Set new password' }).click();
    await expect(codePage.getByRole('heading', { name: 'Your password was changed' })).toBeVisible({ timeout: 15_000 });
    expect((await newPassword.get('/api/auth/guest')).status(), 'the session from the first reset ended too').toBe(401);
    expect((await signIn(await newApi(), { data: { email: account.email, password: PASSWORD } })).status()).toBe(200);
    // A failed code is always `invalid_code`: used, wrong, or an address without an account.
    const anon = await newApi();
    const replay = await anon.post('/api/auth/password/reset', { data: { email: account.email, code, newPassword: NEW_PASSWORD } });
    expect([replay.status(), await errorOf(replay)]).toEqual([400, 'invalid_code']);
    const wrongCode = code === '000000' ? '111111' : '000000';
    const wrong = await anon.post('/api/auth/password/reset', { data: { email: account.email, code: wrongCode, newPassword: NEW_PASSWORD } });
    expect([wrong.status(), await errorOf(wrong)]).toEqual([400, 'invalid_code']);
    const nobody = await anon.post('/api/auth/password/reset', { data: { email: unknown, code: wrongCode, newPassword: NEW_PASSWORD } });
    expect([nobody.status(), await errorOf(nobody)]).toEqual([400, 'invalid_code']);
  });

  test('(f2) "Use a different address" after a sent reset email sends the next one', async () => {
    // Regression: the captcha gate used to keep the formToken of an accepted
    // request and send the spent (single-use) token again (form_rejected).
    await ensureMail('optional');
    const page = await newPage();
    const answers: number[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/password/forgot') answers.push(r.status());
    });
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(address('f2-first'));
    await page.getByRole('button', { name: 'Send reset email' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Use a different address' }).click();
    const second = address('f2-second');
    await page.getByLabel('Email').fill(second);
    await page.getByRole('button', { name: 'Send reset email' }).click();
    await expect(page.getByText(`If an account exists for ${second}`, { exact: false })).toBeVisible({ timeout: 15_000 });
    expect(answers, 'both sends accepted, no form_rejected in between').toEqual([202, 202]);
  });

  test('(g) disposable addresses: blocked at sign-up and email change; the allow list wins', async () => {
    await ensureMail('optional');
    const admin = await ownerPage();
    await admin.goto('/admin/settings/email');
    const card = admin.getByRole('region', { name: 'Mail and verification' });
    const block = card.getByRole('checkbox', { name: /^Block disposable email addresses/ });
    await expect(block).not.toBeChecked({ timeout: 20_000 });
    await block.check();
    await card.getByRole('button', { name: 'Save email settings' }).click();
    await expect(card.getByText('Email settings saved.')).toBeVisible({ timeout: 15_000 });
    expect((await mailSettings()).disposable.block).toBe(true);

    try {
      // Sign-up with a throwaway address: refused before anything is written.
      const page = await newPage();
      await page.goto('/login?mode=register');
      await captchaSolved(page);
      const throwaway = address('g', DISPOSABLE_DOMAIN);
      await page.getByLabel('Display name', { exact: true }).fill('Throwaway');
      await page.getByLabel('Email').fill(throwaway);
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
      const answered = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/register');
      await page.getByRole('button', { name: 'Create account' }).click();
      const res = await answered;
      expect([res.status(), await errorOf(res)]).toEqual([400, 'disposable_email']);
      await expect(formAlert(page)).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
      expect((await page.context().request.get('/api/auth/guest')).status(), 'no account, no session').toBe(401);
      // A subdomain of a listed domain is refused too.
      const sub = await registerAccount(await newApi(), {
        data: { email: address('g-sub', `inbox.${DISPOSABLE_DOMAIN}`), password: PASSWORD, displayName: 'Sub' },
      });
      expect([sub.status(), await errorOf(sub)]).toEqual([400, 'disposable_email']);

      // Email change to a throwaway address.
      const member = await newPage();
      await apiAccount(member.context().request, 'g-member');
      await member.goto('/settings/my-account');
      await member.getByRole('button', { name: 'Change email' }).click();
      await member.getByLabel('New email address').fill(address('g-change', DISPOSABLE_DOMAIN));
      await member.getByLabel('Current password').fill(PASSWORD);
      await member.getByRole('button', { name: 'Send code' }).click();
      await expect(member.getByText("Addresses from disposable email services can't be used here.")).toBeVisible();

      // The admin's allow list wins over the block.
      await admin.reload();
      await card.getByLabel('Always allow').fill(DISPOSABLE_DOMAIN);
      await card.getByRole('button', { name: 'Save email settings' }).click();
      await expect(card.getByText('Email settings saved.')).toBeVisible({ timeout: 15_000 });
      expect((await mailSettings()).disposable).toMatchObject({ block: true, allow: [DISPOSABLE_DOMAIN] });
      const allowed = await registerAccount(await newApi(), {
        data: { email: address('g-allowed', DISPOSABLE_DOMAIN), password: PASSWORD, displayName: 'Allowed' },
      });
      expect(allowed.status(), await allowed.text()).toBe(201);
    } finally {
      await putMail({ disposable: { block: false, allow: [], blockExtra: [] } });
    }
  });

  test('(g2) the sign-up form says in words why an address is refused (disposable, already taken)', async () => {
    await ensureMail('optional');
    await putMail({ disposable: { block: true, allow: [], blockExtra: [] } });
    try {
      const page = await newPage();
      await page.goto('/login?mode=register');
      await captchaSolved(page);
      await page.getByLabel('Display name', { exact: true }).fill('Throwaway');
      await page.getByLabel('Email').fill(address('g2', DISPOSABLE_DOMAIN));
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
      const sends: Array<{ status: number; error: string | null }> = [];
      page.on('response', async (r) => {
        if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/register') {
          sends.push({ status: r.status(), error: await errorOf(r) });
        }
      });
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(formAlert(page)).toHaveText("Addresses from disposable email services can't be used here.", { timeout: 15_000 });
      // The same form, an address someone already has: said in words too.
      await page.getByLabel('Email').fill(OWNER_EMAIL);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(2);
      // (auth.official.error.emailTaken — in English the same words as the route's.)
      await expect(formAlert(page)).toHaveText('An account with this email already exists.');
      expect(sends).toEqual([
        { status: 400, error: 'disposable_email' },
        { status: 409, error: expect.any(String) },
      ]);
      // And a third try on the same form still goes through (a fresh formToken each time).
      const fresh = address('g2-fresh');
      await page.getByLabel('Email').fill(fresh);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page).toHaveURL(/\/lobby(\?|$)/, { timeout: 20_000 });
      expect(sends.at(-1)!.status).toBe(201);
    } finally {
      await putMail({ disposable: { block: false, allow: [], blockExtra: [] } });
    }
  });

  test('(h) resend waits out its cooldown; five wrong codes kill the code, ten lock the account; the link still works', async () => {
    test.setTimeout(240_000);
    await ensureMail('optional');
    const page = await newPage();
    const req = page.context().request;
    const account = await apiAccount(req, 'h');
    const first = await mailpit.waitFor(account.email, { subject: SUBJECT.verify });
    await page.goto('/lobby');
    const strip = banner(page);
    await expect(strip).toBeVisible({ timeout: 20_000 });

    // The sign-up email started the 60 s cooldown: "Resend in 0:5x", disabled.
    const resend = strip.getByRole('button', { name: /^Resend/ });
    await expect(resend).toHaveText(/^Resend in 0:[0-5]\d$|^Resend in 1:00$/);
    await expect(resend).toBeDisabled();
    const early = await req.post('/api/auth/email/verify/send', { headers: ORIGIN, data: {} });
    expect([early.status(), await errorOf(early)]).toEqual([429, 'rate_limited']);
    expect(((await early.json()) as { retryAfter: number }).retryAfter).toBeGreaterThan(0);

    // Once it has run out, "Resend code" sends a new code (and starts again).
    await expect(resend).toHaveText('Resend code', { timeout: 75_000 });
    await expect(resend).toBeEnabled();
    await resend.click();
    await expect(strip.getByText('We sent a new code. Check your inbox.')).toBeVisible({ timeout: 15_000 });
    await expect(resend).toHaveText(/^Resend in \d:\d\d$/);
    const second = await mailpit.waitFor(account.email, { subject: SUBJECT.verify, seen: new Set([first.ID]) });
    const code = codeOf(second);
    // A new send replaces the old code.
    const oldCode = codeOf(first);
    if (oldCode !== code) {
      const stale = await req.post('/api/auth/email/verify', { headers: ORIGIN, data: { code: oldCode } });
      expect(stale.status(), 'the replaced code no longer works').toBe(400);
    }

    // Wrong codes in the banner: "isn't right", until the code is dead.
    const wrong = code === '000000' ? '111111' : '000000';
    const field = strip.getByLabel('6-digit code');
    const submit = strip.getByRole('button', { name: 'Verify', exact: true });
    await field.fill(wrong);
    await submit.click();
    await expect(strip.getByText("That code isn't right. Check the email and try again.")).toBeVisible();
    let attempts = 1 + (oldCode !== code ? 1 : 0);
    for (let i = 0; i < 6; i += 1) {
      if (await strip.getByText('Too many wrong codes. Ask for a new one.').isVisible()) break;
      await field.fill(wrong);
      await submit.click();
      attempts += 1;
      await expect(submit).toHaveText('Verify');
    }
    await expect(strip.getByText('Too many wrong codes. Ask for a new one.')).toBeVisible();
    // The right code no longer helps either.
    await field.fill(code);
    await submit.click();
    attempts += 1;
    await expect(strip.getByText('Too many wrong codes. Ask for a new one.')).toBeVisible();
    expect((await emailStatus(req)).verified).toBe(false);

    // Ten code attempts per account per 15 minutes, whatever the code.
    let limited: APIResponse | null = null;
    for (let i = attempts; i <= 11 && !limited; i += 1) {
      const res = await req.post('/api/auth/email/verify', { headers: ORIGIN, data: { code } });
      if (res.status() === 429) limited = res;
    }
    expect(limited, 'the 11th code attempt is refused by the account limit').not.toBeNull();
    expect(await errorOf(limited!)).toBe('rate_limited');

    // The link of the same email still verifies (the code is dead, not the link).
    const phone = await newPage({ width: 390 });
    await phone.goto(linkOf(second));
    await phone.getByRole('button', { name: 'Verify my email' }).click();
    await expect(phone.getByRole('heading', { name: 'Your email is verified' })).toBeVisible();
    await sleep(2_500);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(strip).toHaveCount(0, { timeout: 10_000 });
  });

  test('(i) no mail: forgot says to ask the administrator; sign-up, sign-in, chat and email change still work', async ({}, testInfo) => {
    await ensureMail('optional');
    // No email, verification off — through the admin screen.
    const admin = await ownerPage();
    await admin.goto('/admin/settings/email');
    const card = admin.getByRole('region', { name: 'Mail and verification' });
    await expect(card.getByRole('radio', { name: /^Mailpit/ })).toBeChecked({ timeout: 20_000 });
    await card.getByRole('radio', { name: /^Off/ }).check();
    await card.getByRole('radio', { name: /^No email/ }).check();
    await card.getByRole('button', { name: 'Save email settings' }).click();
    await expect(card.getByText('Email settings saved.')).toBeVisible({ timeout: 15_000 });
    expect(await mailSettings()).toMatchObject({ provider: 'none', verification: { mode: 'off' } });

    // Forgot password: an honest dead end.
    const page = await newPage();
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByRole('button', { name: 'Send reset email' }).click();
    await expect(page.getByText("Password reset isn't available on this server; ask your administrator.")).toBeVisible({ timeout: 30_000 });
    await shootAll(page, testInfo, 'forgot-password-unavailable', {
      ready: () => expect(page.getByText("Password reset isn't available on this server; ask your administrator.")).toBeVisible(),
    });
    const api = await newApi();
    const refused = await api.post('/api/auth/password/forgot', { data: { email: OWNER_EMAIL } });
    expect([refused.status(), await errorOf(refused)]).toEqual([503, 'mail_unavailable']);

    // Everything else: sign-up (no email, no banner), chat, sign-in, an immediate email change.
    const member = await newPage();
    const { email, body } = await signUpInBrowser(member, 'i');
    expect(body.verificationEmailSent).toBeUndefined();
    const composer = member.getByRole('combobox', { name: /^Message #/ });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(banner(member)).toHaveCount(0);
    const text = `no mail, still talking ${RUN}`;
    await composer.fill(text);
    await composer.press('Enter');
    await expect(member.getByText(text)).toBeVisible({ timeout: 15_000 });
    expect(await mailpit.count(email), 'no email at all').toBe(0);
    expect((await signIn(await newApi(), { data: { email, password: PASSWORD } })).status()).toBe(200);

    await member.goto('/settings/my-account');
    await member.getByRole('button', { name: 'Change email' }).click();
    await expect(member.getByText("This server doesn't send email, so the change happens straight away.")).toBeVisible();
    const changed = address('i-new');
    await member.getByLabel('New email address').fill(changed);
    await member.getByLabel('Current password').fill(PASSWORD);
    await member.getByRole('button', { name: 'Change email' }).click();
    await expect(member.getByText(`Your email address is now ${changed}.`)).toBeVisible({ timeout: 15_000 });
    expect((await signIn(await newApi(), { data: { email: changed, password: PASSWORD } })).status()).toBe(200);
  });
});
