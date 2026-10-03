/**
 * The join approval queue, through the real UI (security-review AUTHZ-004
 * follow-up, migration 0043 `server_join_requests`).
 *
 * With "approval required for a first join" switched on, a newcomer opens
 * an invite link in their own browser, signs in as a guest and asks to
 * join: the invite page and the lobby both say the request is waiting, and
 * nothing of the community shows. A moderator (the owner, in a second
 * browser) opens Community settings → Members, finds the request in "Join
 * requests" and approves it. The newcomer presses "Check again" in the
 * lobby and is in: channels, composer, their name in the member list.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). The access policy is
 * server-wide: the spec saves it first and puts it back in `finally`.
 * Screenshots of each state, dark and light, go to the test's output dir.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

interface AccessPolicy {
  joinPolicy: string;
  externalIdentity: string;
  localAccount: string;
  accountLinking: string;
  requireApprovalForFirstJoin: boolean;
}

/** Screenshot the page in dark and in light (the default theme follows the system). */
async function shootBothThemes(page: Page, path: (theme: string) => string) {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path(colorScheme), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

test.describe('join requests: ask, wait, get approved', () => {
  let browser: Browser;
  let ownerCtx: BrowserContext;
  let newcomerCtx: BrowserContext;
  let serverId = '';
  let original: AccessPolicy | null = null;

  test.beforeAll(async ({ playwright }) => {
    // Own browser WITHOUT the config's --disable-web-security: that flag makes
    // Chromium drop the Origin header, which the app's CSRF guard rejects.
    browser = await playwright.chromium.launch({ args: [] });
    const context = () =>
      browser.newContext({ baseURL: baseUrl, locale: 'en-US', viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
    ownerCtx = await context();
    newcomerCtx = await context();

    // Owner session: fresh stack → first-run setup; warm stack → login.
    const setup = await ownerCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Join Requests E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await ownerCtx.request.post('/api/auth/login', {
        headers: ORIGIN,
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }
    const { servers } = (await (await ownerCtx.request.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
  });

  test.afterAll(async () => {
    if (ownerCtx && serverId && original) {
      const restore = await ownerCtx.request.patch(`/api/servers/${serverId}/access-policy`, {
        headers: ORIGIN,
        data: original,
      });
      expect(restore.status(), 'access policy restored').toBe(200);
    }
    await ownerCtx?.close();
    await newcomerCtx?.close();
    await browser?.close();
  });

  test('a newcomer asks through an invite, waits, is approved in Members, and lands in the lobby', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);

    // ── Setup through the API: approval required, an invite to share.
    const policyUrl = `/api/servers/${serverId}/access-policy`;
    const current = ((await (await ownerCtx.request.get(policyUrl)).json()) as { accessPolicy: AccessPolicy }).accessPolicy;
    original = {
      joinPolicy: current.joinPolicy,
      externalIdentity: current.externalIdentity,
      localAccount: current.localAccount,
      accountLinking: current.accountLinking,
      requireApprovalForFirstJoin: current.requireApprovalForFirstJoin,
    };
    const strict = await ownerCtx.request.patch(policyUrl, {
      headers: ORIGIN,
      data: { ...original, requireApprovalForFirstJoin: true },
    });
    expect(strict.status()).toBe(200);
    const inviteRes = await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: { maxUses: 5 } });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };

    // ── The newcomer opens the invite link, signs in as a guest, asks to join.
    const newcomer = await newcomerCtx.newPage();
    await newcomer.goto(`/join/${invite.code}`);
    await expect(newcomer.getByRole('heading', { name: 'Join a server' })).toBeVisible();
    await expect(newcomer.getByText('This server reviews new members: accepting sends a request to its moderators.')).toBeVisible();
    await newcomer.getByRole('button', { name: 'Sign in as guest' }).click();
    await expect(newcomer.getByText(/^Signed in as /)).toBeVisible();
    const me = (await (await newcomerCtx.request.get('/api/auth/guest')).json()) as { guest: { uid: string; name: string } };
    const name = me.guest.name;
    await newcomer.getByLabel('Message to the moderators (optional)').fill(`Hi, a friend invited me (${RUN}).`);
    await newcomer.getByRole('button', { name: 'Ask to join' }).click();
    await expect(newcomer.getByText('Request sent. A moderator will review it.')).toBeVisible();
    await expect(newcomer.getByText(/^Your request is waiting for a moderator\./)).toBeVisible();
    await expect(newcomer.getByRole('button', { name: 'Withdraw request' })).toBeVisible();
    // One shot only: the invite page opened signed out keeps the layout's
    // default dark theme (AppearanceRuntime reads the theme once, on mount,
    // and /api/settings/me was 401 then), whatever the system prefers.
    await newcomer.screenshot({ path: testInfo.outputPath('1-invite-waiting.png'), fullPage: true });

    // ── The lobby says the same, and shows nothing of the community.
    await newcomer.goto('/lobby');
    await expect(newcomer.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
    await expect(newcomer.getByRole('status')).toContainText('Your request to join this community is waiting for a moderator.');
    await expect(newcomer.getByRole('link', { name: 'Check again' })).toBeVisible();
    await expect(newcomer.getByRole('button', { name: 'Withdraw request' })).toBeVisible();
    await expect(newcomer.getByText('Voice Channels')).toHaveCount(0);
    await shootBothThemes(newcomer, shot('2-lobby-waiting'));

    // ── The owner approves it in Community settings → Members.
    const owner = await ownerCtx.newPage();
    await owner.goto('/admin/settings/members');
    const queue = owner.locator('section[aria-labelledby="join-requests-title"]');
    await expect(queue.getByRole('heading', { name: 'Join requests' })).toBeVisible();
    await expect(queue.getByText('1 waiting')).toBeVisible();
    const row = queue.getByRole('listitem').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`Hi, a friend invited me (${RUN}).`);
    await expect(row).toContainText('with an invite from');
    await shootBothThemes(owner, shot('3-admin-join-request'));
    await row.getByRole('button', { name: `Approve ${name}` }).click();
    await expect(queue.getByText(`${name} is now a member.`)).toBeVisible();
    await expect(queue.getByText('No one is waiting for approval.')).toBeVisible();
    await shootBothThemes(owner, shot('4-admin-approved'));

    // ── The newcomer checks again and is in.
    await newcomer.getByRole('link', { name: 'Check again' }).click();
    await expect(newcomer.getByText('Voice Channels').first()).toBeVisible({ timeout: 15_000 });
    await expect(newcomer.getByRole('heading', { name: 'Waiting for approval' })).toHaveCount(0);
    await expect(newcomer.locator('input[placeholder^="Message #"]').first()).toBeVisible();
    await expect(newcomer.locator('[data-user-popover-anchor]').filter({ hasText: name }).first()).toBeVisible();
    await shootBothThemes(newcomer, shot('5-lobby-member'));

    // The membership is real: the API lists the server for the newcomer.
    const after = (await (await newcomerCtx.request.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    expect(after.servers.map((s) => s.id)).toContain(serverId);
  });
});
