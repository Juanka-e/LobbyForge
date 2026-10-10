/**
 * Polls in text channels (docs/CHAT_POLLS.md), by two people through the
 * REAL lobby UI.
 *
 * The owner (who holds Create polls through the Owner role) posts a poll
 * from the composer's `+` menu; an invited guest (plain @everyone: no
 * Create polls) sees it arrive live. Then:
 *
 *   - before voting, the guest sees the answers and the voter total, no
 *     counts; after voting, the shares;
 *   - the owner's card moves live when the guest votes — the voter total
 *     only, until the owner votes too;
 *   - the guest changes their vote and the owner's bars follow;
 *   - no API answer names a voter;
 *   - the owner closes the poll: the guest's card turns read-only with a
 *     Closed badge, live, and stays that way after a reload; a late vote is
 *     refused with 409.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL), like the other
 * real-UI specs. Re-runs on a warm stack: every run asks a new question.
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createGuest, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };

const QUESTION = `Pizza or tacos on Friday? (${Date.now().toString(36)})`;

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial' });

function pollCard(page: Page): Locator {
  return page.locator('[data-chat-poll]').filter({ hasText: QUESTION });
}

async function openLobby(page: Page, serverId: string) {
  await page.goto(`/lobby?server=${serverId}`);
  await expect(page.locator('[data-composer-input]')).toBeVisible({ timeout: 30_000 });
}

test.describe('Polls in a text channel, two members, live', () => {
  let ownBrowser: Browser;
  let ownerCtx: BrowserContext;
  let guestCtx: BrowserContext;
  let owner: Page;
  let guest: Page;
  let serverId = '';
  let ownerUid = '';
  let guestUid = '';
  let textChannelIds: string[] = [];

  test.beforeAll(async ({ playwright }) => {
    resetRateLimits();
    // Own browser WITHOUT the config's --disable-web-security: that flag
    // drops the Origin header, which the CSRF guard rejects — every vote is
    // a request from the page.
    ownBrowser = await playwright.chromium.launch();
    ownerCtx = await ownBrowser.newContext({ baseURL: baseUrl });
    guestCtx = await ownBrowser.newContext({ baseURL: baseUrl });

    // Owner session: fresh stack → first-run setup; warm stack → login.
    const setup = await ownerCtx.request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'Chat polls E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await signIn(ownerCtx.request, { headers: ORIGIN, data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }
    ownerUid = ((await (await ownerCtx.request.get('/api/auth/guest')).json()) as { guest: { uid: string } }).guest.uid;

    const { servers } = (await (await ownerCtx.request.get('/api/servers')).json()) as { servers: Array<{ id: string }> };
    serverId = servers[0]!.id;
    const { channels } = (await (await ownerCtx.request.get(`/api/servers/${serverId}/channels`)).json()) as {
      channels: Array<{ id: string; type: string }>;
    };
    textChannelIds = channels.filter((c) => c.type === 'text' || c.type === 'announcement').map((c) => c.id);
    expect(textChannelIds.length).toBeGreaterThan(0);

    const guestAuth = await createGuest(guestCtx.request, { headers: ORIGIN, data: { displayNameSeed: 'Pollster' } });
    expect(guestAuth.status()).toBe(200);
    const inviteRes = await ownerCtx.request.post(`/api/servers/${serverId}/invites`, { headers: ORIGIN, data: {} });
    expect(inviteRes.status()).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    expect((await guestCtx.request.post(`/api/invites/${invite.code}/redeem`, { headers: ORIGIN })).status()).toBe(201);
    guestUid = ((await (await guestCtx.request.get('/api/auth/guest')).json()) as { guest: { uid: string } }).guest.uid;
    expect(guestUid).toBeTruthy();

    owner = await ownerCtx.newPage();
    guest = await guestCtx.newPage();
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
    await guestCtx?.close();
    await ownBrowser?.close();
  });

  test('create, vote, live updates, change vote, close, still there after a reload', async () => {
    test.setTimeout(180_000);
    await openLobby(owner, serverId);
    await openLobby(guest, serverId);

    // ── A member without Create polls gets no menu (the old placeholder stays).
    await expect(guest.getByRole('button', { name: 'More actions' })).toHaveCount(0);

    // ── The owner posts a poll from the composer menu.
    await owner.getByRole('button', { name: 'More actions' }).click();
    await owner.getByRole('menuitem', { name: 'Create poll' }).click();
    const dialog = owner.getByRole('dialog', { name: 'Create a poll' });
    await expect(dialog).toBeVisible();
    // An empty draft is refused with a reason, not sent.
    await dialog.getByRole('button', { name: 'Post poll' }).click();
    await expect(dialog.getByText('Write a question first.')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Question', exact: true }).fill(QUESTION);
    await dialog.getByRole('textbox', { name: 'Answer 1', exact: true }).fill('Pizza');
    await dialog.getByRole('textbox', { name: 'Answer 2', exact: true }).fill('Tacos');
    await dialog.getByRole('button', { name: 'Add answer' }).click();
    await dialog.getByRole('textbox', { name: 'Answer 3', exact: true }).fill('Both');
    await expect(dialog.getByRole('combobox', { name: 'Duration' })).toHaveValue('24');
    await dialog.getByRole('button', { name: 'Post poll' }).click();
    await expect(dialog).toHaveCount(0);

    const ownerCard = pollCard(owner);
    await expect(ownerCard).toBeVisible({ timeout: 15_000 });
    const pollId = (await ownerCard.getAttribute('data-chat-poll'))!;
    expect(pollId).toBeTruthy();

    // ── It reaches the guest live.
    const guestCard = pollCard(guest);
    await expect(guestCard).toBeVisible({ timeout: 15_000 });
    await expect(guestCard.getByText('No votes yet')).toBeVisible();
    await expect(guestCard.getByText(/\d+%/)).toHaveCount(0);
    await expect(guestCard.getByRole('button', { name: 'Close poll' })).toHaveCount(0);

    // ── The guest votes; their card shows the shares.
    await guestCard.getByRole('radio', { name: 'Tacos' }).check();
    await guestCard.getByRole('button', { name: 'Vote' }).click();
    await expect(guestCard.locator('[data-poll-mine="true"]')).toContainText('Tacos');
    await expect(guestCard.locator('[data-poll-option="1"]')).toContainText('100%');

    // ── The owner's card moves live: the total, not the counts (they have not voted).
    await expect(ownerCard.getByText('1 person voted')).toBeVisible({ timeout: 15_000 });
    await expect(ownerCard.getByText(/\d+%/)).toHaveCount(0);

    // ── The owner votes; both see 50/50.
    await ownerCard.getByRole('radio', { name: 'Pizza' }).check();
    await ownerCard.getByRole('button', { name: 'Vote' }).click();
    await expect(ownerCard.locator('[data-poll-option="0"]')).toContainText('50%');
    await expect(guestCard.locator('[data-poll-option="0"]')).toContainText('50%', { timeout: 15_000 });
    await expect(guestCard.getByText('2 people voted')).toBeVisible();

    // ── The guest changes their vote; the owner's bars follow.
    await guestCard.getByRole('button', { name: 'Change vote' }).click();
    await guestCard.getByRole('radio', { name: 'Pizza' }).check();
    await guestCard.getByRole('button', { name: 'Vote' }).click();
    await expect(guestCard.locator('[data-poll-mine="true"]')).toContainText('Pizza');
    await expect(ownerCard.locator('[data-poll-option="0"]')).toContainText('100%', { timeout: 15_000 });

    // ── No API answer names a voter — not even to the owner.
    let channelId = '';
    for (const id of textChannelIds) {
      const res = await guestCtx.request.get(`/api/servers/${serverId}/channels/${id}/polls/${pollId}`);
      if (res.ok()) {
        channelId = id;
        break;
      }
    }
    expect(channelId, 'the poll lives in one of the text channels').not.toBe('');
    for (const ctx of [ownerCtx, guestCtx]) {
      const { messages } = (await (await ctx.request.get(`/api/servers/${serverId}/channels/${channelId}/messages?limit=50`)).json()) as {
        messages: Array<{ poll?: { id: string } | null }>;
      };
      const listed = messages.find((m) => m.poll?.id === pollId)?.poll;
      const { poll } = (await (await ctx.request.get(`/api/servers/${serverId}/channels/${channelId}/polls/${pollId}`)).json()) as {
        poll: Record<string, unknown>;
      };
      for (const view of [listed, poll]) {
        expect(view).toBeTruthy();
        expect(JSON.stringify(view)).not.toContain(ownerUid);
        expect(JSON.stringify(view)).not.toContain(guestUid);
        expect(view).toMatchObject({ totalVoters: 2, options: [{ votes: 2 }, { votes: 0 }, { votes: 0 }] });
      }
    }
    // A member without Create polls cannot post one through the API either.
    const forged = await guestCtx.request.post(`/api/servers/${serverId}/channels/${channelId}/polls`, {
      headers: ORIGIN,
      data: { question: 'Sneaky?', options: ['a', 'b'] },
    });
    expect(forged.status()).toBe(403);

    // ── The owner closes it; the guest's card turns read-only, live.
    await ownerCard.getByRole('button', { name: 'Close poll' }).click();
    await ownerCard.getByRole('button', { name: 'Close now' }).click();
    await expect(ownerCard.locator('[data-poll-status]')).toHaveText('Closed');
    await expect(guestCard.locator('[data-poll-status]')).toHaveText('Closed', { timeout: 15_000 });
    await expect(guestCard.getByRole('button', { name: 'Change vote' })).toHaveCount(0);
    await expect(guestCard.getByRole('button', { name: 'Remove vote' })).toHaveCount(0);

    // ── Still there after a reload, with the final results.
    await guest.reload();
    const reloaded = pollCard(guest);
    await expect(reloaded).toBeVisible({ timeout: 30_000 });
    await expect(reloaded.locator('[data-poll-status]')).toHaveText('Closed');
    await expect(reloaded.locator('[data-poll-option="0"]')).toContainText('100%');
    await expect(reloaded.getByRole('radio')).toHaveCount(0);

    // ── A late vote is refused.
    const late = await guestCtx.request.put(`/api/servers/${serverId}/channels/${channelId}/polls/${pollId}/vote`, {
      headers: ORIGIN,
      data: { choices: [1] },
    });
    expect(late.status()).toBe(409);
    expect(await late.json()).toMatchObject({ code: 'poll_closed' });
  });
});
