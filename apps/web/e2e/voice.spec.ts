import { test, expect } from '@playwright/test';

test.describe('Voice and Presence Integration', () => {
  test('two browser contexts receive distinct sessions and cannot mint tokens outside membership', async ({ browser }) => {
    const userAContext = await browser.newContext();
    const userBContext = await browser.newContext();

    const pageA = await userAContext.newPage();
    const pageB = await userBContext.newPage();

    const guestA = await pageA.request.post('/api/auth/guest', { data: { displayNameSeed: 'Voice Alice' } });
    const guestB = await pageB.request.post('/api/auth/guest', { data: { displayNameSeed: 'Voice Bob' } });
    expect(guestA.ok()).toBeTruthy();
    expect(guestB.ok()).toBeTruthy();
    const bodyA = await guestA.json();
    const bodyB = await guestB.json();
    expect(bodyA.guest.gid).not.toBe(bodyB.guest.gid);

    const payload = {
      serverId: '00000000-0000-0000-0000-000000000090',
      channelId: '00000000-0000-0000-0000-000000000091',
      displayName: 'Voice test',
    };
    const [tokenA, tokenB] = await Promise.all([
      pageA.request.post('/api/livekit/token', { data: payload }),
      pageB.request.post('/api/livekit/token', { data: payload }),
    ]);
    expect([403, 404]).toContain(tokenA.status());
    expect([403, 404]).toContain(tokenB.status());

    await userAContext.close();
    await userBContext.close();
  });

  test('rejects presence writes without a valid server and channel membership', async ({ page }) => {
    const guest = await page.request.post('/api/auth/guest', { data: { displayNameSeed: 'Presence Test' } });
    expect(guest.ok()).toBeTruthy();
    const response = await page.request.post('/api/presence', { data: {
      serverId: '00000000-0000-0000-0000-000000000090',
      channelId: '00000000-0000-0000-0000-000000000091',
      status: 'online',
    } });
    expect([403, 404]).toContain(response.status());
  });
});
