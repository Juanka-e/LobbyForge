/**
 * LF-023: end-to-end specs against the REAL compose stack — actual
 * Postgres, Redis, LiveKit and the production-built web image (see
 * infra/docker/docker-compose.dev.yml). These run in CI via the `e2e`
 * job and locally via scripts/e2e-compose.sh.
 *
 * The whole Hushle chain is exercised through the real API:
 *   setup/login → admin card-packs (DB seed) → guest identity →
 *   server + channels → activity → start-game (deck hydrated from the
 *   card_packs table) → projection (deck never sent, currentCard only
 *   for the explainer) → classic-Taboo bust rules.
 *
 * Guarded: skips unless LF_E2E_BASE_URL points at an external stack,
 * so `pnpm test:e2e` against the local dev server is unaffected.
 */
import { expect, test } from '@playwright/test';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';

// The origin guard rejects POSTs without a matching Origin in
// production mode; Playwright's API context doesn't send one by default.
const ORIGIN = { Origin: baseUrl };

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');

test.describe('compose stack — real Postgres/Redis', () => {
  test('health endpoint reports a green stack', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBeTruthy();
  });

  test('hushle chain: setup → seeded packs → guest → server → start-game → projection → bust rules', async ({
    request,
    playwright,
  }) => {
    // ── 1. First-run setup (fresh volume) or owner login (warm volume).
    // A warm instance answers 409 (already complete) or 503/403 (no
    // setup token configured) — in that case try the owner login; on a
    // stack provisioned by someone else the login fails and the
    // admin-only section below is skipped (CI always runs it: the
    // volume is fresh and the setup token is exported to compose).
    const setup = await request.post('/api/setup/complete', {
      headers: ORIGIN,
      data: {
        setupToken,
        instanceName: 'E2E Compose Stack',
        ownerDisplayName: 'E2E Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    let haveOwnerSession = false;
    if (setup.status() === 200) {
      haveOwnerSession = true;
    } else {
      expect([409, 403, 503]).toContain(setup.status());
      const login = await request.post('/api/auth/login', {
        headers: ORIGIN,
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      // 200 → this instance was set up by a previous e2e run.
      // 401 → provisioned by someone else (e.g. a developer's warm stack).
      expect([200, 401]).toContain(login.status());
      haveOwnerSession = login.status() === 200;
    }

    // ── 2. Admin card-packs: the built-in seeder ran against real PG.
    if (haveOwnerSession) {
      const packsRes = await request.get('/api/admin/card-packs');
      expect(packsRes.status()).toBe(200);
      const { packs } = (await packsRes.json()) as {
        packs: Array<{ slug: string; cardCount: number; isBuiltIn: boolean; cards: unknown[] }>;
      };
      const en = packs.find((p) => p.slug === 'hushle-en-basic');
      const tr = packs.find((p) => p.slug === 'hushle-tr-basic');
      expect(en?.isBuiltIn).toBe(true);
      expect(en?.cardCount).toBe(24);
      expect(en?.cards).toHaveLength(24);
      expect(tr?.isBuiltIn).toBe(true);
      expect(tr?.cardCount).toBe(24);
    }

    // ── 3. A separate guest identity creates its own server (guest is
    // that server's host — the self-host flow).
    const guestCtx = await playwright.request.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders: ORIGIN,
    });
    const guestRes = await guestCtx.post('/api/auth/guest', { data: {} });
    expect(guestRes.status()).toBe(200);
    const guest = (await guestRes.json()) as { guest: { uid: string } };
    expect(guest.guest.uid).toBeTruthy();

    const serverRes = await guestCtx.post('/api/servers', {
      data: { name: 'E2E Voice Server' },
    });
    expect(serverRes.status()).toBe(201);
    const { server } = (await serverRes.json()) as { server: { id: string } };

    // ── 4. Default channels exist (general text + Main Lounge voice).
    const channelsRes = await guestCtx.get(`/api/servers/${server.id}/channels`);
    expect(channelsRes.status()).toBe(200);
    const { channels } = (await channelsRes.json()) as {
      channels: Array<{ id: string; type: string; name: string }>;
    };
    const voice = channels.find((c) => c.type === 'voice');
    expect(voice?.name).toBe('Main Lounge');

    // ── 5. Start a Hushle activity in the voice channel.
    const activityRes = await guestCtx.post(
      `/api/servers/${server.id}/channels/${voice!.id}/activities`,
      { data: { pluginId: 'hushle' } }
    );
    expect(activityRes.status()).toBe(201);
    const { activity } = (await activityRes.json()) as { activity: { id: string } };

    const action = async (body: Record<string, unknown>) => {
      const res = await guestCtx.post(
        `/api/servers/${server.id}/activities/${activity.id}/actions`,
        { data: body }
      );
      return { res, state: (res.status() === 200 ? ((await res.json()) as { activity: { state: Record<string, unknown> } }).activity.state : null) };
    };
    const getState = async () => {
      const res = await guestCtx.get(`/api/servers/${server.id}/activities/${activity.id}`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { activity: { state: Record<string, unknown> } }).activity.state;
    };

    // ── 6. start-game with the built-in EN pack slug: the deck is
    // hydrated from the real card_packs/cards tables.
    const start = await action({
      type: 'start-game',
      packId: 'hushle-en-basic',
      language: 'en',
      createdBy: guest.guest.uid,
    });
    expect(start.res.status()).toBe(200);
    expect(start.state!.phase).toBe('team_setup');
    expect(start.state!.deckSize).toBe(24);
    // LF-001 anti-cheat: the deck NEVER leaves the server — not even
    // for the host who just dispatched the action.
    expect(start.state!.deck).toBeUndefined();
    expect(start.state!.currentCard).toBeNull();

    // ── 7. Team setup + first turn. The guest explains → the card is
    // visible to them, invisible deck, one card consumed.
    const teams = await action({
      type: 'set-teams',
      teams: [
        { name: 'Team A', playerIds: [guest.guest.uid] },
        { name: 'Team B', playerIds: ['e2e-opponent-placeholder'] },
      ],
    });
    expect(teams.res.status()).toBe(200);
    const teamAId = (teams.state!.teams as Array<{ id: string; name: string }>).find(
      (t) => t.name === 'Team A'
    )!.id;

    const turn = await action({
      type: 'start-turn',
      teamId: teamAId,
      explainerId: guest.guest.uid,
    });
    expect(turn.res.status()).toBe(200);
    expect(turn.state!.phase).toBe('playing');
    const card = turn.state!.currentCard as { word: string; forbiddenWords: string[] } | null;
    expect(card).not.toBeNull();
    expect(card!.word).toBeTruthy();
    expect(Array.isArray(card!.forbiddenWords)).toBe(true);
    expect(turn.state!.deck).toBeUndefined();
    expect(turn.state!.deckSize).toBe(24);
    expect(turn.state!.cardsRemaining).toBe(23);

    // ── 8. Projection: clear the explainer → the SAME viewer now gets
    // currentCard: null (classic Taboo — only the explainer sees the
    // word; opponents would, but this viewer is the teammate/host).
    await action({ type: 'set-explainer', explainerId: null });
    let hidden = await getState();
    expect(hidden.currentCard).toBeNull();
    expect(hidden.deckSize).toBe(24);

    // Restore the explainer → the card is visible again on a plain GET.
    await action({ type: 'set-explainer', explainerId: guest.guest.uid });
    const visible = await getState();
    expect((visible.currentCard as { word: string } | null)?.word).toBeTruthy();

    // ── 9. Classic-Taboo bust rules: a TEAMMATE (the host is on Team A
    // with the explainer) cannot bust — the state must not change.
    const before = await getState();
    const bust = await action({ type: 'bust-forbidden', bustedBy: guest.guest.uid });
    expect(bust.res.status()).toBe(200);
    const after = await getState();
    expect(after).toEqual(before); // reducer rejected the self-bust

    await guestCtx.dispose();
  });
});
