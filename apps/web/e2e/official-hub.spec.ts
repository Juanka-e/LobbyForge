/**
 * The official hub, end to end: the landing page, its mobile menu, the
 * marketplace, directory, connect and create-a-community pages inside the
 * hub chrome, official accounts (sign up → hub home, sign out → sign in →
 * hub home), settings returning to the hub page it was opened from, and
 * the redirects around them.
 *
 * Targets an OFFICIAL-mode stack (`LOBBYFORGE_DEPLOYMENT_MODE=official`):
 *
 *   LF_E2E_OFFICIAL_URL=http://localhost:19530 npx playwright test e2e/official-hub.spec.ts
 *
 * `LF_E2E_BASE_URL` works too. The spec checks the mode itself and skips on
 * a self-hosted instance (its /landing redirects to /lobby) — the
 * self-hosted `/login` is covered by the existing specs.
 *
 * It drives its own Chromium, launched WITHOUT the config's
 * --disable-web-security: that flag makes Chromium drop the Origin header,
 * which the API's origin guard (rightly) rejects in production. The stack
 * must accept its own origin (`LOBBYFORGE_APP_ORIGIN` / `NEXT_PUBLIC_BASE_URL`
 * set to the URL above).
 *
 * Each run creates one account (a unique address) and signs in once. The
 * auth rate limits (5 sign-ups, 10 sign-ins per 15 minutes per client) allow
 * a few runs back to back; after that, clear `*rate-limit*` keys in Redis.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { clearRateLimitBuckets } from './helpers/auth';

const baseUrl = process.env.LF_E2E_OFFICIAL_URL ?? process.env.LF_E2E_BASE_URL ?? '';
const REPO_URL = 'https://github.com/Juanka-e/LobbyForge';

test.skip(!baseUrl, 'Needs an official-mode stack: set LF_E2E_OFFICIAL_URL, e.g. http://localhost:19530.');

test.describe('official hub', () => {
  // One browser, one account, shared by the tests in order.
  test.describe.configure({ mode: 'serial' });

  let browser: Browser;
  let official = false;
  const contexts: BrowserContext[] = [];

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const account = {
    name: `Hub E2E ${stamp.slice(-6)}`,
    email: `hub-e2e-${stamp}@e2e.local`,
    password: 'correct-horse-battery-staple',
  };

  test.beforeAll(async ({ playwright }) => {
    // `args` must be explicit: under the test runner a bare launch() inherits
    // the config's launchOptions, --disable-web-security included (see above).
    browser = await playwright.chromium.launch({ args: [] });
    // The landing page exists only on the official hub.
    const probe = await playwright.request.newContext({ baseURL: baseUrl });
    const landing = await probe.get('/landing', { maxRedirects: 0 });
    official = landing.status() === 200;
    await probe.dispose();
  });

  test.afterAll(async () => {
    for (const context of contexts) await context.close();
    await browser?.close();
  });

  test.beforeEach(() => {
    test.skip(!official, `${baseUrl} is not an official-mode stack (its /landing redirects).`);
  });

  async function openPage(viewport: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ baseURL: baseUrl, locale: 'en-US', viewport });
    contexts.push(context);
    return context.newPage();
  }

  test('the landing page renders the design, with the repository linked', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/landing');

    await expect(page.getByRole('heading', { level: 1, name: 'Voice rooms your community actually owns.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'View the source' })).toHaveAttribute('href', REPO_URL);
    // The header's Star on GitHub carries the live count when GitHub answers.
    await expect(page.getByRole('link', { name: /^Star on GitHub/ }).first()).toHaveAttribute('href', REPO_URL);

    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Communities' })).toHaveAttribute('href', '/discover');
    await expect(nav.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('href', '/marketplace');
    await expect(nav.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/download');
    // The developer docs live on the hub itself now (/developers), not on GitHub.
    await expect(nav.getByRole('link', { name: 'Developers' })).toHaveAttribute('href', '/developers');
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login');
    await expect(page.getByRole('link', { name: 'Get started' }).first()).toHaveAttribute('href', '/register');

    // Every showcased activity leads to its own card in the marketplace.
    const showcased = {
      Hushle: 'hushle',
      Quiz: 'quiz',
      'Vampire Village': 'vampire-village',
      'Watch Party': 'watch-party',
      Poll: 'poll',
      'Dice Bot': 'dice-bot',
    };
    for (const [name, id] of Object.entries(showcased)) {
      await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('href', `/marketplace#${id}`);
    }
    await expect(page.getByRole('heading', { name: 'Yours in an afternoon.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Built in the open.' })).toBeVisible();

    // …and following one lands on that card, in view.
    await page.getByRole('link', { name: 'Watch Party', exact: true }).click();
    await expect(page).toHaveURL(/\/marketplace#watch-party$/);
    const card = page.locator('li#watch-party');
    await expect(card.getByRole('heading', { level: 3, name: 'Watch Party' })).toBeVisible();
    await expect(card).toBeInViewport();
  });

  test('on a phone the menu button opens the navigation and Escape closes it', async () => {
    const page = await openPage({ width: 390, height: 844 });
    await page.goto('/landing');

    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);

    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByRole('navigation', { name: 'Primary' });
    await expect(panel.getByRole('link', { name: 'Marketplace' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeFocused();

    // Keyboard only: open again, follow a link.
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await panel.getByRole('link', { name: 'Marketplace' }).click();
    await expect(page).toHaveURL(/\/marketplace$/);
    // The marketplace sits in the hub chrome on the official hub.
    await expect(page.getByRole('heading', { level: 1, name: 'Plugin Marketplace' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  });

  /** The signed-up session, carried into the sign-out → sign-in test. */
  let session: Page | null = null;

  test('a signed-out visitor is asked to sign in before the hub home', async () => {
    const page = await openPage({ width: 1280, height: 900 });
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/landing$/);
  });

  test('the directory, connect and create-a-community pages sit in the hub chrome', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    const pages: Array<{ path: string; heading: string; current?: string }> = [
      { path: '/discover', heading: 'Discover Communities', current: 'Communities' },
      { path: '/connect', heading: 'Connect to a LobbyForge community' },
      { path: '/instances/new', heading: 'Create an instance' },
    ];
    for (const { path, heading, current } of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading }), path).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav.getByRole('link', { name: 'Marketplace' }), path).toBeVisible();
      if (current) await expect(nav.getByRole('link', { name: current }), path).toHaveAttribute('aria-current', 'page');
      // Only the hub header — the app's own top bar does not stack on it.
      await expect(page.getByRole('link', { name: 'System Health' }), path).toHaveCount(0);
      await expect(page.getByText('Self-hosted voice communities.'), path).toBeVisible();
    }
    // The directory's exit interceptor answers at /discover/go (not the
    // instance page): an unknown id gets its "not available" state.
    await page.goto('/discover/go?id=no-such-community');
    await expect(page.getByRole('heading', { level: 1, name: 'Community not available' })).toBeVisible();
  });

  test('signing up creates an account and lands on the hub home', async () => {
    const page = await openPage({ width: 1280, height: 900 });
    session = page;
    // Sign-up stays a per-address bucket (5 per 15 minutes) and every test
    // client is one address: earlier specs' sign-ups must not count here.
    clearRateLimitBuckets(['auth-local-register']);
    await page.goto('/register');
    await expect(page.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible();

    await page.getByLabel('Display name').fill(account.name);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    // The terms box by name: the bot-protection widget has a checkbox of its own.
    await page.getByRole('checkbox', { name: /^I agree to follow/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();

    // Bot protection first (docs/CAPTCHA.md): the form waits for the check
    // and the 2.5 s minimum fill time before it sends.
    await expect(page).toHaveURL(/\/home$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(account.name);
    // A new account has joined nothing yet, and the page says so.
    await expect(page.getByText("You haven't joined a community yet.", { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add a community by address' })).toHaveAttribute('href', '/connect');

    // Signed in, the front door is the hub home.
    await page.goto('/');
    await expect(page).toHaveURL(/\/home$/);
  });

  test('settings opened from the hub return to the hub, not the demo lobby', async () => {
    test.skip(!session, 'Needs the account from the sign-up test.');
    const page = session!;
    await page.goto('/home');
    const accountMenu = page.getByRole('button', { name: `Account menu for ${account.name}` });

    await accountMenu.click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'User Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole('dialog', { name: 'User Settings' })).toHaveCount(0);

    // From another hub page, and closed with Escape this time.
    await page.goto('/discover');
    await accountMenu.click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'User Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/discover$/);
  });

  test('signing out and back in returns to the hub home', async () => {
    test.skip(!session, 'Needs the account from the sign-up test.');
    const page = session!;
    await page.goto('/home');

    // Sign out from the account menu …
    await page.getByRole('button', { name: `Account menu for ${account.name}` }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    // … which really ended the session.
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login$/);

    // … and back in with the same account.
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(account.name);
  });
});
