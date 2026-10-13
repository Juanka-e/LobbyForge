/**
 * The Discord-like profile card through the real lobby (docs/PROFILES.md),
 * with registered members who have real photos, banners and bios:
 *
 *   - the same card opens from the member list, a chat author and the
 *     voice roster (left click — right-click keeps the moderator menu);
 *     keyboard: focus moves into the card and stays there, Escape closes
 *     it and focus goes back to the opener;
 *   - the avatar opens in the image viewer; Escape and a backdrop click
 *     close it;
 *   - "Message @name" opens the DM and sends the message; it arrives on
 *     the other side (after a load, and live while the DM is open);
 *   - the full profile's About and Mutual communities tabs;
 *   - a moderator times a member out from the "⋯" menu and lifts it again;
 *     a plain member gets no moderation items and the route refuses them;
 *   - roles added and removed from the card; the member list regroups at
 *     once;
 *   - a hidden profile ("Nobody") shows only the name;
 *   - your own card has "Edit profile" and the status picker;
 *   - the community menu offers a moderator the audit log;
 *   - the voice roster's mute icon is a named image;
 *   - the card fits a 390 px phone;
 *   - screenshots in dark and light.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Screenshots go to
 * LF_E2E_SHOT_DIR when it is set, else to the test's output directory.
 * Everything it makes (members, roles, the voice room) is removed at the
 * end, and leftovers of an interrupted run are removed first, so the names
 * can stay real-looking.
 */
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { resetRateLimits } from './helpers/auth';
import {
  accountMember,
  baseUrl,
  everyoneRole,
  FAKE_MEDIA_ARGS,
  firstServerId,
  guestMember,
  json,
  listChannels,
  listRoles,
  ORIGIN,
  ownerContext,
  send,
  setRoles,
  SHOT_DIR,
  type Person,
} from './helpers/stack';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 150_000 });

const VIEWPORT = { width: 1280, height: 800 };
const CONTEXT = {
  viewport: VIEWPORT,
  colorScheme: 'dark' as const,
  permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
};

// The people, the roles and the room. Real-looking names: every one is
// removed at the end (and before the start, if a run was interrupted).
const MEMBER_NAME = 'Maya Chen';
const MODERATOR_NAME = 'Theo Park';
const VIEWER_NAME = 'Lena Ortiz';
const HIDDEN_SEED = 'Sam Rivers';
const MOD_ROLE = 'Moderators';
const BUILDER_ROLE = 'Builders';
const CREW_ROLE = 'Castle Crew';
const VOICE_ROOM = 'castle-build';
const MEMBER_BIO = 'Building castles in every sandbox I can find. Ask me about drawbridges.';
const MODERATOR_BIO = 'Keeping the peace since the first server.';
const MEMBER_STATUS = 'Sketching a new keep';
const CHAT_LINE = 'Anyone up for a castle build tonight? I will bring the blueprints.';
const RUN = Date.now().toString(36);

function shotPath(testInfo: TestInfo, file: string): string {
  return SHOT_DIR ? join(SHOT_DIR, file) : testInfo.outputPath(file);
}

