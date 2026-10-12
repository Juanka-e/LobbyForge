/**
 * Coming back to voice after a reload, in a real Vampire Village game
 * (docs/ACTIVITY_INTEGRITY_AND_RESILIENCE.md §3.2, plan item 1):
 *
 *   six players set up and start Vampire Village over voice → night 1 →
 *   during the day, two villagers leave the page:
 *     - one opens the lobby again (a navigation, not a reload): the
 *       activities view comes back and "You dropped out of voice. [Back to
 *       #channel]" sits in the panel — one click puts them back in voice;
 *     - one reloads with the microphone already allowed: they are back in
 *       voice by themselves, with the microphone off, in the game view;
 *   → the vote opens and both votes are accepted (a vote needs the voice
 *   room: 403 `voice_required` otherwise) → the village wins.
 *
 * The game setup follows activity-vampire-village.spec.ts. Same RATE
 * LIMIT note: 26 actions, kept under the 30-a-minute window by `budget`;
 * start from a fresh window (clear `*rate-limit*` keys in Redis).
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL).
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const NAMES = ['Ada', 'Bram', 'Cleo', 'Dara', 'Eli', 'Fenn'] as const;
type Role = 'Vampire' | 'Villager' | 'Seer' | 'Doctor' | 'Hunter' | 'Survivor' | 'Jester';

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

/** Keeps the spec's own actions under the route's 30-a-minute limit (rolling window). */
class ActionBudget {
  private stamps: number[] = [];
  constructor(private readonly perMinute = 28) {}
  async take(page: Page): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((at) => now - at < 60_000);
      if (this.stamps.length < this.perMinute) break;
      await page.waitForTimeout(60_000 - (now - this.stamps[0]!) + 250);
    }
    this.stamps.push(Date.now());
  }
  note(): void {
    this.stamps.push(Date.now());
  }
}
const budget = new ActionBudget();

/** Click something that dispatches a game action; wait for the server's answer (and sit out one 429). */
async function act(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeEnabled({ timeout: 20_000 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await budget.take(page);
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/activities\/[^/]+\/actions$/.test(new URL(r.url()).pathname)
    );
    await target.click();
    const response = await answered;
    if (response.status() !== 429) {
      expect(response.status(), `action answered ${response.status()}`).toBe(200);
      return;
    }
    await page.waitForTimeout(61_000);
  }
  throw new Error('The action route kept answering 429.');
}

async function newPlayer(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: baseUrl, permissions: ['microphone'] });
}

async function joinVoiceAndOpenHub(page: Page, serverId: string): Promise<void> {
  await page.goto(`/lobby?server=${serverId}`);
  await page.locator('button').filter({ has: page.locator('span', { hasText: 'volume_up' }) }).first().click();
  await expect(page.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Play together/ }).click();
}

