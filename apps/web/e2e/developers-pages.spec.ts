/**
 * The developer documentation (`/developers` and its five guides) renders
 * on a self-hosted instance AND on the official hub, signed out: the right
 * h1 on every page, a working code-block copy button, no horizontal page
 * scroll on a 390 px phone, and the docs reachable from the hub navigation.
 *
 * Light and dark: a signed-out visitor always gets the app's default dark
 * theme (the theme comes from the account's settings), so the light
 * screenshots are taken signed in with the theme set to Light.
 *
 *   LF_E2E_BASE_URL      self-hosted stack (e.g. http://localhost:19620)
 *   LF_E2E_OFFICIAL_URL  official-mode web on the same stack (optional;
 *                        e.g. http://localhost:19630) — its checks skip
 *                        without it
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const selfHostUrl = process.env.LF_E2E_BASE_URL ?? '';
const officialUrl = process.env.LF_E2E_OFFICIAL_URL ?? '';
const RUN = Date.now().toString(36);

const PAGES: Array<{ path: string; h1: string; slug: string }> = [
  { path: '/developers', h1: 'Build bots, games and tools for LobbyForge', slug: 'overview' },
  { path: '/developers/bots', h1: 'Bots', slug: 'bots' },
  { path: '/developers/bot-api-v2', h1: 'Bot API v2 — design contract', slug: 'bot-api-v2' },
  { path: '/developers/plugins', h1: 'Plugin SDK', slug: 'plugins' },
  { path: '/developers/publishing', h1: 'Plugin Publishing Guide', slug: 'publishing' },
  { path: '/developers/extending', h1: 'Extending LobbyForge: bots, plugins and what you can build', slug: 'extending' },
];

test.skip(!selfHostUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const STACKS = [
  { name: 'self-host', url: selfHostUrl },
  { name: 'official', url: officialUrl },
] as const;

for (const stack of STACKS) {
  test.describe(`developer docs on the ${stack.name} instance`, () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];

    test.beforeAll(async ({ playwright }) => {
      // Own browser WITHOUT --disable-web-security (the sign-in below is a POST).
      browser = await playwright.chromium.launch({ args: [] });
    });

    test.afterAll(async () => {
      for (const ctx of contexts) await ctx.close();
      await browser?.close();
    });

    test.beforeEach(() => {
      test.skip(!stack.url, `${stack.name}: no URL configured (LF_E2E_OFFICIAL_URL).`);
    });

    async function open(viewport: { width: number; height: number }, extra: Parameters<Browser['newContext']>[0] = {}) {
      const ctx = await browser.newContext({ baseURL: stack.url, locale: 'en-US', viewport, colorScheme: 'dark', ...extra });
      contexts.push(ctx);
      return { ctx, page: await ctx.newPage() };
    }

    test('all six pages render signed out, with their h1', async ({}, testInfo) => {
      const { page } = await open({ width: 1366, height: 900 });
      for (const doc of PAGES) {
        const res = await page.goto(doc.path);
        expect(res?.status(), doc.path).toBe(200);
        await expect(page.getByRole('heading', { level: 1, name: doc.h1, exact: true }), doc.path).toBeVisible();
        // Every guide is reachable from the docs navigation.
        if (doc.slug !== 'overview') {
          await expect(page.locator(`a[href="${doc.path}"]`).first()).toBeAttached();
        }
        await page.screenshot({ path: testInfo.outputPath(`${stack.name}-${doc.slug}-desktop-dark.png`) });
      }
      // An unknown guide is a 404, not an empty page.
      expect((await page.goto('/developers/not-a-guide'))?.status()).toBe(404);
    });

    test('a code block copy button copies the code', async ({}, testInfo) => {
      const { ctx, page } = await open({ width: 1366, height: 900 });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stack.url });
      await page.goto('/developers/bot-api-v2');
      const block = page.locator('[data-code-block]').first();
      await block.scrollIntoViewIfNeeded();
      // The button copies the code's text content (innerText would differ in whitespace).
      const code = ((await block.locator('pre code').textContent()) ?? '').trim();
      expect(code.length).toBeGreaterThan(10);
      const copy = block.getByRole('button', { name: 'Copy code' });
      await copy.click();
      await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      // The Windows clipboard turns \n into \r\n; compare the text, not the line endings.
      expect(copied.replace(/\r\n/g, '\n').trim()).toBe(code);
      await block.screenshot({ path: testInfo.outputPath(`${stack.name}-code-block-copied.png`) });
      // It resets after a moment.
      await expect(block.getByRole('button', { name: 'Copy code' })).toBeVisible({ timeout: 5_000 });
    });

    test('on a 390 px phone every page fits the screen', async ({}, testInfo) => {
      const { page } = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
      for (const doc of PAGES) {
        await page.goto(doc.path);
        await expect(page.getByRole('heading', { level: 1, name: doc.h1, exact: true })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${doc.path}: horizontal page scroll at 390 px`).toBeLessThanOrEqual(0);
      }
      await page.goto('/developers');
      if (stack.name === 'official') {
        // The hub's phone menu leads to the docs.
        await page.getByRole('button', { name: 'Menu' }).click();
        await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Developers' })).toHaveAttribute(
          'href',
          '/developers'
        );
        await page.screenshot({ path: testInfo.outputPath(`${stack.name}-mobile-menu-dark.png`) });
        await page.keyboard.press('Escape');
      } else {
        await expect(page.getByRole('navigation', { name: 'Developer documentation' })).toBeVisible();
      }
      await page.screenshot({ path: testInfo.outputPath(`${stack.name}-overview-mobile-dark.png`), fullPage: true });
      await page.goto('/developers/bots');
      await page.screenshot({ path: testInfo.outputPath(`${stack.name}-bots-mobile-dark.png`) });
    });

    test('light theme, signed in: desktop and phone', async ({ playwright }, testInfo) => {
      // Sign in through the API in a context whose cookies the page shares.
      const { ctx, page } = await open({ width: 1366, height: 900 }, { colorScheme: 'light' });
      const api = ctx.request;
      const headers = { Origin: stack.url };
      if (stack.name === 'official') {
        const reg = await api.post('/api/auth/register', {
          headers,
          data: { email: `docs-${RUN}@e2e.local`, displayName: `Docs ${RUN.slice(-4)}`, password: 'correct-horse-battery-staple' },
        });
        expect(reg.status(), await reg.text()).toBe(201);
      } else {
        expect((await api.post('/api/auth/guest', { headers, data: { displayNameSeed: 'Docs Reader' } })).status()).toBe(200);
      }
      expect((await api.patch('/api/settings/me', { headers, data: { theme: 'light' } })).status()).toBe(200);
      // The theme is applied client-side once the settings load, and surfaces
      // fade with `transition-colors`: wait until a surface is really white.
      const settled = async () => {
        await expect(page.locator('html')).toHaveClass(/lf-theme-light/);
        await expect
          .poll(() =>
            page.evaluate(() =>
              [...document.querySelectorAll('.bg-surface')].every((el) =>
                /^(rgb\(255, 255, 255\)|color\(srgb 1 1 1\))$/.test(getComputedStyle(el).backgroundColor)
              )
            )
          )
          .toBe(true);
      };
      for (const doc of [PAGES[0]!, PAGES[2]!]) {
        await page.goto(doc.path);
        await expect(page.getByRole('heading', { level: 1, name: doc.h1, exact: true })).toBeVisible();
        await settled();
        await page.screenshot({ path: testInfo.outputPath(`${stack.name}-${doc.slug}-desktop-light.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/developers/plugins');
      await settled();
      await page.screenshot({ path: testInfo.outputPath(`${stack.name}-plugins-mobile-light.png`) });
      void playwright;
    });
  });
}
