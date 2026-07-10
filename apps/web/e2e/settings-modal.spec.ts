import { expect, test } from '@playwright/test';

test('settings is a single full-screen modal that closes to the lobby', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Display name').fill('Settings Tester');
  await page.getByRole('button', { name: 'Continue to community' }).click();
  await expect(page).toHaveURL(/\/lobby$/);

  await page.goto('/admin/settings');
  const dialog = page.getByRole('dialog', { name: 'Community Settings' });
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/lobby$/);

  await page.goto('/settings');
  await expect(page.getByRole('dialog', { name: 'User Settings' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page).toHaveURL(/\/lobby$/);

  await page.goto('/settings/my-account');
  await page.getByRole('button', { name: 'Set Password' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/settings\/my-account$/);
  await expect(page.getByRole('dialog', { name: 'User Settings' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});
