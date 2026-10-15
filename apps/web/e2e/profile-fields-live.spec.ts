/**
 * Profile fields, mentions and live updates through the real lobby
 * (docs/PROFILES.md "Profile fields", "Mentions", "Live updates"):
 *
 *   - a member sets a handle (checked as they type), pronouns and a profile
 *     colour in Settings → Profile; another member's card shows
 *     `@handle · pronouns` and the colour as the band; a taken handle is
 *     refused;
 *   - live member rows: a new name, a new role (with its own heading), a
 *     newcomer and a kick reach another member's open lobby without a reload;
 *   - mentions: a name picked from the @ list and a typed @handle become
 *     chips; the member named gets a badge on that channel while elsewhere,
 *     then sees the message highlighted; a chip opens the profile card;
 *   - DMs: a first message from someone else appears in the open lobby's DM
 *     list with an unread dot, which opening it clears;
 *   - "Load older messages" pages back past the newest 50;
 *   - voice: the roster shows the member's photo;
 *   - bans: a ban with a length from the card; the Members page lists it and
 *     lifts it;
 *   - screenshots in dark and light.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Everything it makes
 * is removed at the end.
 */
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { resetRateLimits } from './helpers/auth';
import {
  accountMember,
  baseUrl,
  createChannel,
  deleteChannel,
  everyoneRole,
  FAKE_MEDIA_ARGS,
  firstServerId,
  guestMember,
  json,
  ORIGIN,
  ownerContext,
  psql,
  send,
  setRoles,
  SHOT_DIR,
  type Person,
} from './helpers/stack';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 150_000 });

const CONTEXT = {
  viewport: { width: 1280, height: 800 },
  colorScheme: 'dark' as const,
  permissions: ['microphone', 'camera'],
};
const RUN = Date.now().toString(36);
const IVY = 'Ivy Novak';
const OMAR = 'Omar Reyes';
const HANDLE = `ivy_${RUN}`.slice(0, 32);
const PRONOUNS = 'she/her';
const ACCENT = '#22c55e';
const ROLE_NAME = `Cartographers ${RUN}`;
const SIDE_CHANNEL = `side-${RUN}`;
const OLD_CHANNEL = `archive-${RUN}`;
const VOICE_ROOM = `fields-voice-${RUN}`;

