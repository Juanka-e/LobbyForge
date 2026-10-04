/**
 * Vampire Village, played end to end through the REAL lobby UI by six
 * browser contexts (the owner + five invited guests):
 *
 *   install the app → the owner joins the voice channel and starts
 *   Vampire Village from the activities hub → everyone opens the hub,
 *   creates a character and readies up → the host starts → each page reads
 *   its own secret role → night 1 (the vampire bites the villager, the seer
 *   looks at the vampire, the doctor protects themself, the survivor stays
 *   unguarded) → dawn announces the death (the timer moves on by itself) →
 *   the host opens the vote → the village hangs the vampire → every page
 *   shows "The village wins!" with everyone's role.
 *
 * Along the way it checks what each seat may see: only the vampire gets
 * the pack chat, only the seer gets the seer's result.
 *
 * RATE LIMIT: the activity action route allows 30 actions a minute per
 * client address, and every context here shares one address. This game is
 * 26 actions; `budget` keeps the spec under the limit and a 429 is waited
 * out once. Run it on a fresh window (clear `*rate-limit*` keys in Redis
 * after other activity specs — see docs/AGENT_TEAM.md).
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
  /** An action a client sends by itself (a timer running out). */
  note(): void {
    this.stamps.push(Date.now());
  }
}
const budget = new ActionBudget();