test.describe('back to voice after a reload, mid-game', () => {
  test.describe.configure({ mode: 'serial' });

  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  let serverId = '';
  let voiceChannelName = '';

  test.beforeAll(async ({ playwright }) => {
    resetRateLimits();
    // Own browser WITHOUT the config's --disable-web-security: that flag makes
    // Chromium drop the Origin header, which the app's CSRF guard rejects.
    browser = await playwright.chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const owner = await newPlayer(browser);
    contexts.push(owner);

    const setup = await owner.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Voice Resume E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await signIn(owner.request, {
        headers: ORIGIN,
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      test.skip(login.status() !== 200, 'Warm stack provisioned by someone else — owner credentials unknown.');
    }

    const { servers } = (await (await owner.request.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    const { channels } = (await (await owner.request.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string; name: string }>;
    };
    // "Play together" opens the first voice channel's activities.
    const voiceChannel = channels.find((c) => c.type === 'voice')!;
    voiceChannelName = voiceChannel.name;

    const install = await owner.request.post(`/api/servers/${serverId}/apps`, {
      headers: ORIGIN,
      data: { pluginId: 'vampire-village', enabled: true },
    });
    expect(install.status()).toBe(200);

    const listed = await owner.request.get(`/api/servers/${serverId}/channels/${voiceChannel.id}/activities`);
    const { activities } = (await listed.json()) as { activities: Array<{ id: string; status: string }> };
    for (const open of activities.filter((a) => a.status !== 'ended' && a.status !== 'cancelled')) {
      await owner.request.post(`/api/servers/${serverId}/activities/${open.id}/end`, { headers: ORIGIN, data: {} });
    }

    const inviteRes = await owner.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    for (let i = 1; i < NAMES.length; i += 1) {
      const guest = await newPlayer(browser);
      expect((await createGuest(guest.request, { headers: ORIGIN, data: {} })).status()).toBe(200);
      expect((await guest.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
      contexts.push(guest);
    }
    for (const context of contexts) {
      const page = await context.newPage();
      // Leaving a page while in voice asks first (beforeunload): say yes.
      page.on('dialog', (dialog) => void dialog.accept());
      pages.push(page);
    }
  });

  test.afterAll(async () => {
    for (const context of contexts) await context.close();
    await browser?.close();
  });

  test('two villagers leave the page, come back to voice, and their votes count', async () => {
    test.setTimeout(300_000);
    const [host] = pages as [Page, ...Page[]];

    // ── Everyone in voice, in the same game.
    await joinVoiceAndOpenHub(host, serverId);
    await host.getByRole('button', { name: /Vampire Village/ }).filter({ hasText: 'Start' }).click();
    await expect(host.getByLabel('Character name')).toBeVisible({ timeout: 20_000 });
    for (const page of pages.slice(1)) {
      await joinVoiceAndOpenHub(page, serverId);
      await expect(page.getByLabel('Character name')).toBeVisible({ timeout: 20_000 });
    }
    for (const [i, page] of pages.entries()) {
      await page.getByLabel('Character name').fill(NAMES[i]!);
      await act(page, page.getByRole('button', { name: 'Join the village' }));
      await expect(page.getByRole('button', { name: 'I’m ready' })).toBeVisible();
    }
    for (const page of pages) {
      await act(page, page.getByRole('button', { name: 'I’m ready' }));
      await expect(page.getByRole('button', { name: 'I’m ready' })).toHaveAttribute('aria-pressed', 'true');
    }
    // Slack for the night, and the longest discussion: the reloads happen in it.
    await act(host, host.getByRole('group', { name: 'Night' }).getByRole('button', { name: '60 s' }));
    await act(host, host.getByRole('group', { name: 'Discussion' }).getByRole('button', { name: '180 s' }));
    await act(host, host.getByRole('button', { name: 'Start the game' }));
    await act(host, host.getByRole('button', { name: 'Start the night' }));

    const roles = new Map<Role, number>();
    for (const [i, page] of pages.entries()) {
      const heading = page.getByRole('region', { name: 'Your role' }).getByRole('heading');
      await expect(heading).toBeVisible({ timeout: 15_000 });
      roles.set((await heading.innerText()).trim() as Role, i);
    }
    const seat = (role: Role) => roles.get(role)!;
    const vampire = pages[seat('Vampire')]!;
    const seer = pages[seat('Seer')]!;
    const doctor = pages[seat('Doctor')]!;
    const survivor = pages[seat('Survivor')]!;
    const vampireName = NAMES[seat('Vampire')];
    const villagerName = NAMES[seat('Villager')];
    const seerName = NAMES[seat('Seer')];
    const doctorName = NAMES[seat('Doctor')];

    // ── Night 1, as in the Vampire Village spec.
    await act(vampire, vampire.getByRole('button', { name: `Bite ${villagerName}` }));
    await act(seer, seer.getByRole('button', { name: `Look into ${vampireName}` }));
    await act(doctor, doctor.getByRole('button', { name: `Protect ${doctorName}` }));
    await act(survivor, survivor.getByRole('button', { name: 'Stay unguarded' }));
    for (const page of pages) {
      await expect(page.getByText(`${villagerName} was bitten by the vampires.`).first()).toBeVisible({ timeout: 15_000 });
    }
    budget.note();
    await expect(host.getByRole('button', { name: 'Start the vote' })).toBeVisible({ timeout: 20_000 });

    // ── The seer opens the lobby again (a navigation): the game view is
    // back, and one click puts them back in voice.
    await seer.goto(seer.url());
    const strip = seer.getByTestId('voice-resume-strip');
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(strip).toHaveText(/You dropped out of voice\./);
    await expect(seer.getByRole('region', { name: 'Your role' })).toBeVisible({ timeout: 20_000 });
    await strip.getByRole('button', { name: `Back to #${voiceChannelName}` }).click();
    await expect(seer.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
    await expect(strip).toHaveCount(0);

    // ── The doctor reloads with the microphone already allowed: back in
    // voice by themselves, muted, in the game view.
    await doctor.reload();
    await expect(doctor.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
    await expect(doctor.getByTitle('Unmute', { exact: true })).toBeVisible();
    await expect(doctor.getByRole('region', { name: 'Your role' })).toBeVisible({ timeout: 20_000 });
    await expect(doctor.getByTestId('voice-resume-strip')).toHaveCount(0);
    await expect(doctor.getByTestId('activity-voice-join')).toHaveCount(0);

    // ── The vote: both of them vote, and the votes count.
    await act(host, host.getByRole('button', { name: 'Start the vote' }));
    const voters = pages.filter((_, i) => i !== seat('Vampire') && i !== seat('Villager'));
    expect(voters).toContain(seer);
    expect(voters).toContain(doctor);
    for (const page of voters) await act(page, page.getByRole('button', { name: `Vote for ${vampireName}` }));
    await act(vampire, vampire.getByRole('button', { name: `Vote for ${seerName}` }));

    for (const page of pages) {
      await expect(page.getByRole('heading', { name: 'The village wins!' })).toBeVisible({ timeout: 15_000 });
    }
  });
});
