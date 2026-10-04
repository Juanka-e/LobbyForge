import { expect, test } from '@playwright/test';

// The config's --disable-web-security makes Chromium drop the Origin header,
// and a production image's CSRF guard refuses the guest sign-in POST without
// it ("Missing request origin"). This spec needs no other browser flag.
test.use({ launchOptions: { args: [] } });

test('settings is a single full-screen modal that closes to the lobby', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Guest display name').fill('Settings Tester');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  // A new guest passes bot protection first (docs/CAPTCHA.md): the form waits
  // for the check and the 2.5 s minimum fill time before it sends.
  await expect(page).toHaveURL(/\/lobby$/, { timeout: 20_000 });

  await page.goto('/settings');
  await expect(page.getByRole('dialog', { name: 'User Settings' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/lobby$/);

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page).toHaveURL(/\/lobby$/);
});
