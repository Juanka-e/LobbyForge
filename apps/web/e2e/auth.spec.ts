import { test, expect } from '@playwright/test';

// The config's --disable-web-security makes Chromium drop the Origin header,
// and a production image's CSRF guard refuses the guest POST without it
// ("Missing request origin"). This spec needs no other browser flag.
test.use({ launchOptions: { args: [] } });

test('user can register as a guest', async ({ page }) => {
  await page.goto('/connect/demo');
  await page.getByRole('button', { name: 'Create guest' }).click();
  // The demo page names the active session: "Active: <name> (<gid>)".
  await expect(page.getByText(/^Active: .+ \(g_[0-9a-f]{32}\)$/)).toBeVisible();
});