/** Dark, then light, then back to dark. */
async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath(testInfo, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

/** A member-list row (chat authors, the voice roster and the account avatar open the same card). */
function memberRow(page: Page, name: string) {
  return page.locator('aside [data-user-popover-anchor]').filter({ hasText: name }).first();
}

/** One heading's group in the member list ("Castle Crew - 1", "Online - 3"…). */
function memberGroup(page: Page, heading: string | RegExp) {
  return page.locator('aside > div').filter({ has: page.locator('h3', { hasText: heading }) });
}

function card(page: Page, name: string) {
  return page.locator('[data-profile-card]').and(page.getByRole('dialog', { name: `${name} profile` }));
}

/**
 * The newest chat line by `name` (an earlier run's member of the same name
 * may have written too). The chat is `flex-col-reverse`: the newest
 * message comes FIRST in the DOM.
 */
function chatAuthor(page: Page, name: string) {
  return page.getByTestId('chat-author').filter({ hasText: name }).first();
}

async function joinVoice(page: Page) {
  const room = page
    .getByRole('button', { name: VOICE_ROOM })
    .filter({ has: page.locator('span', { hasText: 'volume_up' }) })
    .first();
  await room.click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
}

type Drawing =
  | { kind: 'avatar'; from: string; to: string; initials: string }
  | { kind: 'banner'; sky: [string, string]; hills: [string, string] };

/**
 * A PNG drawn on a canvas in a blank page: a gradient with a soft
 * highlight and initials (an avatar), or a dusk landscape (a banner,
 * 960 × 540 — the route's minimum).
 */
async function drawPng(page: Page, input: Drawing): Promise<string> {
  return page.evaluate((spec) => {
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d')!;
    if (spec.kind === 'avatar') {
      canvas.width = 256;
      canvas.height = 256;
      const grad = g.createLinearGradient(0, 0, 256, 256);
      grad.addColorStop(0, spec.from);
      grad.addColorStop(1, spec.to);
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.beginPath();
      g.arc(70, 60, 110, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = 'bold 104px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(spec.initials, 128, 136);
      return canvas.toDataURL('image/png');
    }
    canvas.width = 960;
    canvas.height = 540;
    const sky = g.createLinearGradient(0, 0, 0, 540);
    sky.addColorStop(0, spec.sky[0]);
    sky.addColorStop(1, spec.sky[1]);
    g.fillStyle = sky;
    g.fillRect(0, 0, 960, 540);
    g.fillStyle = 'rgba(255,236,170,0.9)';
    g.beginPath();
    g.arc(700, 250, 70, 0, Math.PI * 2);
    g.fill();
    const ridge = (color: string, base: number, amp: number, phase: number) => {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, 540);
      for (let x = 0; x <= 960; x += 20) g.lineTo(x, base - Math.sin(x / 140 + phase) * amp - Math.sin(x / 47 + phase) * amp * 0.25);
      g.lineTo(960, 540);
      g.closePath();
      g.fill();
    };
    ridge(spec.hills[0], 360, 60, 0.4);
    ridge(spec.hills[1], 430, 45, 2.1);
    return canvas.toDataURL('image/png');
  }, input);
}

test.describe('profile card', () => {
  let browser: Browser;
  let owner: Person;
  let ownerPage: Page;
  let serverId = '';
  let voiceChannelId = '';
  const roleIds: string[] = [];
  let modRoleId = '';
  let builderRoleId = '';
  let crewRoleId = '';
  let moderator: Person & { page: Page };
  let member: Person & { page: Page };
  let viewer: Person & { page: Page };
  let hidden: Person;
  /** The member's chat line, removed again at the end. */
  let chatLine: { channelId: string; messageId: string } | null = null;

  async function openLobby(page: Page) {
    await page.goto(`/lobby?server=${serverId}`);
    await expect(page.locator('aside [data-user-popover-anchor]').first()).toBeVisible({ timeout: 20_000 });
  }

  /** Leftovers of an interrupted run: members, roles and the room with this spec's names. */
  async function removeLeftovers() {
    // The members list carries ids, not names: each name comes from the
    // profile API (names are shown even on a hidden profile).
    const res = await send(() => owner.api.get(`/api/servers/${serverId}/members`));
    if (res.ok()) {
      const { members } = await json<{ members: Array<{ userId: string; isOwner: boolean }> }>(res);
      for (const row of members.filter((m) => !m.isOwner)) {
        const profile = await send(() => owner.api.get(`/api/servers/${serverId}/members/${row.userId}/profile`));
        if (!profile.ok()) continue;
        const { displayName, globalDisplayName } = (
          await json<{ profile: { displayName?: string | null; globalDisplayName?: string | null } }>(profile)
        ).profile;
        const names = [displayName ?? '', globalDisplayName ?? ''];
        const ours = names.some((n) => [MEMBER_NAME, MODERATOR_NAME, VIEWER_NAME].includes(n) || n.includes(HIDDEN_SEED));
        if (ours) await send(() => owner.api.delete(`/api/servers/${serverId}/members/${row.userId}`, { headers: ORIGIN }));
      }
    }
    for (const role of (await listRoles(owner.api, serverId)).filter((r) => [MOD_ROLE, BUILDER_ROLE, CREW_ROLE].includes(r.name))) {
      await send(() => owner.api.delete(`/api/servers/${serverId}/roles/${role.id}`, { headers: ORIGIN }));
    }
    for (const channel of (await listChannels(owner.api, serverId)).filter((c) => c.name === VOICE_ROOM)) {
      await send(() => owner.api.delete(`/api/servers/${serverId}/channels/${channel.id}`, { headers: ORIGIN }));
    }
  }

  async function newRole(data: Record<string, unknown>): Promise<string> {
    const res = await send(() => owner.api.post(`/api/servers/${serverId}/roles`, { headers: ORIGIN, data }));
    expect(res.status(), `role ${String(data.name)}: ${await res.text()}`).toBe(201);
    const id = (await json<{ role: { id: string } }>(res)).role.id;
    roleIds.push(id);
    return id;
  }

  async function upload(person: Person, kind: 'avatar' | 'banner', dataUrl: string) {
    const res = await send(() => person.api.post(`/api/users/me/${kind}`, { headers: ORIGIN, data: { dataUrl } }));
    expect(res.status(), `${person.name}'s ${kind}: ${await res.text()}`).toBe(200);
  }

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(300_000);
    resetRateLimits();
    // Fake media, and WITHOUT the config's --disable-web-security (it drops
    // the Origin header; the CSRF guard then refuses every POST).
    browser = await playwright.chromium.launch({ args: [...FAKE_MEDIA_ARGS] });
    owner = await ownerContext(browser, CONTEXT);
    serverId = await firstServerId(owner.api);
    await removeLeftovers();

    const everyone = await everyoneRole(owner.api, serverId);
    // Moderate Members and the audit log, ranked ABOVE @everyone, with its own heading.
    modRoleId = await newRole({
      name: MOD_ROLE,
      permissions: ['moderate_members', 'view_audit_log'],
      position: 10,
      color: '#3b82f6',
      icon: 'shield',
      displaySeparately: true,
    });
    builderRoleId = await newRole({ name: BUILDER_ROLE, permissions: [], position: 4, color: '#22c55e' });
    crewRoleId = await newRole({ name: CREW_ROLE, permissions: [], position: 5, color: '#f97316', displaySeparately: true });

    const room = await send(() => owner.api.post(`/api/servers/${serverId}/channels`, { headers: ORIGIN, data: { name: VOICE_ROOM, type: 'voice' } }));
    expect(room.status(), await room.text()).toBe(201);
    voiceChannelId = (await json<{ channel: { id: string } }>(room)).channel.id;

    // Registered accounts (guests may not store images), each joined by invite.
    const m = await accountMember(browser, owner.api, serverId, MEMBER_NAME, CONTEXT);
    const mod = await accountMember(browser, owner.api, serverId, MODERATOR_NAME, CONTEXT);
    const v = await accountMember(browser, owner.api, serverId, VIEWER_NAME, CONTEXT);
    hidden = await guestMember(browser, owner.api, serverId, HIDDEN_SEED, CONTEXT);

    // Photos and a banner, drawn on a canvas and uploaded through the real routes.
    const drawing = await owner.ctx.newPage();
    await drawing.setContent('<!doctype html><title>draw</title>');
    await upload(owner, 'avatar', await drawPng(drawing, { kind: 'avatar', from: '#7c3aed', to: '#db2777', initials: 'EO' }));
    await upload(m, 'avatar', await drawPng(drawing, { kind: 'avatar', from: '#f59e0b', to: '#ef4444', initials: 'MC' }));
    await upload(m, 'banner', await drawPng(drawing, { kind: 'banner', sky: ['#1e3a8a', '#f97316'], hills: ['#312e81', '#1e1b4b'] }));
    await upload(mod, 'avatar', await drawPng(drawing, { kind: 'avatar', from: '#0e7490', to: '#0f766e', initials: 'TP' }));
    await upload(v, 'avatar', await drawPng(drawing, { kind: 'avatar', from: '#65a30d', to: '#15803d', initials: 'LO' }));
    await drawing.close();

    // Roles: the role list is REPLACED, so @everyone goes with the new one.
    expect((await setRoles(owner.api, serverId, mod.uid, [everyone.id, modRoleId])).status()).toBe(200);
    expect((await setRoles(owner.api, serverId, m.uid, [everyone.id, builderRoleId])).status()).toBe(200);

    // The member fills in their profile and writes in chat.
    const filled = await send(() => m.api.patch('/api/users/me/profile', { headers: ORIGIN, data: { bio: MEMBER_BIO, statusText: MEMBER_STATUS } }));
    expect(filled.status(), await filled.text()).toBe(200);
    const textChannel = (await listChannels(owner.api, serverId)).find((c) => c.type === 'text')!;
    const posted = await send(() =>
      m.api.post(`/api/servers/${serverId}/channels/${textChannel.id}/messages`, { headers: ORIGIN, data: { content: CHAT_LINE } })
    );
    expect(posted.status(), await posted.text()).toBe(201);
    chatLine = { channelId: textChannel.id, messageId: (await json<{ message: { id: string } }>(posted)).message.id };
    expect((await send(() => mod.api.patch('/api/users/me/profile', { headers: ORIGIN, data: { bio: MODERATOR_BIO } }))).status()).toBe(200);

    // "Sam" keeps their profile to themselves.
    expect((await send(() => hidden.api.patch('/api/users/me/profile', { headers: ORIGIN, data: { bio: `secret bio ${RUN}` } }))).status()).toBe(200);
    const privacy = await send(() =>
      hidden.api.patch('/api/settings/me', {
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
      })
    );
    expect(privacy.status(), await privacy.text()).toBe(200);
    // Sam needs no browser from here on (at most about five contexts at once).
    await hidden.ctx.close();

    member = { ...m, page: await m.ctx.newPage() };
    moderator = { ...mod, page: await mod.ctx.newPage() };
    viewer = { ...v, page: await v.ctx.newPage() };
    ownerPage = await owner.ctx.newPage();
  });

  test.afterAll(async () => {
    if (owner && serverId) {
      // The chat line goes first, by its author, while they are still a member.
      if (chatLine && member) {
        const { channelId, messageId } = chatLine;
        await send(() => member.api.delete(`/api/servers/${serverId}/channels/${channelId}/messages/${messageId}`, { headers: ORIGIN })).catch(
          () => undefined
        );
      }
      for (const p of [member, moderator, viewer, hidden]) {
        if (p?.uid) await send(() => owner.api.delete(`/api/servers/${serverId}/members/${p.uid}`, { headers: ORIGIN })).catch(() => undefined);
      }
      if (voiceChannelId) await send(() => owner.api.delete(`/api/servers/${serverId}/channels/${voiceChannelId}`, { headers: ORIGIN })).catch(() => undefined);
      for (const id of roleIds) await send(() => owner.api.delete(`/api/servers/${serverId}/roles/${id}`, { headers: ORIGIN })).catch(() => undefined);
    }
    for (const p of [member, moderator, viewer]) await p?.ctx.close().catch(() => undefined);
    await owner?.ctx.close().catch(() => undefined);
    await browser?.close();
  });

  test('the same card opens from the member list, a chat author and the voice roster; the keyboard works', async ({}, testInfo) => {
    // The member sits in the voice room, so the viewer's roster lists them.
    await openLobby(member.page);
    await joinVoice(member.page);
    // The moderator is online too (under their role's heading).
    await openLobby(moderator.page);

    const page = viewer.page;
    await openLobby(page);

    // 1. The member list: a member with a banner and a bio.
    const row = memberRow(page, member.name);
    await expect(row).toBeVisible();
    await row.click();
    let profile = card(page, member.name);
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('heading', { name: 'About me' })).toBeVisible();
    await expect(profile.getByTestId('profile-about-body')).toHaveText(MEMBER_BIO);
    await expect(profile.getByText('Member since')).toBeVisible();
    await expect(profile.getByText(MEMBER_STATUS)).toBeVisible();
    await expect(profile.getByText('In voice')).toBeVisible({ timeout: 20_000 });
    await expect(profile.getByRole('listitem').filter({ hasText: BUILDER_ROLE })).toBeVisible();
    await expect(profile.getByRole('button', { name: `View ${member.name}'s banner` })).toBeVisible();
    // Keyboard: focus moved into the card; Tab and Shift+Tab stay inside it.
    expect(await profile.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await profile.evaluate((el) => el.contains(document.activeElement)), `Tab #${i + 1} stays in the card`).toBe(true);
    }
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await profile.evaluate((el) => el.contains(document.activeElement)), `Shift+Tab #${i + 1} stays in the card`).toBe(true);
    }
    // Back to the card itself for the screenshot (no focus ring on a control).
    await profile.focus();
    await shoot(page, testInfo, '01-card-member-list');
    // Escape closes it and focus is back on the row that opened it.
    await page.keyboard.press('Escape');
    await expect(profile).toHaveCount(0);
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);

    // 2. A member without a banner: the band takes the avatar's colour.
    await memberRow(page, moderator.name).click();
    const modCard = card(page, moderator.name);
    await expect(modCard).toBeVisible();
    await expect(modCard.getByTestId('profile-about-body')).toHaveText(MODERATOR_BIO);
    await expect(modCard.getByRole('button', { name: `View ${moderator.name}'s banner` })).toHaveCount(0);
    await modCard.focus();
    await page.waitForTimeout(500); // the band colour is sampled from the photo
    await shoot(page, testInfo, '02-card-no-banner');
    await page.keyboard.press('Escape');
    await expect(modCard).toHaveCount(0);

    // 3. A chat author's name.
    const author = chatAuthor(page, member.name);
    await expect(author).toBeVisible({ timeout: 15_000 });
    await author.click();
    profile = card(page, member.name);
    await expect(profile).toBeVisible();
    await expect(profile.getByTestId('profile-about-body')).toHaveText(MEMBER_BIO);
    await profile.focus();
    await shoot(page, testInfo, '03-card-chat-author');
    // One card at a time: the roster entry (left click) switches it.
    const rosterEntry = page.locator('nav [data-user-popover-anchor]').filter({ hasText: member.name }).first();
    await expect(rosterEntry).toBeVisible({ timeout: 20_000 });
    await rosterEntry.click();
    await expect(page.locator('[data-profile-card]')).toHaveCount(1);
    await expect(card(page, member.name)).toBeVisible();
    // The same entry again closes it.
    await rosterEntry.click();
    await expect(page.locator('[data-profile-card]')).toHaveCount(0);
    // A click anywhere else closes it too.
    await rosterEntry.click();
    await expect(card(page, member.name)).toBeVisible();
    await page.mouse.click(VIEWPORT.width / 2, 40);
    await expect(page.locator('[data-profile-card]')).toHaveCount(0);
  });

  test('the avatar opens in the image viewer; Escape and a backdrop click close it', async ({}, testInfo) => {
    const page = viewer.page;
    await openLobby(page);
    await memberRow(page, member.name).click();
    const profile = card(page, member.name);
    await expect(profile).toBeVisible();
    const photoButton = profile.getByRole('button', { name: `View ${member.name}'s profile photo` });
    await photoButton.click();
    const lightbox = page.getByRole('dialog', { name: `${member.name}'s profile photo` });
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('img')).toHaveAttribute('src', /\/api\/users\/[0-9a-f-]+\/avatar\?v=/);
    await expect(lightbox.getByRole('link', { name: /Open original/ })).toHaveAttribute('href', /\/avatar\?v=/);
    await expect(lightbox.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
    await page.waitForTimeout(300); // the zoom-in
    await shoot(page, testInfo, '04-photo-viewer');
    // Escape closes the viewer only; the card stays and focus is back on the photo.
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await expect(profile).toBeVisible();
    await expect(photoButton).toBeFocused();
    // A click on the backdrop closes it too (and again only the viewer).
    await photoButton.click();
    await expect(lightbox).toBeVisible();
    await page.mouse.click(20, VIEWPORT.height - 20);
    await expect(lightbox).toHaveCount(0);
    await expect(profile).toBeVisible();
    // The banner opens in the same viewer.
    await profile.getByRole('button', { name: `View ${member.name}'s banner` }).click();
    const bannerView = page.getByRole('dialog', { name: `${member.name}'s profile banner` });
    await expect(bannerView.getByRole('img')).toHaveAttribute('src', /\/api\/users\/[0-9a-f-]+\/banner\?v=/);
    await page.keyboard.press('Escape');
    await expect(bannerView).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(profile).toHaveCount(0);
  });

  test('"Message @name" sends a DM that arrives on the other side', async () => {
    const page = viewer.page;
    await openLobby(page);
    await memberRow(page, moderator.name).click();
    const profile = card(page, moderator.name);
    const box = profile.getByRole('textbox', { name: `Message @${moderator.name}` });
    await expect(box).toBeVisible();
    const first = `Hi ${moderator.name}, are you around for the castle build? (${RUN})`;
    await box.fill(first);
    await box.press('Enter');
    await expect(profile).toHaveCount(0);
    await expect(page.getByTestId('dm-header-profile')).toContainText(moderator.name, { timeout: 15_000 });
    await expect(page.getByRole('log').getByText(first)).toBeVisible({ timeout: 15_000 });
    // The DM header opens the same card.
    await page.getByTestId('dm-header-profile').click();
    await expect(card(page, moderator.name)).toBeVisible();
    await page.keyboard.press('Escape');

    // The other side: the conversation is in their DM list, with the message.
    const other = moderator.page;
    await openLobby(other);
    const conversation = other.locator('button[data-mobile-nav-close]').filter({ hasText: viewer.name });
    await expect(conversation).toBeVisible({ timeout: 15_000 });
    await conversation.click();
    await expect(other.getByTestId('dm-header-profile')).toContainText(viewer.name);
    await expect(other.getByRole('log').getByText(first)).toBeVisible({ timeout: 15_000 });

    // A second message from the card arrives live in the open conversation.
    await page.getByRole('button', { name: 'Close conversation' }).click();
    await memberRow(page, moderator.name).click();
    const again = card(page, moderator.name).getByRole('textbox', { name: `Message @${moderator.name}` });
    const second = `Bringing the blueprints at eight (${RUN})`;
    await again.fill(second);
    await again.press('Enter');
    await expect(page.getByRole('log').getByText(second)).toBeVisible({ timeout: 15_000 });
    await expect(other.getByRole('log').getByText(second)).toBeVisible({ timeout: 20_000 });
  });

  test('the full profile has About and Mutual communities tabs', async ({}, testInfo) => {
    const page = viewer.page;
    await openLobby(page);
    await memberRow(page, member.name).click();
    await card(page, member.name).getByRole('button', { name: 'View full profile' }).click();
    const modal = page.locator('[data-full-profile]');
    await expect(modal).toBeVisible();
    const aboutTab = modal.getByRole('tab', { name: 'About' });
    await expect(aboutTab).toHaveAttribute('aria-selected', 'true');
    const panel = modal.getByRole('tabpanel');
    await expect(panel).toContainText(MEMBER_BIO);
    await expect(panel.getByRole('heading', { name: 'Member since' })).toBeVisible();
    await expect(panel.getByRole('listitem').filter({ hasText: BUILDER_ROLE })).toBeVisible();
    await shoot(page, testInfo, '05-full-profile-about');
    const mutualTab = modal.getByRole('tab', { name: /mutual communit/ });
    // Arrow keys move between the tabs.
    await aboutTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(mutualTab).toHaveAttribute('aria-selected', 'true');
    await expect(mutualTab).toBeFocused();
    const link = modal.getByRole('tabpanel').getByRole('link').first();
    await expect(link).toHaveAttribute('href', `/lobby?server=${serverId}`);
    await expect(modal.getByRole('tabpanel')).toContainText('This community');
    // A pointer click on the tab (as most people would): no keyboard focus ring in the shot.
    await mutualTab.click();
    await shoot(page, testInfo, '06-full-profile-mutual');
    await page.keyboard.press('Home');
    await expect(aboutTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('a moderator times a member out from the ⋯ menu and lifts it; a plain member is neither offered it nor allowed', async ({}, testInfo) => {
    // The plain member: no moderation in the menu, and the route refuses.
    await openLobby(viewer.page);
    await memberRow(viewer.page, member.name).click();
    await card(viewer.page, member.name).getByRole('button', { name: `More actions for ${member.name}` }).click();
    const plainMenu = viewer.page.getByRole('menu', { name: `More actions for ${member.name}` });
    await expect(plainMenu.getByRole('menuitem', { name: /Copy user ID/ })).toBeVisible();
    await expect(plainMenu.getByRole('menuitem', { name: /Block user/ })).toBeVisible();
    await expect(plainMenu.getByRole('menuitem', { name: /Timeout/ })).toHaveCount(0);
    await expect(plainMenu.getByRole('menuitem', { name: /Kick|Ban/ })).toHaveCount(0);
    const refused = await send(() =>
      viewer.api.put(`/api/servers/${serverId}/members/${member.uid}/timeout`, {
        headers: ORIGIN,
        data: { until: new Date(Date.now() + 60_000).toISOString() },
      })
    );
    expect(refused.status()).toBe(403);
    await viewer.page.keyboard.press('Escape');
    await viewer.page.keyboard.press('Escape');

    // The moderator.
    const page = moderator.page;
    await openLobby(page);
    await memberRow(page, member.name).click();
    const profile = card(page, member.name);
    await expect(profile).toBeVisible();
    const menuButton = profile.getByRole('button', { name: `More actions for ${member.name}` });
    await menuButton.click();
    const menu = page.getByRole('menu', { name: `More actions for ${member.name}` });
    await expect(menu.getByRole('menuitem', { name: /Timeout/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Kick|Ban/ })).toHaveCount(0); // Moderate Members only
    await shoot(page, testInfo, '07-moderator-menu');
    await menu.getByRole('menuitem', { name: /Timeout/ }).click();
    const dialog = page.getByRole('alertdialog', { name: `Time out ${member.name}` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: '5 minutes' }).check();
    await shoot(page, testInfo, '08-timeout-dialog');
    await dialog.getByRole('button', { name: 'Time out' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(profile.getByRole('status').filter({ hasText: 'timed out' })).toHaveText(`${member.name} is timed out.`);
    await expect(profile.getByText(/Timed out until/)).toBeVisible({ timeout: 10_000 });

    // The member really is timed out: they cannot write.
    const textChannel = (await listChannels(member.api, serverId)).find((c) => c.type === 'text')!;
    const blocked = await send(() =>
      member.api.post(`/api/servers/${serverId}/channels/${textChannel.id}/messages`, { headers: ORIGIN, data: { content: 'can I still talk?' } })
    );
    expect(blocked.status()).toBe(403);
    // ...nor speak: in the voice room, their own microphone says why.
    await expect(member.page.getByRole('button', { name: 'Muted by a moderator', exact: true })).toBeVisible({ timeout: 15_000 });

    // Lift it again from the same menu.
    await menuButton.click();
    await menu.getByRole('menuitem', { name: 'Remove timeout' }).click();
    const lift = page.getByRole('alertdialog', { name: `Remove the timeout for ${member.name}?` });
    await lift.getByRole('button', { name: 'Remove timeout' }).click();
    await expect(lift).toHaveCount(0);
    await expect(profile.getByRole('status').filter({ hasText: 'timeout' })).toHaveText(`The timeout for ${member.name} is removed.`);
    await expect(profile.getByText(/Timed out until/)).toHaveCount(0);
    // They may speak again, and the microphone stays off until they turn it on.
    await expect(member.page.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
  });

  test('roles added and removed in the card; the member list regroups at once', async ({}, testInfo) => {
    const page = ownerPage;
    await openLobby(page);
    // The member is online (in voice), with no heading of their own.
    const onlineGroup = memberGroup(page, /^Online - /);
    await expect(memberGroup(page, `${CREW_ROLE} - `)).toHaveCount(0);
    await expect(onlineGroup.locator('[data-user-popover-anchor]', { hasText: member.name })).toBeVisible({ timeout: 20_000 });

    await memberRow(page, member.name).click();
    const profile = card(page, member.name);
    await expect(profile).toBeVisible();
    await profile.getByRole('button', { name: 'Add role' }).click();
    const picker = page.getByRole('listbox', { name: 'Add role' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('option', { name: BUILDER_ROLE })).toHaveCount(0); // already held
    await picker.getByRole('option', { name: CREW_ROLE }).click();
    await expect(profile.getByRole('listitem').filter({ hasText: CREW_ROLE })).toBeVisible({ timeout: 10_000 });
    // The member list moves them under the role's heading — no reload.
    const crewGroup = memberGroup(page, `${CREW_ROLE} - 1`);
    await expect(crewGroup.locator('[data-user-popover-anchor]', { hasText: member.name })).toBeVisible({ timeout: 10_000 });
    await expect(onlineGroup.locator('[data-user-popover-anchor]', { hasText: member.name })).toHaveCount(0);
    await profile.focus();
    await shoot(page, testInfo, '09-role-added-regrouped');
    // The server agrees.
    const held = await json<{ viewerCan: { currentRoleIds: string[] } }>(
      await send(() => owner.api.get(`/api/servers/${serverId}/members/${member.uid}/profile`))
    );
    expect(held.viewerCan.currentRoleIds).toEqual(expect.arrayContaining([crewRoleId, builderRoleId]));

    // Remove it again with the chip's ×.
    await profile.getByRole('button', { name: `Remove role ${CREW_ROLE}` }).click();
    await expect(profile.getByRole('listitem').filter({ hasText: CREW_ROLE })).toHaveCount(0, { timeout: 10_000 });
    await expect(memberGroup(page, `${CREW_ROLE} - `)).toHaveCount(0, { timeout: 10_000 });
    await expect(onlineGroup.locator('[data-user-popover-anchor]', { hasText: member.name })).toBeVisible();
    // Builders (held before) is untouched.
    await expect(profile.getByRole('listitem').filter({ hasText: BUILDER_ROLE })).toBeVisible();
    await page.keyboard.press('Escape');
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
    const api = await send(() => viewer.api.get(`/api/servers/${serverId}/members/${hidden.uid}/profile`));
    expect(api.status()).toBe(200);
    const body = await json<{ profile: Record<string, unknown> }>(api);
    expect(body.profile).toMatchObject({ bio: null, statusText: null, avatarUrl: null, bannerUrl: null, memberSince: null, limited: true });
    expect(JSON.stringify(body)).not.toContain(`secret bio ${RUN}`);
    await profile.focus();
    await shoot(page, testInfo, '10-hidden-profile');
    await page.keyboard.press('Escape');
  });

  test('your own card has Edit profile and the status picker', async ({}, testInfo) => {
    const page = moderator.page;
    await openLobby(page);
    const opener = page.getByRole('button', { name: 'Your profile' });
    await opener.click();
    const profile = card(page, moderator.name);
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('link', { name: 'Edit profile' })).toHaveAttribute('href', '/settings/profile');
    await expect(profile.getByRole('textbox', { name: /Message @/ })).toHaveCount(0);
    const statuses = profile.getByRole('radiogroup', { name: 'Status' });
    await expect(statuses.getByRole('radio')).toHaveCount(4);
    await expect(statuses.getByRole('radio', { name: 'Online' })).toHaveAttribute('aria-checked', 'true');
    await statuses.getByRole('radio', { name: 'Idle' }).click();
    await expect(statuses.getByRole('radio', { name: 'Idle' })).toHaveAttribute('aria-checked', 'true');
    // The ⋯ menu: Copy user ID and Edit profile — nothing to do to yourself.
    await profile.getByRole('button', { name: `More actions for ${moderator.name}` }).click();
    const menu = page.getByRole('menu', { name: `More actions for ${moderator.name}` });
    await expect(menu.getByRole('menuitem', { name: 'Edit profile' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Block|Timeout|Kick|Ban/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await profile.focus();
    await shoot(page, testInfo, '11-own-card');
    await statuses.getByRole('radio', { name: 'Online' }).click();
    await expect(statuses.getByRole('radio', { name: 'Online' })).toHaveAttribute('aria-checked', 'true');
    // Escape gives focus back to the avatar button.
    await page.keyboard.press('Escape');
    await expect(profile).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Edit profile goes to the profile settings.
    await opener.click();
    await card(page, moderator.name).getByRole('link', { name: 'Edit profile' }).click();
    await expect(page).toHaveURL(/\/settings\/profile/, { timeout: 15_000 });
  });

  test('the community menu offers a moderator the audit log', async ({}, testInfo) => {
    const page = moderator.page;
    await openLobby(page);
    await page.getByRole('button', { name: /open the community menu/ }).click();
    const menu = page.getByRole('menu', { name: / menu$/ });
    await expect(menu.getByRole('menuitem', { name: 'Audit log' })).toBeVisible();
    // Moderate Members and View Audit Log open nothing else.
    await expect(menu.getByRole('menuitem', { name: /Server settings|Roles & permissions|Channels|Invites/ })).toHaveCount(0);
    await shoot(page, testInfo, '12-community-menu-moderator');
    await page.keyboard.press('Escape');
    // A plain member has no such entry.
    await openLobby(viewer.page);
    const plainButton = viewer.page.getByRole('button', { name: /open the community menu/ });
    if (await plainButton.isEnabled()) {
      await plainButton.click();
      await expect(viewer.page.getByRole('menuitem', { name: 'Audit log' })).toHaveCount(0);
      await viewer.page.keyboard.press('Escape');
    }
  });

  test('the voice roster names the mute icon; a left click there opens the card with the volume', async ({}, testInfo) => {
    // The member is muted; the viewer joins the same room. (Exact names: "Mute
    // microphone" is a substring of "Unmute microphone". The timeout lifted
    // above leaves the microphone off, so the member may be muted already.)
    const unmuteButton = member.page.getByRole('button', { name: 'Unmute microphone', exact: true });
    const muteButton = member.page.getByRole('button', { name: 'Mute microphone', exact: true });
    await expect(unmuteButton.or(muteButton)).toBeVisible();
    if (await muteButton.isVisible()) await muteButton.click();
    await expect(unmuteButton).toBeVisible();
    const page = viewer.page;
    await openLobby(page);
    await joinVoice(page);
    const entry = page
      .locator('nav li')
      .filter({ has: page.locator('[data-user-popover-anchor]', { hasText: member.name }) })
      .last();
    const muted = entry.getByRole('img', { name: 'Muted', exact: true });
    await expect(muted).toBeVisible({ timeout: 20_000 });
    await expect(muted).toHaveAttribute('title', 'Muted');
    // The ligature is hidden: a screen reader says "Muted", never "mic_off".
    await expect(entry.locator('[data-voice-status="mic_off"] > span')).toHaveAttribute('aria-hidden', 'true');
    await muted.hover();
    await shoot(page, testInfo, '13-voice-roster-muted');
    // A left click opens the card, with the volume for someone in your room.
    await entry.locator('[data-user-popover-anchor]').click();
    const profile = card(page, member.name);
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('slider', { name: `Volume for ${member.name}` })).toBeVisible();
    await page.keyboard.press('Escape');
    await unmuteButton.click();
    await expect(muteButton).toBeVisible();
    await expect(muted).toHaveCount(0, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Disconnect from voice' }).click();
  });

  test('the card fits a 390 px phone', async ({}, testInfo) => {
    const page = viewer.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/lobby?server=${serverId}`);
    // On a phone the member list is hidden: open a chat author's card.
    const author = chatAuthor(page, member.name);
    await expect(author).toBeVisible({ timeout: 20_000 });
    await author.click();
    const profile = card(page, member.name);
    await expect(profile).toBeVisible();
    await expect(profile.getByTestId('profile-about-body')).toHaveText(MEMBER_BIO);
    const box = await profile.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await profile.focus();
    await shoot(page, testInfo, '14-phone-390');
    await page.keyboard.press('Escape');
    await page.setViewportSize(VIEWPORT);
  });
});
