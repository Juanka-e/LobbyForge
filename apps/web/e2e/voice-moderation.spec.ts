/**
 * Voice moderation through the real lobby UI (docs/VOICE_ROOM.md):
 *
 *   - A moderator (a role with Mute Members, ranked above @everyone) opens
 *     the "⋮" menu on a member in the voice roster and picks "Disconnect
 *     from voice". The member sees "You were removed from the voice
 *     channel." and can rejoin at once — a fresh voice token is 200 (no
 *     voice_blocked), and the channel button connects again. A plain
 *     member gets neither the menu nor the API.
 *   - The owner's audit log, filtered to "Voice security", shows the
 *     disconnect as a readable sentence, and — after a server-muted member
 *     publishes audio labelled as a camera (removed by the LiveKit webhook,
 *     see security-review.spec.ts AUTHZ-006) — a readable
 *     "System removed <name> …" row with the voice block.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). Screenshots, dark
 * and light, go to the test's output directory.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 120_000 });

declare global {
  interface Window {
    LivekitClient: any;
    __room: any;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const LIVEKIT_UMD = resolve(here, '..', 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');

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

async function joinVoice(page: Page, serverId: string, channelName: string) {
  await page.goto(`/lobby?server=${serverId}`);
  const channel = page.getByRole('button', { name: channelName }).filter({ has: page.locator('span', { hasText: 'volume_up' }) });
  await expect(channel.first()).toBeVisible({ timeout: 15_000 });
  await channel.first().click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
}

test.describe('voice moderation: disconnect, rejoin, and the voice security log', () => {
  let browser: Browser;
  let ownerCtx: BrowserContext;
  let owner: APIRequestContext;
  let serverId = '';
  let everyoneRoleId = '';
  let modRoleId = '';
  let voiceChannelId = '';
  const voiceChannelName = `mod-room-${RUN}`;
  let moderator: Person;
  let target: Person;
  let bystander: Person;
  let mutedName = '';

  async function person(seed: string): Promise<Person> {
    const ctx = await browser.newContext({
      baseURL: baseUrl,
      locale: 'en-US',
      viewport: { width: 1360, height: 860 },
      colorScheme: 'dark',
      permissions: ['microphone', 'camera'],
    });
    expect((await createGuest(ctx.request, { headers: ORIGIN, data: { displayNameSeed: `${seed} ${RUN.slice(-4)}` } })).status()).toBe(200);
    const invite = await owner.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(invite.status()).toBe(201);
    const { invite: inv } = (await invite.json()) as { invite: { code: string } };
    expect((await ctx.request.post(`/api/invites/${inv.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    const me = (await (await ctx.request.get('/api/auth/guest')).json()) as { guest: { uid: string; name: string } };
    return { ctx, page: await ctx.newPage(), uid: me.guest.uid, name: me.guest.name };
  }

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    test.setTimeout(120_000);
    // Fake media, and WITHOUT the config's --disable-web-security (it drops
    // the Origin header; the CSRF guard then refuses every POST).
    // The raw livekit-client page below is served by route interception,
    // which Chromium treats as a public address space: without switching
    // off Local Network Access checks (as the Playwright config does), its
    // connection to LiveKit on localhost is blocked.
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
        instanceName: 'Voice Moderation E2E',
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
    const { servers } = (await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    const { roles } = (await (await owner.get(`/api/servers/${serverId}/roles`)).json()) as {
      roles: Array<{ id: string; name: string; position: number }>;
    };
    everyoneRoleId = roles.filter((r) => r.name === '@everyone').sort((a, b) => a.position - b.position)[0]!.id;

    // A voice room of its own: other specs' leftovers stay out of the roster.
    const room = await owner.post(`/api/servers/${serverId}/channels`, { headers: ORIGIN, data: { name: voiceChannelName, type: 'voice' } });
    expect(room.status()).toBe(201);
    voiceChannelId = ((await room.json()) as { channel: { id: string } }).channel.id;

    // Mute Members, ranked ABOVE @everyone (a new role defaults to its position 0).
    const role = await owner.post(`/api/servers/${serverId}/roles`, {
      headers: ORIGIN,
      data: { name: `Voice mods ${RUN}`, permissions: ['mute_members'], position: 10 },
    });
    expect(role.status(), await role.text()).toBe(201);
    modRoleId = ((await role.json()) as { role: { id: string } }).role.id;

    moderator = await person('Moderator');
    target = await person('Target');
    bystander = await person('Bystander');
    // The role list is REPLACED: keep @everyone (voice, speak, …) next to the new role.
    const assign = await owner.put(`/api/servers/${serverId}/members/${moderator.uid}/role`, {
      headers: ORIGIN,
      data: { roleIds: [everyoneRoleId, modRoleId] },
    });
    expect(assign.status()).toBe(200);
  });

  test.afterAll(async () => {
    for (const p of [moderator, target, bystander]) await p?.ctx.close();
    if (owner && serverId) {
      if (voiceChannelId) await owner.delete(`/api/servers/${serverId}/channels/${voiceChannelId}`, { headers: ORIGIN }).catch(() => undefined);
      if (modRoleId) await owner.delete(`/api/servers/${serverId}/roles/${modRoleId}`, { headers: ORIGIN }).catch(() => undefined);
    }
    await ownerCtx?.close();
    await browser?.close();
  });

  test('a moderator disconnects a member from voice; the member can rejoin at once', async ({}, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    // The moderation targets are worked out when the lobby renders: join after the role is set.
    await joinVoice(target.page, serverId, voiceChannelName);
    await joinVoice(bystander.page, serverId, voiceChannelName);
    await joinVoice(moderator.page, serverId, voiceChannelName);

    // A plain member gets no "⋮" for anyone, and the API refuses them.
    await expect(bystander.page.getByRole('button', { name: `Voice actions for ${target.name}` })).toHaveCount(0);
    const refused = await bystander.ctx.request.post(
      `/api/servers/${serverId}/channels/${voiceChannelId}/members/${target.uid}/voice/disconnect`,
      { headers: ORIGIN, data: {} }
    );
    expect(refused.status()).toBe(403);

    // The moderator's roster menu.
    const trigger = moderator.page.getByRole('button', { name: `Voice actions for ${target.name}` });
    await expect(trigger).toHaveCount(1, { timeout: 15_000 });
    await trigger.click();
    const menu = moderator.page.getByRole('menu', { name: `Voice actions for ${target.name}` });
    const item = menu.getByRole('menuitem', { name: 'Disconnect from voice' });
    await expect(item).toBeVisible();
    // Nothing paints over the open menu (the sidebar's next section used to:
    // its fade-in animation left a transform that stacked it above the menu).
    const coveredPoints = () =>
      menu.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const points: Array<[number, number]> = [];
        for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.15, 0.5, 0.85]) points.push([box.left + box.width * fx, box.top + box.height * fy]);
        return points
          .map(([x, y]) => document.elementFromPoint(x, y))
          .filter((hit) => !hit || !el.contains(hit))
          .map((hit) => (hit ? `${hit.tagName.toLowerCase()}: ${(hit.textContent ?? '').trim().slice(0, 30)}` : 'nothing'));
      });
    const firstLook = await coveredPoints();
    if (firstLook.length > 0) {
      // Covered: record why before failing — the stacking-context makers among
      // the menu's ancestors and the covering element's (running animations,
      // transforms, opacity, z-index), and a picture.
      const why = await menu.evaluate((el) => {
        const describe = (start: Element | null) => {
          const chain: string[] = [];
          for (let node = start as HTMLElement | null; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            const running = node.getAnimations().filter((a) => a.playState === 'running').map((a) => (a as CSSAnimation).animationName ?? 'anim');
            const marks = [
              style.transform !== 'none' ? `transform:${style.transform}` : '',
              running.length ? `running:${running.join('+')}` : '',
              style.zIndex !== 'auto' ? `z:${style.zIndex}` : '',
              style.opacity !== '1' ? `opacity:${style.opacity}` : '',
              style.isolation === 'isolate' ? 'isolate' : '',
            ].filter(Boolean);
            if (marks.length) chain.push(`${node.tagName.toLowerCase()}.${String(node.className).split(' ').slice(0, 3).join('.')} [${marks.join(' ')}]`);
          }
          return chain;
        };
        const box = el.getBoundingClientRect();
        const hit = [0.15, 0.5, 0.85]
          .map((fy) => document.elementFromPoint(box.left + box.width / 2, box.top + box.height * fy))
          .find((h) => h && !el.contains(h));
        return { menu: describe(el.parentElement), cover: describe(hit ?? null) };
      });
      await moderator.page.screenshot({ path: testInfo.outputPath('covered-roster-menu.png') });
      console.info(`[voice-moderation] roster menu covered at first look by ${JSON.stringify(firstLook)} — ${JSON.stringify(why)}`);
      testInfo.annotations.push({ type: 'roster menu covered at first look', description: JSON.stringify({ firstLook, why }) });
    }
    // The menu renders in a portal on <body>: nothing in the sidebar can cover it, even mid-animation.
    expect(firstLook, 'parts of the open roster menu covered by other elements').toEqual([]);
    await shootBothThemes(moderator.page, shot('1-roster-menu'));
    await item.click();

    // The member is out, and told why.
    await expect(target.page.getByRole('alert').filter({ hasText: 'You were removed from the voice channel.' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(target.page.getByText('Voice Connected')).toHaveCount(0);
    await shootBothThemes(target.page, shot('2-member-removed'));
    // The others no longer see them in the room.
    await expect(moderator.page.getByRole('button', { name: `Voice actions for ${target.name}` })).toHaveCount(0, { timeout: 20_000 });

    // No block: a fresh token is issued, and the channel button connects again.
    const token = await target.ctx.request.post('/api/livekit/token', {
      headers: ORIGIN,
      data: { serverId, channelId: voiceChannelId },
    });
    expect(token.status(), await token.text()).toBe(200);
    const channel = target.page.getByRole('button', { name: voiceChannelName }).filter({ has: target.page.locator('span', { hasText: 'volume_up' }) });
    await channel.first().click();
    await expect(target.page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
    await expect(target.page.getByRole('alert').filter({ hasText: 'You were removed from the voice channel.' })).toHaveCount(0);
  });

  test('a server-muted member who publishes audio as a camera is removed by the system', async () => {
    // A raw livekit-client in a page at the app origin (route interception
    // keeps the app's CSP away) — no app filter between it and LiveKit.
    const muted = await person('Muted');
    mutedName = muted.name;
    try {
      const mute = await owner.post(`/api/servers/${serverId}/channels/${voiceChannelId}/members/${muted.uid}/voice/mute`, {
        headers: ORIGIN,
        data: { muted: true },
      });
      expect(mute.status()).toBe(200);
      const tokenRes = await muted.ctx.request.post('/api/livekit/token', { headers: ORIGIN, data: { serverId, channelId: voiceChannelId } });
      expect(tokenRes.status()).toBe(200);
      const { token, livekitUrl } = (await tokenRes.json()) as { token: string; livekitUrl: string };

      const umd = readFileSync(LIVEKIT_UMD, 'utf8');
      const page = muted.page;
      await page.route('**/lf-voice-mod-harness.html', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><script src="/lf-voice-mod-client.js"></script></body></html>' })
      );
      await page.route('**/lf-voice-mod-client.js', (route) => route.fulfill({ body: umd, contentType: 'application/javascript' }));
      await page.goto(new URL('/lf-voice-mod-harness.html', baseUrl).toString());
      await page.waitForFunction(() => typeof window.LivekitClient !== 'undefined');
      await page.evaluate(
        async ({ url, token }) => {
          const LK = window.LivekitClient;
          const room = new LK.Room({ adaptiveStream: false });
          window.__room = room;
          await room.connect(url, token);
          const mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
          await room.localParticipant.publishTrack(mic, { source: LK.Track.Source.Camera, name: 'audio-as-camera' });
        },
        { url: livekitUrl, token }
      );
      await expect.poll(() => page.evaluate(() => window.__room.state as string), { timeout: 15_000 }).toBe('disconnected');
    } finally {
      await owner
        .post(`/api/servers/${serverId}/channels/${voiceChannelId}/members/${muted.uid}/voice/mute`, { headers: ORIGIN, data: { muted: false } })
        .catch(() => undefined);
      await muted.ctx.close();
    }
  });

  test('the audit log, filtered to "Voice security", tells both stories in plain words', async ({}, testInfo) => {
    const shot = (name: string) => (theme: string) => testInfo.outputPath(`${name}-${theme}.png`);
    const page = await ownerCtx.newPage();
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit Log' })).toBeVisible();
    await page.getByRole('button', { name: /^Voice security \(\d+\)$/ }).click();

    const rows = page.locator('article');
    const disconnect = rows.filter({ hasText: `disconnected ${target.name} (` }).filter({
      hasText: `from #${voiceChannelName}. No block: they can rejoin at any time.`,
    });
    await expect(disconnect.first()).toBeVisible({ timeout: 15_000 });
    await expect(disconnect.first().getByTestId('audit-summary')).toContainText(`${moderator.name} disconnected ${target.name} (`);

    const removed = rows.filter({ hasText: `System removed ${mutedName} (` });
    await expect(removed.first()).toBeVisible();
    await expect(removed.first().getByTestId('audit-summary')).toContainText(`from #${voiceChannelName}: audio published as camera`);
    await expect(removed.first().getByTestId('audit-summary')).toContainText('voice blocked on this server for 10 minutes.');
    // Only voice security rows are listed under this filter.
    const actions = await rows.allInnerTexts();
    expect(actions.every((text) => /voice|System removed|disconnected|server-muted|lifted a server mute/i.test(text))).toBe(true);
    await shootBothThemes(page, shot('3-audit-voice-security'));
  });
});