function shotPath(testInfo: TestInfo, file: string): string {
  return SHOT_DIR ? join(SHOT_DIR, file) : testInfo.outputPath(file);
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath(testInfo, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

function memberRow(page: Page, name: string) {
  return page.locator('aside [data-user-popover-anchor]').filter({ hasText: name }).first();
}

function card(page: Page, name: string) {
  return page.locator('[data-profile-card]').and(page.getByRole('dialog', { name: `${name} profile` }));
}

function channelButton(page: Page, name: string) {
  return page.locator('button[data-mobile-nav-close]').filter({ hasText: name }).first();
}

test.describe('profile fields, mentions and live updates', () => {
  let browser: Browser;
  let owner: Person;
  let ownerPage: Page;
  let serverId = '';
  let sideId = '';
  let oldId = '';
  let voiceId = '';
  let roleId = '';
  let ivy: Person & { page: Page };
  let omar: Person & { page: Page };
  const extra: Person[] = [];

  async function openLobby(page: Page, channelId?: string) {
    await page.goto(`/lobby?server=${serverId}`);
    await expect(page.locator('aside [data-user-popover-anchor]').first()).toBeVisible({ timeout: 20_000 });
    if (channelId) {
      const name = channelId === sideId ? SIDE_CHANNEL : channelId === oldId ? OLD_CHANNEL : null;
      if (name) await channelButton(page, name).click();
    }
  }

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(300_000);
    resetRateLimits();
    browser = await playwright.chromium.launch({ args: [...FAKE_MEDIA_ARGS] });
    owner = await ownerContext(browser, CONTEXT);
    serverId = await firstServerId(owner.api);
    sideId = await createChannel(owner.api, serverId, SIDE_CHANNEL, 'text');
    oldId = await createChannel(owner.api, serverId, OLD_CHANNEL, 'text');
    voiceId = await createChannel(owner.api, serverId, VOICE_ROOM, 'voice');
    const role = await send(() =>
      owner.api.post(`/api/servers/${serverId}/roles`, {
        headers: ORIGIN,
        data: { name: ROLE_NAME, permissions: [], position: 6, color: '#a855f7', displaySeparately: true },
      })
    );
    expect(role.status(), await role.text()).toBe(201);
    roleId = (await json<{ role: { id: string } }>(role)).role.id;

    const i = await accountMember(browser, owner.api, serverId, IVY, CONTEXT);
    const o = await accountMember(browser, owner.api, serverId, OMAR, CONTEXT);
    ivy = { ...i, page: await i.ctx.newPage() };
    omar = { ...o, page: await o.ctx.newPage() };
    ownerPage = await owner.ctx.newPage();

    // Ivy's photo (the voice roster shows it): a flat colour is enough.
    const drawing = await owner.ctx.newPage();
    await drawing.setContent('<!doctype html><title>draw</title>');
    const dataUrl = await drawing.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#0ea5e9';
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = '#ffffff';
      g.font = 'bold 110px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('IN', 128, 136);
      return canvas.toDataURL('image/png');
    });
    await drawing.close();
    const uploaded = await send(() => ivy.api.post('/api/users/me/avatar', { headers: ORIGIN, data: { dataUrl } }));
    expect(uploaded.status(), await uploaded.text()).toBe(200);
  });

  test.afterAll(async () => {
    if (owner && serverId) {
      for (const p of [ivy, omar, ...extra]) {
        if (p?.uid) {
          await send(() => owner.api.delete(`/api/servers/${serverId}/bans?userId=${p.uid}`, { headers: ORIGIN })).catch(() => undefined);
          await send(() => owner.api.delete(`/api/servers/${serverId}/members/${p.uid}`, { headers: ORIGIN })).catch(() => undefined);
        }
      }
      for (const id of [sideId, oldId, voiceId]) if (id) await deleteChannel(owner.api, serverId, id);
      if (roleId) await send(() => owner.api.delete(`/api/servers/${serverId}/roles/${roleId}`, { headers: ORIGIN })).catch(() => undefined);
    }
    for (const p of [ivy, omar, ...extra]) await p?.ctx.close().catch(() => undefined);
    await owner?.ctx.close().catch(() => undefined);
    await browser?.close();
  });

  test('a handle, pronouns and a profile colour from Settings show on the card for others', async ({}, testInfo) => {
    const page = ivy.page;
    await page.goto('/settings/profile');
    await page.getByRole('button', { name: 'Edit: Username' }).click();
    const input = page.getByRole('textbox', { name: 'Username' });
    // The rules answer at once, the server after a pause.
    await input.fill('a');
    await expect(page.getByText('A username needs at least 2 characters.')).toBeVisible();
    await input.fill('everyone');
    await expect(page.getByText('That username is reserved.')).toBeVisible();
    await input.fill(HANDLE.toUpperCase());
    await expect(page.getByText(`@${HANDLE} is available.`)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(`@${HANDLE}`, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit: Pronouns' }).click();
    await page.getByRole('textbox', { name: 'Pronouns' }).fill(PRONOUNS);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('radio', { name: `Use ${ACCENT}` }).click();
    await expect(page.getByRole('radio', { name: `Use ${ACCENT}` })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('profile-preview-handle')).toHaveText(`@${HANDLE} · ${PRONOUNS}`);
    await shoot(page, testInfo, 'fields-settings');

    // Someone else holds it now.
    const taken = await send(() => omar.api.patch('/api/users/me/profile', { headers: ORIGIN, data: { username: HANDLE } }));
    expect(taken.status()).toBe(409);
    expect((await json<{ code: string }>(taken)).code).toBe('username_taken');

    // Omar opens Ivy's card.
    await openLobby(omar.page);
    await memberRow(omar.page, IVY).click();
    const ivyCard = card(omar.page, IVY);
    await expect(ivyCard.getByTestId('profile-username')).toHaveText(`@${HANDLE}`);
    await expect(ivyCard.getByTestId('profile-pronouns')).toContainText(PRONOUNS);
    await expect(ivyCard.locator('[data-banner-band]')).toHaveCSS('background-color', 'rgb(34, 197, 94)');
    await expect(ivyCard.locator('[data-profile-accent-ring]')).toBeVisible();
    await shoot(omar.page, testInfo, 'fields-card');
    await omar.page.keyboard.press('Escape');
  });

  test('live member rows: a new name, a new role, a newcomer and a kick, without a reload', async () => {
    const page = omar.page;
    await openLobby(page);
    await expect(memberRow(page, IVY)).toBeVisible();
    const marker = await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = Date.now()));

    const renamed = `${IVY} ${RUN}`;
    expect((await send(() => ivy.api.patch('/api/users/me/profile', { headers: ORIGIN, data: { displayName: renamed } }))).status()).toBe(200);
    await expect(memberRow(page, renamed)).toBeVisible({ timeout: 10_000 });

    const everyone = await everyoneRole(owner.api, serverId);
    expect((await setRoles(owner.api, serverId, ivy.uid, [everyone.id, roleId])).status()).toBe(200);
    await expect(page.locator('aside h3', { hasText: ROLE_NAME })).toBeVisible({ timeout: 10_000 });

    const newcomer = await guestMember(browser, owner.api, serverId, `Newcomer ${RUN}`, CONTEXT);
    extra.push(newcomer);
    await expect(memberRow(page, newcomer.name)).toBeVisible({ timeout: 10_000 });
    expect((await send(() => owner.api.delete(`/api/servers/${serverId}/members/${newcomer.uid}`, { headers: ORIGIN }))).status()).toBe(200);
    await expect(memberRow(page, newcomer.name)).toHaveCount(0, { timeout: 10_000 });

    // The same page all along.
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(marker);
    // Back to the old name for the next tests.
    expect((await send(() => ivy.api.patch('/api/users/me/profile', { headers: ORIGIN, data: { displayName: IVY } }))).status()).toBe(200);
    await expect(memberRow(page, IVY)).toBeVisible({ timeout: 10_000 });
  });

  test('mentions: a picked name and a typed handle are chips; a badge elsewhere, a highlight, the card', async ({}, testInfo) => {
    // Ivy looks at another channel.
    await openLobby(ivy.page, sideId);
    await expect(channelButton(ivy.page, SIDE_CHANNEL)).toHaveAttribute('aria-current', 'page');

    // Omar, in the first channel, picks Ivy from the @ list and types her handle too.
    const page = omar.page;
    await openLobby(page);
    const composer = page.locator('[data-composer-input]');
    await composer.click();
    await composer.pressSequentially('hello @Iv');
    await page.getByRole('button', { name: new RegExp(IVY) }).click();
    await composer.pressSequentially(`and @${HANDLE} again ${RUN}`);
    await composer.press('Enter');
    await expect(page.getByText(`again ${RUN}`)).toBeVisible();

    // Ivy's sidebar: a badge on the first channel, without a reload.
    const badge = ivy.page.getByTestId('channel-mention-badge');
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText('1');
    await shoot(ivy.page, testInfo, 'mention-badge');

    // Opening it: the badge goes, the message is highlighted, two chips.
    await ivy.page.locator('button[data-mobile-nav-close]').filter({ has: badge }).click();
    await expect(badge).toHaveCount(0);
    const row = ivy.page.locator('[data-chat-message]').filter({ hasText: `again ${RUN}` }).first();
    await expect(row).toHaveAttribute('data-mentions-me', 'true');
    const chips = row.getByTestId('chat-mention');
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toHaveText(`@${IVY}`);
    await expect(chips.nth(1)).toHaveText(`@${HANDLE}`);
    await shoot(ivy.page, testInfo, 'mention-highlight');
    await chips.first().click();
    await expect(card(ivy.page, IVY)).toBeVisible();
    await ivy.page.keyboard.press('Escape');
  });

  test('a first DM from someone else appears in the DM list with an unread dot', async () => {
    await openLobby(ivy.page);
    const opened = await send(() => omar.api.post('/api/dm', { headers: ORIGIN, data: { recipientUserId: ivy.uid } }));
    expect(opened.status(), await opened.text()).toBeLessThan(300);
    const channelId = (await json<{ channel: { id: string } }>(opened)).channel.id;
    const sent = await send(() =>
      omar.api.post(`/api/dm/${channelId}/messages`, { headers: ORIGIN, data: { content: `psst ${RUN}` } })
    );
    expect(sent.status(), await sent.text()).toBe(201);
    const row = ivy.page.locator(`[data-dm-row="${channelId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByTestId('dm-unread-dot')).toBeVisible();
    await row.click();
    await expect(ivy.page.getByText(`psst ${RUN}`)).toBeVisible();
    await expect(row.getByTestId('dm-unread-dot')).toHaveCount(0);
  });

  test('"Load older messages" pages back past the newest 50', async () => {
    const inserted = psql(
      `INSERT INTO messages (channel_id, user_id, content, created_at) SELECT '${oldId}', '${owner.uid}', 'archived line ' || g, now() - (g || ' minutes')::interval FROM generate_series(1, 60) g`
    );
    test.skip(inserted === null, 'needs the stack Postgres (docker exec)');
    await openLobby(ivy.page, oldId);
    await expect(ivy.page.getByText('archived line 1', { exact: true })).toBeVisible();
    await expect(ivy.page.getByText('archived line 60', { exact: true })).toHaveCount(0);
    await ivy.page.getByTestId('chat-load-older').click();
    await expect(ivy.page.getByText('archived line 60', { exact: true })).toBeAttached({ timeout: 10_000 });
    await expect(ivy.page.getByTestId('chat-load-older')).toHaveCount(0);
  });

  test('the voice roster shows the photo', async () => {
    await openLobby(ivy.page);
    const room = ivy.page.getByRole('button', { name: VOICE_ROOM }).first();
    await room.click();
    await expect(ivy.page.getByText('Voice Connected').first()).toBeVisible({ timeout: 30_000 });
    await openLobby(omar.page);
    const roster = omar.page.locator('[data-user-popover-anchor]').filter({ hasText: IVY }).locator('[data-voice-avatar="photo"]');
    await expect(roster.first()).toBeVisible({ timeout: 20_000 });
    await ivy.page.goto('about:blank');
  });

  test('a ban with a length from the card; the Members page lists it and lifts it', async ({}, testInfo) => {
    const target = await guestMember(browser, owner.api, serverId, `Rowdy ${RUN}`, CONTEXT);
    extra.push(target);
    await openLobby(ownerPage);
    await memberRow(ownerPage, target.name).click();
    const targetCard = card(ownerPage, target.name);
    await targetCard.getByRole('button', { name: /More actions/ }).click();
    await ownerPage.getByRole('menuitem', { name: 'Ban' }).click();
    await ownerPage.getByTestId('ban-duration').selectOption('1d');
    await ownerPage.getByRole('alertdialog').getByRole('button', { name: 'Ban', exact: true }).click();
    await expect(memberRow(ownerPage, target.name)).toHaveCount(0, { timeout: 10_000 });

    const bans = await json<{ bans: Array<{ userId: string; expiresAt: string | null }> }>(await owner.api.get(`/api/servers/${serverId}/bans`));
    const ban = bans.bans.find((b) => b.userId === target.uid);
    expect(ban?.expiresAt, 'a one-day ban').toBeTruthy();
    expect(Date.parse(ban!.expiresAt!) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    await ownerPage.goto('/admin/settings/members');
    const section = ownerPage.getByTestId('bans-section');
    const banRow = section.locator(`[data-ban-user="${target.uid}"]`);
    await expect(banRow).toBeVisible({ timeout: 15_000 });
    await expect(banRow).toContainText('until');
    await shoot(ownerPage, testInfo, 'bans-section');
    await banRow.getByRole('button', { name: new RegExp(`Lift .*ban`) }).click();
    await banRow.getByRole('button', { name: 'Lift ban', exact: true }).click();
    await expect(banRow).toHaveCount(0);
    const after = await json<{ bans: Array<{ userId: string }> }>(await owner.api.get(`/api/servers/${serverId}/bans`));
    expect(after.bans.some((b) => b.userId === target.uid)).toBe(false);
  });
});
