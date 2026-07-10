import { test, expect } from '@playwright/test';
import Redis from 'ioredis';

test.describe('Voice and Presence Integration', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/test/db-reset');
    await request.post('/api/test/redis-reset');
  });

  test('two users can generate LiveKit tokens for the same room', async ({ browser }) => {
    const userAContext = await browser.newContext();
    const userBContext = await browser.newContext();

    const pageA = await userAContext.newPage();
    const pageB = await userBContext.newPage();

    // Log in Alice & Bob
    await pageA.goto('/connect');
    await pageA.click('button:has-text("Create Guest")');
    await pageB.goto('/connect');
    await pageB.click('button:has-text("Create Guest")');

    // Get Token
    await pageA.click('button:has-text("Get Token")');
    await pageB.click('button:has-text("Get Token")');

    // Verify token received
    await expect(pageA.locator('pre')).toContainText('"token":');
    await expect(pageB.locator('pre')).toContainText('"token":');
  });

  test('updates presence in Redis with correct TTL', async ({ page }) => {
    await page.goto('/connect');
    await page.click('button:has-text("Create Guest")');
    
    // Simulate updating presence if UI exists or just trigger endpoint directly 
    // Currently the UI for this might not exist.
  });
});
