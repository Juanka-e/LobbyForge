import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGuestSessionCookie, type GuestIdentity } from '@/lib/guest-session';

/**
 * Security review BOT-002: rotating or revoking a leaked token must also
 * end the bot's outgoing event endpoint — its URL and signing secret were
 * set by whoever held the old token. One stateful stand-in for the bot and
 * endpoint rows, shared by the REAL token route, the delivery queue, the
 * interaction dispatch and the reachability check (`bot_offline`):
 *
 *   endpoint set → deliveries go out, interactions reachable
 *   rotate / revoke → endpoint off (`token_changed`): nothing is delivered,
 *   not even a retry queued before the change; interactions answer
 *   `bot_offline` (no stream either — the gateway closed it).
 */

type Endpoint = {
  botId: string; url: string; secret: string; events: string[]; enabled: boolean; failureCount: number;
  disabledReason: string | null; lastDeliveryAt: Date | null; lastStatus: number | null; createdAt: Date; updatedAt: Date;
};

const SECRET = 'x'.repeat(32);
const SERVER = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';
const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CHANNEL = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  bot: null as null | Record<string, unknown>,
  endpoint: null as null | Record<string, unknown>,
}));

const db = vi.hoisted(() => ({
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  getBotById: vi.fn(),
  getActiveBotById: vi.fn(),
  getBotEventEndpoint: vi.fn(),
  listBotEventEndpoints: vi.fn(),
  changeBotToken: vi.fn(),
  reenableBotEventEndpoint: vi.fn(),
  recordBotEventDeliverySuccess: vi.fn(),
  recordBotEventDeliveryFailure: vi.fn(),
  getBotReachableChannel: vi.fn(),
  listBotEventTargets: vi.fn(),
  listBotChannelAccessForServer: vi.fn(),
  logAction: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => ({ ...db, ENDPOINT_DISABLED_TOKEN_CHANGED: 'token_changed' }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('@/lib/security-headers', () => ({
  withApiSecurity: (handler: unknown) => handler,
  distributedRateLimit: async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 }),
}));
vi.mock('@/lib/mail/verification', () => ({ requireVerifiedEmail: async () => null }));
vi.mock('@/lib/access-invalidation', () => ({ publishAccessInvalidation: vi.fn(async () => undefined) }));
// No live event stream: the gateway closed it on `token_changed` (and none was open).
const redis = vi.hoisted(() => ({ publish: vi.fn(async () => 1), pubsub: vi.fn(async (_s: string, channel: string) => [channel, 0]) }));
vi.mock('@/lib/redis', () => ({ redis }));
const fetchIpPinned = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ip-pinned-https', () => ({ fetchIpPinned, resolvePublicAddresses: vi.fn(async () => ['93.184.216.34']) }));

const ok = () => ({ ok: true, status: 200, body: Buffer.alloc(0), arrayBuffer: new ArrayBuffer(0) });

function cookie(uid: string): string {
  const identity: GuestIdentity = { gid: 'g_'.padEnd(34, 'a'), uid, name: 'Owner' };
  return `lf_guest=${buildGuestSessionCookie(identity, SECRET).raw}`;
}
const tokenRequest = (method: 'POST' | 'DELETE') =>
  new Request(`https://chat.example.test/api/servers/${SERVER}/bots/${BOT_ID}/token`, { method, headers: { cookie: cookie(OWNER) } });
const botCtx = { params: Promise.resolve({ id: SERVER, botId: BOT_ID }) };

function freshBot() {
  return {
    id: BOT_ID, serverId: SERVER, name: 'Dice', type: 'custom', tokenHash: 'sha256$old', tokenIssuedAt: new Date(),
    permissions: ['receive_events', 'slash_commands', 'read_messages', 'send_messages'], settings: {}, enabled: true,
    createdBy: OWNER, createdByName: 'Owner', lastUsedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
}
function freshEndpoint(): Endpoint {
  return {
    botId: BOT_ID, url: 'https://attacker.example.net/hook', secret: `whsec_${'a'.repeat(43)}`,
    events: ['interaction_create', 'message_create'], enabled: true, failureCount: 0, disabledReason: null,
    lastDeliveryAt: null, lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

const messageJob = { botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } };

beforeEach(() => {
  vi.resetModules();
  process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
  for (const fn of [...Object.values(db), fetchIpPinned]) fn.mockReset();
  state.bot = freshBot();
  state.endpoint = freshEndpoint();
  db.getServerById.mockResolvedValue({ id: SERVER, name: 'Lobby', ownerUserId: OWNER });
  db.isServerMember.mockResolvedValue(true);
  db.getUserPermissions.mockResolvedValue(['administrator']);
  db.getBotById.mockImplementation(async () => (state.bot ? { ...state.bot } : null));
  db.getActiveBotById.mockImplementation(async () => (state.bot ? { ...state.bot } : null));
  db.getBotEventEndpoint.mockImplementation(async () => (state.endpoint ? { ...state.endpoint } : null));
  db.listBotEventEndpoints.mockImplementation(async () => new Map(state.endpoint ? [[BOT_ID, { ...state.endpoint }]] : []));
  // What `changeBotToken` does in one transaction: new hash + endpoint off (token_changed).
  db.changeBotToken.mockImplementation(async (_db: unknown, _id: string, hash: string | null) => {
    state.bot = { ...state.bot!, tokenHash: hash, tokenIssuedAt: hash ? new Date() : null };
    let endpointDisabled = false;
    if (state.endpoint && (state.endpoint.enabled || state.endpoint.disabledReason !== 'token_changed')) {
      state.endpoint = { ...state.endpoint, enabled: false, disabledReason: 'token_changed' };
      endpointDisabled = true;
    }
    return { bot: { ...state.bot }, endpointDisabled };
  });
  db.recordBotEventDeliverySuccess.mockResolvedValue(undefined);
  db.recordBotEventDeliveryFailure.mockResolvedValue(null);
  db.getBotReachableChannel.mockResolvedValue({ id: CHANNEL, serverId: SERVER, type: 'text', name: 'general' });
  db.listBotEventTargets.mockResolvedValue([]);
  db.listBotChannelAccessForServer.mockResolvedValue(new Map());
  db.logAction.mockResolvedValue(undefined);
  fetchIpPinned.mockResolvedValue(ok());
});

afterEach(() => {
  vi.useRealTimers();
});

async function modules() {
  return {
    token: await import('../../../app/api/servers/[id]/bots/[botId]/token/route'),
    delivery: await import('../event-delivery'),
    reachability: await import('../reachability'),
    interactions: await import('../interactions'),
  };
}

function interactionRow() {
  return {
    id: 'int-1', botId: BOT_ID, commandId: 'cmd-1', serverId: SERVER, channelId: CHANNEL, userId: OWNER, commandName: 'roll',
    options: {}, status: 'pending', response: null, followupCount: 0, createdAt: new Date(), answeredAt: null,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  };
}

describe.each([
  ['rotate', 'POST' as const],
  ['revoke', 'DELETE' as const],
])('BOT-002: endpoint set → token %s', (_label, method) => {
  it('deliveries stop, interactions answer bot_offline, and the switch-off is audited', async () => {
    const { token, delivery, reachability, interactions } = await modules();

    // Before: the endpoint receives events and makes interactions reachable.
    delivery.enqueueDelivery(messageJob);
    await delivery.__drainEventDelivery();
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    expect(await reachability.botCanReceiveInteractions(state.bot as never)).toBe(true);

    const res = await token[method](tokenRequest(method), botCtx);
    expect(res.status).toBe(200);
    expect(state.endpoint).toMatchObject({ enabled: false, disabledReason: 'token_changed' });
    expect(db.logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'bot.event_endpoint.disable', metadata: expect.objectContaining({ reason: 'token_changed' }) })
    );

    // After: nothing more leaves for the old holder's URL — no event, no interaction.
    delivery.enqueueDelivery(messageJob);
    await interactions.dispatchInteractionCreate({
      bot: state.bot as never,
      interaction: interactionRow() as never,
      user: { id: OWNER, displayName: 'Owner' },
      locale: 'en',
    });
    await delivery.__drainEventDelivery();
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);

    // The invoke route's check: no endpoint, no stream → 409 bot_offline.
    expect(await reachability.botCanReceiveInteractions(state.bot as never)).toBe(false);
    expect(await reachability.botsReceivingInteractions([state.bot as never])).toEqual(new Set());
  });

  it('a retry queued before the change is dropped after it', async () => {
    vi.useFakeTimers();
    const { token, delivery } = await modules();
    fetchIpPinned.mockResolvedValue({ ok: false, status: 503, body: Buffer.alloc(0), arrayBuffer: new ArrayBuffer(0) });
    delivery.enqueueDelivery(messageJob);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    expect((await token[method](tokenRequest(method), botCtx)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
  });
});

describe('BOT-002: a manager cannot re-arm the old URL', () => {
  it('re-enabling an endpoint switched off by a token change is refused (409 endpoint_token_changed)', async () => {
    const { token } = await modules();
    await token.POST(tokenRequest('POST'), botCtx);
    const route = await import('../../../app/api/servers/[id]/bots/[botId]/event-endpoint/route');
    const res = await route.PATCH(
      new Request(`https://chat.example.test/api/servers/${SERVER}/bots/${BOT_ID}/event-endpoint`, {
        method: 'PATCH',
        headers: { cookie: cookie(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
      botCtx
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'endpoint_token_changed' });
    expect(db.reenableBotEventEndpoint).not.toHaveBeenCalled();
    expect(state.endpoint).toMatchObject({ enabled: false });
  });
});
