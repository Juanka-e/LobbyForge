import { expect, test } from '@playwright/test';
import { buildGuestSessionCookie } from '@lobbyforge/core';

const uid = process.env.LF_E2E_EXISTING_UID;
const sessionSecret = process.env.LOBBYFORGE_SESSION_SECRET;

test.describe('authenticated lobby smoke without database reset', () => {
  test.skip(!uid || !sessionSecret, 'Requires an existing local user id and session secret.');

  test.beforeEach(async ({ context }) => {
    const cookie = buildGuestSessionCookie(
      { gid: 'g_00000000000000000000000000000001', uid: uid!, name: 'Playwright' },
      sessionSecret!,
      { secure: false }
    );
    await context.addCookies([{ name: 'lf_guest', value: cookie.raw, url: 'http://localhost:3000', httpOnly: true, sameSite: 'Lax' }]);
  });

  test('self-host shell, profile card, and compact voice view are usable', async ({ page }, testInfo) => {
    await page.goto('/lobby');
    await expect(page).toHaveURL(/\/lobby$/);
    await expect(page.getByTitle('LobbyForge Home')).toHaveCount(0);

    const member = page.locator('[data-user-popover-anchor]').first();
    await expect(member).toBeVisible();
    await member.click();
    const profile = page.getByRole('dialog', { name: /profile$/ });
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('heading', { name: 'About me' })).toBeVisible();
    await expect(profile.getByText('No bio provided.')).toHaveCount(0);
    await expect(profile.getByText('@everyone', { exact: true })).toHaveCount(0);
    await expect(profile.getByText('Voice settings')).toHaveCount(0);
    const profileBox = await profile.boundingBox();
    expect(profileBox?.width).toBeGreaterThanOrEqual(350);
    expect(profileBox?.x).toBeGreaterThanOrEqual(0);
    expect((profileBox?.x ?? 0) + (profileBox?.width ?? 0)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    await page.screenshot({ path: testInfo.outputPath('profile-popover.png'), fullPage: true });
    await page.keyboard.press('Escape');

    const voiceChannel = page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
    await expect(voiceChannel).toBeVisible();
    await voiceChannel.click();
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });
    await voiceChannel.click();

    const focus = page.getByTestId('voice-focus-view');
    await expect(focus).toBeVisible();
    await expect(focus.getByTestId('voice-control-dock')).toBeVisible();
    await focus.getByRole('button', { name: 'Stream quality' }).click();
    await expect(focus.getByText(/^Server maximum: 1080p \/ (15|30|60) FPS$/)).toBeVisible();
    await expect(focus.getByRole('button', { name: '1440p' })).toHaveCount(0);
    await focus.getByRole('button', { name: 'Stream quality' }).click();
    await focus.getByRole('button', { name: 'Start camera' }).click();
    await expect(focus.getByRole('button', { name: 'Stop camera' })).toBeVisible();
    await expect(page.getByLabel('Camera on').first()).toBeAttached();
    await focus.getByRole('button', { name: 'Share screen' }).click();
    await expect(focus.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
    const ownStreamPreview = focus.getByText('Your stream').locator('..');
    await expect(ownStreamPreview).toBeVisible();
    await ownStreamPreview.getByRole('button', { name: 'Join stream' }).click();
    await expect(focus.locator('main section')).toHaveCount(2);
    await expect(focus.locator('main video')).toHaveCount(2);
    await expect.poll(() => focus.locator('main video').evaluateAll((videos) => videos.every((video) => video.readyState >= 2))).toBe(true);
    const overflow = await focus.evaluate((element) => ({
      horizontal: element.scrollWidth > element.clientWidth,
      vertical: element.scrollHeight > element.clientHeight,
    }));
    expect(overflow).toEqual({ horizontal: false, vertical: false });
    await page.screenshot({ path: testInfo.outputPath('voice-focus.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(focus).toBeVisible();
    const mobileOverflow = await focus.evaluate((element) => ({
      horizontal: element.scrollWidth > element.clientWidth,
      vertical: element.scrollHeight > element.clientHeight,
    }));
    expect(mobileOverflow).toEqual({ horizontal: false, vertical: false });
    await page.screenshot({ path: testInfo.outputPath('voice-focus-mobile.png'), fullPage: true });
    await focus.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(focus.getByRole('button', { name: 'Share screen' })).toBeVisible();
    await expect(page.getByLabel('Sharing screen', { exact: true })).toHaveCount(0);
    await focus.getByRole('button', { name: 'Stop camera' }).click();
    await expect(focus.getByRole('button', { name: 'Start camera' })).toBeVisible();
    await expect(page.getByLabel('Camera on', { exact: true })).toHaveCount(0);
    await focus.getByRole('button', { name: 'Disconnect' }).click();
    await expect(focus).toHaveCount(0);
    await expect(page.getByText('Voice Connected')).toHaveCount(0);
  });

  test('text-only lobby presence keeps sending heartbeats', async ({ page }) => {
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        nativeSetInterval(handler, timeout === 30_000 ? 100 : timeout, ...args)) as typeof window.setInterval;
    });
    let heartbeatCount = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/presence')) heartbeatCount += 1;
    });
    await page.goto('/lobby');
    await expect.poll(() => heartbeatCount).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Voice Connected')).toHaveCount(0);
  });

  test('settings preserve the active voice room and media tests restore deafen state', async ({ page }) => {
    await page.goto('/lobby');
    const voiceChannel = page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first();
    await voiceChannel.click();
    await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 15_000 });

    await page.getByTitle('Voice & video settings').click();
    await expect(page).toHaveURL(/\/settings\/voice-video$/);
    await expect(page.getByRole('dialog', { name: 'User Settings' })).toBeVisible();
    await expect(page.getByText('Voice Connected')).toHaveCount(1);

    await page.getByRole('button', { name: 'Test microphone' }).click();
    await expect(page.getByText('Microphone test running. You should hear your mic at reduced volume.')).toBeVisible();
    await expect(page.locator('button[title="Undeafen"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Stop microphone test' }).click();
    await expect(page.locator('button[title="Deafen"]')).toHaveCount(1);

    await page.getByRole('link', { name: 'Appearance' }).click();
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    await expect(page.getByText('Voice Connected')).toBeVisible();
  });

  test('changed user and community settings routes render for the owner', async ({ page }) => {
    const routes = [
      { path: '/settings/profile', heading: 'Profile' },
      { path: '/settings/voice-video', heading: 'Voice & Video' },
      { path: '/admin/settings/roles', heading: 'Roles & Permissions' },
      { path: '/admin/settings/voice-media', heading: 'Voice & Media' },
    ];
    for (const route of routes) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { name: route.heading, exact: true }).first()).toBeVisible();
      await expect(page.getByText('Admin token required.')).toHaveCount(0);
    }
  });
});
