/**
 * Concurrent activity actions (regression: when several players acted at
 * the same moment, most actions answered 409 "too many concurrent actions"
 * — three optimistic retries without backoff; actions are now serialized
 * per session):
 *
 *   - eight players roll the dice at the same moment, three rounds: every
 *     roll is answered 200 and applied (three rolls each in the stats);
 *   - eight players vote at the same moment: the poll counts eight ballots.
 *
 * Runs only against a compose stack (LF_E2E_BASE_URL). API only (the
 * activity actions route the panels use); all contexts share one client
 * address, so the per-address action bucket is cleared between rounds.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { clearRateLimitBuckets, createGuest, resetRateLimits, signIn } from './helpers/auth';

const baseUrl = process.env.LF_E2E_BASE_URL ?? '';
const setupToken = process.env.LF_E2E_SETUP_TOKEN ?? '';
const OWNER_EMAIL = 'owner@e2e.local';
const OWNER_PASSWORD = 'compose-e2e-owner-pw';
const ORIGIN = { Origin: baseUrl };
const RUN = Date.now().toString(36);
const PLAYERS = 8;

test.skip(!baseUrl, 'Runs only against the compose stack (set LF_E2E_BASE_URL).');
test.describe.configure({ mode: 'serial', timeout: 180_000 });

interface Player {
  api: APIRequestContext;
  uid: string;
}

test.describe('concurrent activity actions', () => {
  let owner: APIRequestContext;
  let ownerUid = '';
  let serverId = '';
  let channelId = '';
  const players: Player[] = [];
  const sessions: string[] = [];

  const S = () => `/api/servers/${serverId}`;
  const start = async (pluginId: string) => {
    const res = await owner.post(`${S()}/channels/${channelId}/activities`, { data: { pluginId } });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { activity: { id: string } }).activity.id;
    sessions.push(id);
    return id;
  };
  const end = (id: string) => owner.post(`${S()}/activities/${id}/end`, { data: {} });

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(180_000);
    // One client address for every context here: start from a fresh rate-limit window.
    resetRateLimits();
    owner = await playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
    const setup = await owner.post('/api/setup/complete', {
      data: {
        setupToken,
        instanceName: 'Concurrency E2E',
        ownerDisplayName: 'Owner',
        ownerEmail: OWNER_EMAIL,
        ownerPassword: OWNER_PASSWORD,
        registrationMode: 'open',
        guestAccessEnabled: true,
        seoIndexingEnabled: false,
      },
    });
    if (setup.status() !== 200) {
      const login = await signIn(owner, { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
      expect(login.status(), 'owner login on a warm stack').toBe(200);
    }
    ownerUid = ((await (await owner.get('/api/auth/guest')).json()) as { guest: { uid: string } }).guest.uid;
    serverId = ((await (await owner.get('/api/servers')).json()) as { servers: Array<{ id: string }> }).servers[0]!.id;
    const room = await owner.post(`${S()}/channels`, { data: { name: `burst-${RUN}`, type: 'voice' } });
    expect(room.status()).toBe(201);
    channelId = ((await room.json()) as { channel: { id: string } }).channel.id;
    for (const pluginId of ['dice-bot', 'poll']) {
      expect((await owner.post(`${S()}/apps`, { data: { pluginId, enabled: true } })).status()).toBe(200);
    }
    const invite = await owner.post(`${S()}/invites`, { data: { maxUses: PLAYERS } });
    expect(invite.status()).toBe(201);
    const { code } = ((await invite.json()) as { invite: { code: string } }).invite;
    for (let i = 1; i <= PLAYERS; i += 1) {
      const api = await playwright.request.newContext({ baseURL: baseUrl, extraHTTPHeaders: ORIGIN });
      expect((await createGuest(api, { data: { displayNameSeed: `Burst ${i} ${RUN.slice(-4)}` } })).status()).toBe(200);
      expect((await api.post(`/api/invites/${code}/redeem`)).status()).toBe(201);
      const uid = ((await (await api.get('/api/auth/guest')).json()) as { guest: { uid: string } }).guest.uid;
      players.push({ api, uid });
    }
  });

  test.afterAll(async () => {
    for (const id of sessions) await end(id).catch(() => undefined);
    if (channelId) await owner?.delete(`${S()}/channels/${channelId}`).catch(() => undefined);
    for (const p of players) await p.api.dispose();
    await owner?.dispose();
  });

  test('eight players roll at the same moment, three rounds: every roll is applied', async () => {
    const session = await start('dice-bot');
    for (let round = 1; round <= 3; round += 1) {
      clearRateLimitBuckets(['activity-action']);
      const codes = await Promise.all(
        players.map((p) =>
          p.api.post(`${S()}/activities/${session}/actions`, { data: { type: 'roll', playerId: p.uid, sides: 20 } }).then((r) => r.status())
        )
      );
      expect(codes, `round ${round}`).toEqual(Array(PLAYERS).fill(200));
    }
    const { activity } = (await (await owner.get(`${S()}/activities/${session}`)).json()) as {
      activity: { state: { stats: Record<string, { rolls: number }> } };
    };
    expect(players.map((p) => activity.state.stats[p.uid]?.rolls ?? 0)).toEqual(Array(PLAYERS).fill(3));
    await end(session);
  });

  test('eight players vote at the same moment: the poll counts eight ballots', async () => {
    const session = await start('poll');
    clearRateLimitBuckets(['activity-action']);
    const opened = await owner.post(`${S()}/activities/${session}/actions`, {
      data: { type: 'open-poll', hostId: ownerUid, question: `Burst poll ${RUN}?`, options: ['Red', 'Blue'] },
    });
    expect(opened.status()).toBe(200);
    const options = ((await opened.json()) as { activity: { state: { options: Array<{ id: string }> } } }).activity.state.options;
    const codes = await Promise.all(
      players.map((p, i) =>
        p.api
          .post(`${S()}/activities/${session}/actions`, { data: { type: 'vote', playerId: p.uid, optionId: options[i % 2]!.id } })
          .then((r) => r.status())
      )
    );
    expect(codes).toEqual(Array(PLAYERS).fill(200));
    const { activity } = (await (await players[0]!.api.get(`${S()}/activities/${session}`)).json()) as {
      activity: { state: { ballotCount: number; options: Array<{ votes: number }> } };
    };
    expect(activity.state.ballotCount).toBe(PLAYERS);
    expect(activity.state.options.map((o) => o.votes)).toEqual([PLAYERS / 2, PLAYERS / 2]);
    await end(session);
  });
});
