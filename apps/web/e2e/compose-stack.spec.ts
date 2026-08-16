/**
 * LF-023: end-to-end specs against the REAL compose stack — actual
 * Postgres, Redis, LiveKit and the production-built web image (see
 * infra/docker/docker-compose.dev.yml). These run in CI via the `e2e`
 * job and locally via scripts/e2e-compose.sh.
 *
 * The whole Hushle chain is exercised through the real API:
 *   setup/login → admin card-packs (DB seed) → owner's bootstrap
 *   server + channels → activity → start-game (deck hydrated from the
 *   card_packs table) → projection (deck never sent, currentCard only
 *   for the explainer) → classic-Taboo bust rules.
 *
 * Guarded: skips unless LF_E2E_BASE_URL points at an external stack.
 * On a WARM stack provisioned by someone else (a developer's instance)
 * the chain test skips — the owner credentials are unknown; CI always
 * runs the full chain on a fresh volume.
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
  // Serial + ordered: the chain test performs first-run setup; guest
  // issuance is only allowed once an instance is bootstrapped, so it
  // runs LAST.
  test.describe.configure({ mode: 'serial' });

  test('health endpoint reports a green stack', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ok?: boolean; checks?: Record<string, boolean> };
    expect(body.ok).toBe(true);
    expect(body.checks?.web).toBe(true);
  });

  test('hushle chain: setup → seeded packs → bootstrap server → start-game → projection → bust rules', async ({
    request,
  }) => {
    // ── 1. First-run setup (fresh volume) or owner login (warm volume).
    // A warm instance answers 409 (already complete) or 503/403 (no
    // setup token configured) — in that case try the owner login; on a
    // stack provisioned by someone else the login fails and this test
    // skips (CI always runs it: fresh volume + exported setup token).
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
    let ownerUid: string | undefined;
    let bootstrapServerId: string | undefined;
    if (setup.status() === 200) {
      const body = (await setup.json()) as { serverId: string; setup: { ownerUserId?: string } };
      bootstrapServerId = body.serverId;
      ownerUid = body.setup.ownerUserId;
    } else {
      expect([409, 403, 503]).toContain(setup.status());
      const login = await request.post('/api/auth/login', {
        headers: ORIGIN,
        data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      test.skip(
        login.status() !== 200,
        'Warm stack provisioned by someone else — owner credentials unknown. Run against a fresh volume (scripts/e2e-compose.sh with -v) for the full chain.'
      );
      expect(login.status()).toBe(200);
    }
    // The shared `request` context now carries the owner session cookie.

    // ── 2. Admin card-packs: the built-in seeder ran against real PG.
    // V4-011: the list endpoint returns COUNT-aggregated summaries; the
    // cards themselves come from the lazy ?packId= detail endpoint.
    const packsRes = await request.get('/api/admin/card-packs');
    expect(packsRes.status()).toBe(200);
    const { packs } = (await packsRes.json()) as {
      packs: Array<{ id: string; slug: string; cardCount: number; isBuiltIn: boolean }>;
    };
    const en = packs.find((p) => p.slug === 'hushle-en-basic');
    const tr = packs.find((p) => p.slug === 'hushle-tr-basic');
    expect(en?.isBuiltIn).toBe(true);
    expect(en?.cardCount).toBe(24);
    expect(tr?.isBuiltIn).toBe(true);
    expect(tr?.cardCount).toBe(24);

    const cardsRes = await request.get(`/api/admin/card-packs?packId=${en!.id}`);
    expect(cardsRes.status()).toBe(200);
    const { cards } = (await cardsRes.json()) as {
      cards: Array<{ word: string; forbiddenWords: string }>;
    };
    expect(cards).toHaveLength(24);
    expect(cards[0]!.word).toBeTruthy();
    expect(cards[0]!.forbiddenWords).toBeTruthy();

    // ── 3. The bootstrap server (self-host: single server, the owner
    // is its host — instance creation is official-hub-only).
    if (!bootstrapServerId) {
      const serversRes = await request.get('/api/servers');
      expect(serversRes.status()).toBe(200);
      const { servers } = (await serversRes.json()) as {
        servers: Array<{ id: string; ownerUserId: string }>;
      };
      expect(servers.length).toBeGreaterThan(0);
      const own = servers.find((s) => ownerUid && s.ownerUserId === ownerUid) ?? servers[0]!;
      bootstrapServerId = own.id;
      ownerUid = own.ownerUserId;
    }

    // ── 4. Default channels exist (general text + Main Lounge voice).
    const channelsRes = await request.get(`/api/servers/${bootstrapServerId}/channels`);
    expect(channelsRes.status()).toBe(200);
    const { channels } = (await channelsRes.json()) as {
      channels: Array<{ id: string; type: string; name: string }>;
    };
    const voice = channels.find((c) => c.type === 'voice');
    expect(voice?.name).toBe('Main Lounge');

    // ── 4.5 Install the Hushle app for this server (the activities
    // route 403s until the plugin is installed AND enabled).
    const installRes = await request.post(`/api/servers/${bootstrapServerId}/apps`, {
      headers: ORIGIN,
      data: { pluginId: 'hushle', enabled: true },
    });
    expect(installRes.status()).toBe(200);

    // ── 5. Start a Hushle activity in the voice channel.
    const activityRes = await request.post(
      `/api/servers/${bootstrapServerId}/channels/${voice!.id}/activities`,
      { headers: ORIGIN, data: { pluginId: 'hushle' } }
    );
    expect(activityRes.status()).toBe(201);
    const { activity } = (await activityRes.json()) as { activity: { id: string } };

    const action = async (body: Record<string, unknown>) => {
      const res = await request.post(
        `/api/servers/${bootstrapServerId}/activities/${activity.id}/actions`,
        { headers: ORIGIN, data: body }
      );
      const state =
        res.status() === 200
          ? ((await res.json()) as { activity: { state: Record<string, unknown> } }).activity.state
          : null;
      return { res, state };
    };
    const getState = async () => {
      const res = await request.get(`/api/servers/${bootstrapServerId}/activities/${activity.id}`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { activity: { state: Record<string, unknown> } }).activity
        .state;
    };

    // ── 6. start-game with the built-in EN pack slug: the deck is
    // hydrated from the real card_packs/cards tables.
    const start = await action({
      type: 'start-game',
      packId: 'hushle-en-basic',
      language: 'en',
      createdBy: ownerUid,
    });
    expect(start.res.status()).toBe(200);
    expect(start.state!.phase).toBe('team_setup');
    expect(start.state!.deckSize).toBe(24);
    // LF-001 anti-cheat: the deck NEVER leaves the server — not even
    // for the host who just dispatched the action.
    expect(start.state!.deck).toBeUndefined();
    expect(start.state!.currentCard).toBeNull();

    // ── 7. Team setup + first turn. The owner explains → the card is
    // visible to them, invisible deck, one card consumed.
    const teams = await action({
      type: 'set-teams',
      teams: [
        { name: 'Team A', playerIds: [ownerUid] },
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
      explainerId: ownerUid,
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
    const hidden = await getState();
    expect(hidden.currentCard).toBeNull();
    expect(hidden.deckSize).toBe(24);

    // Restore the explainer → the card is visible again on a plain GET.
    await action({ type: 'set-explainer', explainerId: ownerUid });
    const visible = await getState();
    expect((visible.currentCard as { word: string } | null)?.word).toBeTruthy();

    // ── 9. Classic-Taboo bust rules: a TEAMMATE (the host is on Team A
    // with the explainer) cannot bust — the state must not change.
    const before = await getState();
    const bust = await action({ type: 'bust-forbidden', bustedBy: ownerUid });
    expect(bust.res.status()).toBe(200);
    const after = await getState();
    expect(after).toEqual(before); // reducer rejected the self-bust
  });

  // Runs LAST (serial): guest issuance requires a bootstrapped instance.
  test('guest identities can be issued', async ({ request }) => {
    const res = await request.post('/api/auth/guest', { headers: ORIGIN, data: {} });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { guest: { uid: string; gid: string } };
    expect(body.guest.uid).toBeTruthy();
    expect(body.guest.gid).toBeTruthy();
  });
});
