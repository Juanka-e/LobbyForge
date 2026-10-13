/**
 * The Discord-like profile card through the real lobby (docs/PROFILES.md):
 *
 *   - the same card opens from the member list, a chat author and the
 *     voice roster (left click — right-click keeps the moderator menu);
 *   - the avatar opens in the image viewer;
 *   - "Message @name" opens the DM, sends the message there and shows the
 *     conversation in the centre column;
 *   - the full profile's About and Mutual communities tabs;
 *   - a moderator times a member out from the "⋯" menu; a plain member
 *     gets no moderation items and the route refuses them;
 *   - a hidden profile ("Nobody") shows only the name;
 *   - screenshots in dark and light, and at 390 px.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Screenshots go to
 * the test's output directory.
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 150_000 });

interface Person {
  ctx: BrowserContext;
  page: Page;
  uid: string;
  name: string;
}

async function shootBothThemes(page: Page, path: (theme: string) => string) {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path(colorScheme) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

/** A member-list row (chat authors, the voice roster and the account avatar open the same card). */
function memberRow(page: Page, name: string) {
  return page.locator('aside [data-user-popover-anchor]').filter({ hasText: name }).first();
}

function card(page: Page, name: string) {
  return page.locator('[data-profile-card]').and(page.getByRole('dialog', { name: `${name} profile` }));
}

