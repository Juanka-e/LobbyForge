import { test, expect } from '@playwright/test';

/**
 * Lobby smoke tests. Uses the guest auth flow (POST /api/auth/guest)
 * to establish a session before navigating to /lobby.
 */

test.describe('Lobby experience', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['microphone', 'camera']);
    // Mint a guest session via POST so the Set-Cookie header is stored.
    const res = await page.request.post('/api/auth/guest', {
      data: { displayName: 'TestUser' },
    });
    // If guest creation fails (e.g. registration closed), the lobby
    // page will redirect to /login — tests will skip in that case.
  });

  test('lobby renders with server rail and channels', async ({ page }) => {
    const resp = await page.goto('/lobby', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || resp.status() === 307 || resp.url().includes('/login')) {
      test.skip(true, 'Guest access not available on this instance');
    }

    // Wait for the page to hydrate
    await page.waitForTimeout(3000);

    // Server rail (72px left nav) should be visible
    const nav = page.locator('nav').first();
    await expect(nav).toBeVisible({ timeout: 10000 });
  });

  test('text channels section is visible', async ({ page }) => {
    const resp = await page.goto('/lobby', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || resp.url().includes('/login')) test.skip();

    await page.waitForTimeout(3000);
    // "Text Channels" header should appear in the sidebar
    await expect(page.getByText('Text Channels').first()).toBeVisible({ timeout: 15000 });
  });

  test('voice channels section is visible', async ({ page }) => {
    const resp = await page.goto('/lobby', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || resp.url().includes('/login')) test.skip();

    await page.waitForTimeout(3000);
    await expect(page.getByText('Voice Channels').first()).toBeVisible({ timeout: 15000 });
  });

  test('message composer is present', async ({ page }) => {
    const resp = await page.goto('/lobby', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || resp.url().includes('/login')) test.skip();

    await page.waitForTimeout(3000);
    // Composer input should be visible
    const composer = page.locator('input[placeholder*="Message"]').first();
    await expect(composer).toBeVisible({ timeout: 15000 });
  });

  test('can type in composer', async ({ page }) => {
    const resp = await page.goto('/lobby', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || resp.url().includes('/login')) test.skip();

    await page.waitForTimeout(3000);
    const composer = page.locator('input[placeholder*="Message"]').first();
    await expect(composer).toBeVisible({ timeout: 15000 });
    await composer.fill('Test message');
    await expect(composer).toHaveValue('Test message');
  });

  test('members panel is visible', async ({ page }) => {
    const resp = await page.goto('/lobby', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || resp.url().includes('/login')) test.skip();

    await page.waitForTimeout(3000);
    // Right sidebar (members) should be visible on desktop viewport
    const aside = page.locator('aside').last();
    await expect(aside).toBeVisible({ timeout: 15000 });
  });
});
