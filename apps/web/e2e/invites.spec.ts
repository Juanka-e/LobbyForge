/**
 * Invites with an expiry, end to end (regression: every invite with an
 * `expiresAt` used to answer 500 on redeem — the raw SQL read returned the
 * timestamp as a string — and Admin → Invites creates one by default):
 *
 *   - an invite made in Admin → Invites with the default expiry (7 days) is
 *     accepted through the real /join page by a new guest;
 *   - signing up with an expiring invite creates the account AND the
 *     membership;
 *   - an expired invite is refused with 403, and /join says so in words
 *     (never a raw "redeem → 500").
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL).
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import { registerAccount, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface Invite {
  id: string;
  code: string;
  expiresAt: string | null;
  createdAt: string;
}

test.describe('invites with an expiry', () => {
  let browser: Browser;
  let ownerCtx: BrowserContext;
  let owner: APIRequestContext;
  let serverId = '';
  const contexts: BrowserContext[] = [];

  async function newContext(): Promise<BrowserContext> {
    const ctx = await browser.newContext({ baseURL: baseUrl, locale: 'en-US', viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
    contexts.push(ctx);
    return ctx;
  }

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    // Without the config's --disable-web-security (it drops the Origin header).
    browser = await playwright.chromium.launch({ args: [] });
    ownerCtx = await newContext();
    owner = ownerCtx.request;
    const setup = await owner.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Invites E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await signIn(owner, { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }
    serverId = ((await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> }).servers[0]!.id;
  });

  test.afterAll(async () => {
    for (const ctx of contexts) await ctx.close();
    await browser?.close();
  });

  test('an invite made in Admin → Invites with the default expiry is accepted through /join', async ({}, testInfo) => {
    const admin = await ownerCtx.newPage();
    await admin.goto('/admin/settings/invites');
    await admin.getByRole('button', { name: 'Create invite' }).click();
    await expect(admin.getByText('Invite created.')).toBeVisible({ timeout: 15_000 });
    const { invites } = (await (await owner.get(`/api/servers/${serverId}/invites`)).json()) as { invites: Invite[] };
    const invite = invites.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    // The page's default: seven days.
    expect(invite.expiresAt).not.toBeNull();
    const days = (new Date(invite.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const guest = await (await newContext()).newPage();
    await guest.goto(`/join/${invite.code}`);
    await expect(guest.getByRole('heading', { name: 'Join a server' })).toBeVisible();
    await guest.getByRole('button', { name: 'Sign in as guest' }).click();
    await expect(guest.getByText(/^Signed in as /)).toBeVisible({ timeout: 30_000 });
    await guest.getByRole('button', { name: 'Accept invite' }).click();
    await expect(guest.getByText(/^Joined /)).toBeVisible({ timeout: 15_000 });
    await expect(guest.getByText(/redeem →|Failed to redeem/)).toHaveCount(0);
    await guest.screenshot({ path: testInfo.outputPath('joined-with-expiring-invite.png') });
    const { servers } = (await (await guest.context().request.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    expect(servers.map((s) => s.id)).toContain(serverId);
  });

  test('signing up with an expiring invite creates the account and the membership', async () => {
    const created = await owner.post(`/api/servers/${serverId}/invites`, {
      headers: ORIGIN,
      data: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxUses: 5 },
    });
    expect(created.status()).toBe(201);
    const { invite } = (await created.json()) as { invite: Invite };
    const ctx = await newContext();
    const res = await registerAccount(ctx.request, {
      headers: ORIGIN,
      data: { email: `inv-signup-${RUN}@e2e.local`, password: 'correct-horse-battery-staple', displayName: `Inv ${RUN.slice(-4)}`, inviteCode: invite.code },
    });
    expect(res.status(), await res.text()).toBe(201);
    const { servers } = (await (await ctx.request.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    expect(servers.map((s) => s.id)).toContain(serverId);
  });

  test('an expired invite is refused with 403, and /join says so in words', async ({}, testInfo) => {
    const created = await owner.post(`/api/servers/${serverId}/invites`, {
      headers: ORIGIN,
      data: { expiresAt: new Date(Date.now() + 2_500).toISOString() },
    });
    expect(created.status()).toBe(201);
    const { invite } = (await created.json()) as { invite: Invite };
    await new Promise((r) => setTimeout(r, 3_500));

    const page = await (await newContext()).newPage();
    await page.goto(`/join/${invite.code}`);
    await expect(page.getByRole('heading', { name: 'Join a server' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in as guest' }).click();
    await expect(page.getByText(/^Signed in as /)).toBeVisible({ timeout: 30_000 });
    const redeem = await page.context().request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN });
    expect(redeem.status()).toBe(403);
    expect(await redeem.json()).toEqual({ error: 'Invite is unavailable' });
    const accept = page.getByRole('button', { name: 'Accept invite' });
    if (await accept.isEnabled().catch(() => false)) await accept.click();
    await expect(page.getByText(/This invite has expired|EXPIRED/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/redeem →|Failed to redeem/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('expired-invite.png') });
  });
});
