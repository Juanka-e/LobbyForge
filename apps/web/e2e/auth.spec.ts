import { test, expect } from '@playwright/test';

test('user can register as a guest', async ({ page }) => {
  await page.goto('/connect');
  await page.click('button:has-text("Create Guest")');
  await expect(page.locator('pre')).toContainText('"gid":');
});