/** Click something that dispatches a game action; wait for the server's answer (and sit out one 429). */
async function act(page: Page, target: Locator): Promise<void> {
  // Wait for the control first, so a timer report this client sends by
  // itself in the meantime is not mistaken for the click's answer.
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

/** Open the activities hub from the sidebar ("Play together" targets the first voice channel). */
async function openHub(page: Page, serverId: string): Promise<void> {
  if (!page.url().includes('/lobby')) await page.goto(`/lobby?server=${serverId}`);
  await page.getByRole('button', { name: /Play together/ }).click();
}

test.describe('Vampire Village through the real lobby UI', () => {
  test.describe.configure({ mode: 'serial' });

  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  let serverId = '';

  test.beforeAll(async ({ playwright }) => {
    // One client address for every context here: start from a fresh rate-limit window.
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
        instanceName: 'Vampire Village E2E',
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
      channels: Array<{ id: string; type: string }>;
    };
    const voiceChannelId = channels.find((c) => c.type === 'voice')!.id;

    // The activities route refuses apps that are not installed AND enabled.
    const install = await owner.request.post(`/api/servers/${serverId}/apps`, {
      headers: ORIGIN,
      data: { pluginId: 'vampire-village', enabled: true },
    });
    expect(install.status()).toBe(200);

    // One activity per voice channel: end whatever an earlier spec left running.
    const listed = await owner.request.get(`/api/servers/${serverId}/channels/${voiceChannelId}/activities`);
    const { activities } = (await listed.json()) as { activities: Array<{ id: string; status: string }> };
    for (const open of activities.filter((a) => a.status !== 'ended' && a.status !== 'cancelled')) {
      await owner.request.post(`/api/servers/${serverId}/activities/${open.id}/end`, { headers: ORIGIN, data: {} });
    }

    // Five guests, all through one invite.
    const inviteRes = await owner.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    for (let i = 1; i < NAMES.length; i += 1) {
      const guest = await newPlayer(browser);
      expect((await createGuest(guest.request, { headers: ORIGIN, data: {} })).status()).toBe(200);
      expect((await guest.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
      contexts.push(guest);
    }
    for (const context of contexts) pages.push(await context.newPage());
  });

  test.afterAll(async () => {
    for (const context of contexts) await context.close();
    await browser?.close();
  });

  test('six villagers play a full game to the end', async () => {
    test.setTimeout(300_000);
    const [host] = pages as [Page, ...Page[]];

    // ── The owner joins the voice channel and starts the game from the hub.
    await host.goto(`/lobby?server=${serverId}`);
    const voiceChannel = host.locator('button').filter({ has: host.locator('span', { hasText: 'volume_up' }) }).first();
    await voiceChannel.click();
    await expect(host.getByText('Voice Connected')).toBeVisible({ timeout: 30_000 });
    await openHub(host, serverId);
    await host.getByRole('button', { name: /Vampire Village/ }).filter({ hasText: 'Start' }).click();
    await expect(host.getByLabel('Character name')).toBeVisible({ timeout: 20_000 });

    // ── Everyone else opens the hub and lands in the same game.
    for (const page of pages.slice(1)) {
      await openHub(page, serverId);
      await expect(page.getByLabel('Character name')).toBeVisible({ timeout: 20_000 });
    }

    // ── Character creation and readiness.
    for (const [i, page] of pages.entries()) {
      await page.getByLabel('Character name').fill(NAMES[i]!);
      await act(page, page.getByRole('button', { name: 'Join the village' }));
      await expect(page.getByRole('button', { name: 'I’m ready' })).toBeVisible();
    }
    for (const page of pages) {
      await act(page, page.getByRole('button', { name: 'I’m ready' }));
      await expect(page.getByRole('button', { name: 'I’m ready' })).toHaveAttribute('aria-pressed', 'true');
    }
    // The host gives the night some slack (spec default: 30 s).
    await act(host, host.getByRole('group', { name: 'Night' }).getByRole('button', { name: '60 s' }));
    const start = host.getByRole('button', { name: 'Start the game' });
    await act(host, start);

    // ── Straight into night 1 (the 10 s role reveal can be skipped by the host).
    await act(host, host.getByRole('button', { name: 'Start the night' }));

    // ── Each page reads its own secret role from its role card.
    const roles = new Map<Role, number>();
    for (const [i, page] of pages.entries()) {
      const heading = page.getByRole('region', { name: 'Your role' }).getByRole('heading');
      await expect(heading).toBeVisible({ timeout: 15_000 });
      roles.set((await heading.innerText()).trim() as Role, i);
    }
    expect([...roles.keys()].sort()).toEqual(['Doctor', 'Hunter', 'Seer', 'Survivor', 'Vampire', 'Villager']);
    const seat = (role: Role) => roles.get(role)!;
    const vampire = pages[seat('Vampire')]!;
    const seer = pages[seat('Seer')]!;
    const doctor = pages[seat('Doctor')]!;
    const survivor = pages[seat('Survivor')]!;
    const vampireName = NAMES[seat('Vampire')];
    const villagerName = NAMES[seat('Villager')];
    const seerName = NAMES[seat('Seer')];
    const doctorName = NAMES[seat('Doctor')];

    // Only the vampire has the pack chat.
    await expect(vampire.getByText('Pack chat · only vampires see this')).toBeVisible();
    for (const page of pages) if (page !== vampire) await expect(page.getByText('Pack chat')).toHaveCount(0);

    // Only the vampire sees the night clock; everyone else just sees "Night…".
    await expect(vampire.getByRole('timer')).toBeVisible();
    await expect(seer.getByRole('timer')).toHaveCount(0);

    // ── Night 1.
    await act(vampire, vampire.getByRole('button', { name: `Bite ${villagerName}` }));
    await act(seer, seer.getByRole('button', { name: `Look into ${vampireName}` }));
    await act(doctor, doctor.getByRole('button', { name: `Protect ${doctorName}` }));
    await act(survivor, survivor.getByRole('button', { name: 'Stay unguarded' }));
    // (The hunter cannot shoot on the first night, so the night ends here.)

    // ── Dawn: the whole village hears the news; only the seer knows more.
    for (const page of pages) {
      await expect(page.getByText(`${villagerName} was bitten by the vampires.`).first()).toBeVisible({ timeout: 15_000 });
    }
    await expect(seer.getByText(`Night 1: ${vampireName} is a Vampire.`).first()).toBeVisible();
    for (const page of pages) if (page !== seer) await expect(page.getByText(`is a Vampire.`)).toHaveCount(0);

    // The 5 s dawn ends by itself: the host's client reports the timeout.
    budget.note();
    await act(host, host.getByRole('button', { name: 'Start the vote' }));

    // ── The vote: four villagers against the vampire; the vampire votes for the seer.
    const voters = pages.filter((_, i) => i !== seat('Vampire') && i !== seat('Villager'));
    for (const page of voters) await act(page, page.getByRole('button', { name: `Vote for ${vampireName}` }));
    await act(vampire, vampire.getByRole('button', { name: `Vote for ${seerName}` }));

    // ── Game over, everywhere, with every role revealed.
    for (const page of pages) {
      await expect(page.getByRole('heading', { name: 'The village wins!' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Everyone’s role')).toBeVisible();
    }
    await expect(host.getByRole('button', { name: 'Play again' })).toBeVisible();
    await expect(pages[1]!.getByRole('button', { name: 'Play again' })).toHaveCount(0);
  });
});