test.describe('profile card', () => {
  let browser: Browser;
  let ownerCtx: BrowserContext;
  let owner: APIRequestContext;
  let ownerName = 'Owner';
  let serverId = '';
  let textChannelId = '';
  let voiceChannelId = '';
  const voiceChannelName = `profile-room-${RUN}`;
  let modRoleId = '';
  let everyoneRoleId = '';
  let moderator: Person;
  let member: Person;
  let viewer: Person;
  let hidden: Person;

  async function person(seed: string): Promise<Person> {
    const ctx = await browser.newContext({
      baseURL: baseUrl,
      locale: 'en-US',
      viewport: { width: 1360, height: 860 },
      colorScheme: 'dark',
      permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
    });
    expect((await createGuest(ctx.request, { headers: ORIGIN, data: { displayNameSeed: `${seed} ${RUN.slice(-4)}` } })).status()).toBe(200);
    const invite = await owner.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(invite.status()).toBe(201);
    const { invite: inv } = (await invite.json()) as { invite: { code: string } };
    expect((await ctx.request.post(`/api/invites/${inv.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    const me = (await (await ctx.request.get('/api/auth/guest')).json()) as { guest: { uid: string; name: string } };
    return { ctx, page: await ctx.newPage(), uid: me.guest.uid, name: me.guest.name };
  }

  async function openLobby(page: Page) {
    await page.goto(`/lobby?server=${serverId}`);
    await expect(page.locator('aside [data-user-popover-anchor]').first()).toBeVisible({ timeout: 20_000 });
  }

  test.beforeAll(async ({ playwright }) => {
    resetRateLimits();
    test.setTimeout(150_000);
    // Fake media, and WITHOUT the config's --disable-web-security (it drops
    // the Origin header; the CSRF guard then refuses every POST).
    browser = await playwright.chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
      ],
    });
    ownerCtx = await browser.newContext({ baseURL: baseUrl, locale: 'en-US', viewport: { width: 1360, height: 860 }, colorScheme: 'dark' });
    owner = ownerCtx.request;
    const setup = await owner.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Profile Card E2E',
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
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string; ownerUserId: string }> };
    serverId = servers[0]!.id;

    const { roles } = (await (await owner.get(`/api/servers/${serverId}/roles`)).json()) as {
      roles: Array<{ id: string; name: string; position: number }>;
    };
    everyoneRoleId = roles.filter((r) => r.name === '@everyone').sort((a, b) => a.position - b.position)[0]!.id;
    const { channels } = (await (await owner.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; name: string; type: string }>;
    };
    textChannelId = channels.find((c) => c.type === 'text')!.id;
    const room = await owner.post(`/api/servers/${serverId}/channels`, { headers: ORIGIN, data: { name: voiceChannelName, type: 'voice' } });
    expect(room.status()).toBe(201);
    voiceChannelId = ((await room.json()) as { channel: { id: string } }).channel.id;

    // Moderate Members, ranked ABOVE @everyone.
    const role = await owner.post(`/api/servers/${serverId}/roles`, {
      headers: ORIGIN,
      data: { name: `Profile mods ${RUN}`, permissions: ['moderate_members'], position: 10 },
    });
    expect(role.status(), await role.text()).toBe(201);
    modRoleId = ((await role.json()) as { role: { id: string } }).role.id;

    // The owner gets a photo (guests may not store images): a 256 px PNG drawn in a page.
    const drawPage = await ownerCtx.newPage();
    await drawPage.goto('/lobby');
    const dataUrl = await drawPage.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath();
      ctx.arc(128, 128, 80, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL('image/png');
    });
    await drawPage.close();
    const avatar = await owner.post('/api/users/me/avatar', { headers: ORIGIN, data: { dataUrl } });
    expect(avatar.status(), await avatar.text()).toBe(200);
    // The owner's name as the community shows it (a warm stack may have renamed them).
    const ownerProfile = await owner.get(`/api/servers/${serverId}/members/${servers[0]!.ownerUserId}/profile`);
    expect(ownerProfile.status()).toBe(200);
    ownerName = ((await ownerProfile.json()) as { profile: { displayName: string } }).profile.displayName;

    moderator = await person('Moderator');
    member = await person('Member');
    viewer = await person('Viewer');
    hidden = await person('Hidden');
    // The role list is REPLACED: keep @everyone next to the new role.
    const assign = await owner.put(`/api/servers/${serverId}/members/${moderator.uid}/role`, {
      headers: ORIGIN,
      data: { roleIds: [everyoneRoleId, modRoleId] },
    });
    expect(assign.status()).toBe(200);

    // The member writes in chat and fills in their profile.
    expect(
      (await member.ctx.request.patch('/api/users/me/profile', { headers: ORIGIN, data: { bio: `Hello, I build castles (${RUN})`, statusText: 'Building' } })).status()
    ).toBe(200);
    const posted = await member.ctx.request.post(`/api/servers/${serverId}/channels/${textChannelId}/messages`, {
      headers: ORIGIN,
      data: { content: `profile card check ${RUN}` },
    });
    expect(posted.status(), await posted.text()).toBe(201);

    // "Hidden" keeps their profile to themselves.
    expect(
      (await hidden.ctx.request.patch('/api/users/me/profile', { headers: ORIGIN, data: { bio: `secret bio ${RUN}` } })).status()
    ).toBe(200);
    const privacy = await hidden.ctx.request.patch('/api/settings/me', {
      headers: ORIGIN,
      data: {
        privacy: {
          profileVisibility: 'nobody',
          onlineStatusVisibility: 'server_members',
          activityVisibility: 'server_members',
          showCurrentGame: true,
          showMusicStatus: true,
          showWatchPartyStatus: true,
          showServerNameInActivity: false,
        },
      },
    });
    expect(privacy.status(), await privacy.text()).toBe(200);
  });

  test.afterAll(async () => {
    for (const p of [moderator, member, viewer, hidden]) await p?.ctx.close();
    if (owner && serverId) {
      if (voiceChannelId) await owner.delete(`/api/servers/${serverId}/channels/${voiceChannelId}`, { headers: ORIGIN }).catch(() => undefined);
      if (modRoleId) await owner.delete(`/api/servers/${serverId}/roles/${modRoleId}`, { headers: ORIGIN }).catch(() => undefined);
    }
    await ownerCtx?.close();
    await browser?.close();
  });

  test('the same card opens from the member list, a chat author and the voice roster', async ({}, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    // The member sits in the voice room, so the viewer's roster lists them.
    await member.page.goto(`/lobby?server=${serverId}`);
    const channel = member.page.getByRole('button', { name: voiceChannelName }).filter({ has: member.page.locator('span', { hasText: 'volume_up' }) });
    await channel.first().click();
    await expect(member.page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });

    const page = viewer.page;
    await openLobby(page);

    // 1. The member list.
    await memberRow(page, member.name).click();
    let profile = card(page, member.name);
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('heading', { name: 'About me' })).toBeVisible();
    await expect(profile.getByTestId('profile-about-body')).toHaveText(`Hello, I build castles (${RUN})`);
    await expect(profile.getByText('Member since')).toBeVisible();
    await expect(profile.getByText('Building')).toBeVisible();
    await expect(profile.getByText('In voice')).toBeVisible();
    // Keyboard: focus is inside the card; Escape closes it and focus is back on the row.
    expect(await profile.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await shootBothThemes(page, shot('1-member-list-card'));
    await page.keyboard.press('Escape');
    await expect(profile).toHaveCount(0);
    expect(await memberRow(page, member.name).evaluate((el) => el === document.activeElement)).toBe(true);

    // 2. A chat author's name.
    const author = page.getByTestId('chat-author').filter({ hasText: member.name }).first();
    await expect(author).toBeVisible({ timeout: 15_000 });
    await author.click();
    profile = card(page, member.name);
    await expect(profile).toBeVisible();
    // One card at a time: the roster entry switches it.
    const rosterEntry = page.locator('nav [data-user-popover-anchor]').filter({ hasText: member.name }).first();
    await expect(rosterEntry).toBeVisible({ timeout: 20_000 });
    await rosterEntry.click();
    await expect(page.locator('[data-profile-card]')).toHaveCount(1);
    await expect(card(page, member.name)).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('the avatar opens in the image viewer', async ({}, testInfo) => {
    const page = viewer.page;
    await openLobby(page);
    await memberRow(page, ownerName).click();
    const profile = card(page, ownerName);
    await expect(profile).toBeVisible();
    await profile.getByRole('button', { name: `View ${ownerName}'s profile photo` }).click();
    const lightbox = page.getByRole('dialog', { name: `${ownerName}'s profile photo` });
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('img')).toHaveAttribute('src', /\/api\/users\/[0-9a-f-]+\/avatar\?v=/);
    await expect(lightbox.getByRole('link', { name: /Open original/ })).toHaveAttribute('href', /\/avatar\?v=/);
    await page.screenshot({ path: testInfo.outputPath('2-avatar-lightbox.png') });
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    // The card stays; Escape again closes it.
    await expect(profile).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(profile).toHaveCount(0);
  });

  test('"Message @name" sends a DM and shows the conversation', async () => {
    const page = viewer.page;
    await openLobby(page);
    await memberRow(page, member.name).click();
    const profile = card(page, member.name);
    const box = profile.getByRole('textbox', { name: `Message @${member.name}` });
    await expect(box).toBeVisible();
    const text = `hi from the card ${RUN}`;
    await box.fill(text);
    await box.press('Enter');
    await expect(profile).toHaveCount(0);
    await expect(page.getByTestId('dm-header-profile')).toContainText(member.name, { timeout: 15_000 });
    await expect(page.getByText(text)).toBeVisible({ timeout: 15_000 });
    // The DM header opens the same card.
    await page.getByTestId('dm-header-profile').click();
    await expect(card(page, member.name)).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('the full profile has About and Mutual communities tabs', async ({}, testInfo) => {
    const page = viewer.page;
    await openLobby(page);
    await memberRow(page, member.name).click();
    await card(page, member.name).getByRole('button', { name: 'View full profile' }).click();
    const modal = page.locator('[data-full-profile]');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');
    await expect(modal.getByRole('tabpanel')).toContainText(`Hello, I build castles (${RUN})`);
    const mutualTab = modal.getByRole('tab', { name: /mutual communit/ });
    await mutualTab.click();
    await expect(mutualTab).toHaveAttribute('aria-selected', 'true');
    await expect(modal.getByRole('tabpanel').getByRole('link').first()).toHaveAttribute('href', `/lobby?server=${serverId}`);
    await shootBothThemes(page, (theme) => testInfo.outputPath(`3-full-profile-${theme}.png`));
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('a moderator times a member out from the ⋯ menu; a plain member cannot', async ({}, testInfo) => {
    // The plain member: no moderation in the menu, and the route refuses.
    await openLobby(viewer.page);
    await memberRow(viewer.page, member.name).click();
    await card(viewer.page, member.name).getByRole('button', { name: `More actions for ${member.name}` }).click();
    const plainMenu = viewer.page.getByRole('menu', { name: `More actions for ${member.name}` });
    await expect(plainMenu.getByRole('menuitem', { name: /Copy user ID/ })).toBeVisible();
    await expect(plainMenu.getByRole('menuitem', { name: /Timeout/ })).toHaveCount(0);
    await expect(plainMenu.getByRole('menuitem', { name: /Kick|Ban/ })).toHaveCount(0);
    const refused = await viewer.ctx.request.put(`/api/servers/${serverId}/members/${member.uid}/timeout`, {
      headers: ORIGIN,
      data: { until: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(refused.status()).toBe(403);
    await viewer.page.keyboard.press('Escape');

    // The moderator.
    const page = moderator.page;
    await openLobby(page);
    await memberRow(page, member.name).click();
    const profile = card(page, member.name);
    await profile.getByRole('button', { name: `More actions for ${member.name}` }).click();
    const menu = page.getByRole('menu', { name: `More actions for ${member.name}` });
    await expect(menu.getByRole('menuitem', { name: /Kick|Ban/ })).toHaveCount(0); // Moderate Members only
    await menu.getByRole('menuitem', { name: /Timeout/ }).click();
    const dialog = page.getByRole('alertdialog', { name: `Time out ${member.name}` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: '5 minutes' }).check();
    await shootBothThemes(page, (theme) => testInfo.outputPath(`4-timeout-dialog-${theme}.png`));
    await dialog.getByRole('button', { name: 'Time out' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(profile.getByRole('status')).toHaveText(`${member.name} is timed out.`);
    await expect(profile.getByText(/Timed out until/)).toBeVisible({ timeout: 10_000 });

    // Lift it again so later specs find the member unrestricted.
    const lift = await moderator.ctx.request.put(`/api/servers/${serverId}/members/${member.uid}/timeout`, {
      headers: ORIGIN,
      data: { until: null },
    });
    expect(lift.status()).toBe(200);
  });

  test('a hidden profile shows only the name', async ({}, testInfo) => {
    const page = viewer.page;
    await openLobby(page);
    await memberRow(page, hidden.name).click();
    const profile = card(page, hidden.name);
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('heading', { name: hidden.name })).toBeVisible();
    await expect(profile.getByTestId('profile-about-body')).toHaveText(/profile details aren't available/);
    await expect(profile.getByText(`secret bio ${RUN}`)).toHaveCount(0);
    await expect(profile.getByText('Member since')).toHaveCount(0);
    // The API agrees: names only.
    const api = await viewer.ctx.request.get(`/api/servers/${serverId}/members/${hidden.uid}/profile`);
    expect(api.status()).toBe(200);
    const body = (await api.json()) as { profile: Record<string, unknown> };
    expect(body.profile).toMatchObject({ bio: null, statusText: null, avatarUrl: null, bannerUrl: null, memberSince: null, limited: true });
    expect(JSON.stringify(body)).not.toContain(`secret bio ${RUN}`);
    await page.screenshot({ path: testInfo.outputPath('5-hidden-profile.png') });
    await page.keyboard.press('Escape');
  });

  test('the card fits a 390 px phone', async ({}, testInfo) => {
    const page = viewer.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/lobby?server=${serverId}`);
    // On a phone the member list is hidden: open a chat author's card.
    const author = page.getByTestId('chat-author').filter({ hasText: member.name }).first();
    await expect(author).toBeVisible({ timeout: 20_000 });
    await author.click();
    const profile = card(page, member.name);
    await expect(profile).toBeVisible();
    const box = await profile.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await shootBothThemes(page, (theme) => testInfo.outputPath(`6-phone-${theme}.png`));
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1360, height: 860 });
  });
});
