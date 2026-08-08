import { expect, test } from '@playwright/test';

test('settings is a single full-screen modal that closes to the lobby', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Guest display name').fill('Settings Tester');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await expect(page).toHaveURL(/\/lobby$/);

  await page.goto('/settings');
  await expect(page.getByRole('dialog', { name: 'User Settings' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/lobby$/);

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page).toHaveURL(/\/lobby$/);
});
