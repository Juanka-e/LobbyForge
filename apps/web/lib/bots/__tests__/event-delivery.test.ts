import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outgoing event deliveries (BOT_API_V2 §5.2): the signature, the request
 * shape, retries with backoff, the SSRF re-check on every attempt, the
 * disable-after-20 accounting and the synchronous answer hook. The network
 * and the database are replaced; the queue and timers are real (fake clock).
 */

const getActiveBotById = vi.fn();
const getBotEventEndpoint = vi.fn();
const recordBotEventDeliverySuccess = vi.fn();
const recordBotEventDeliveryFailure = vi.fn();
const logAction = vi.fn();
vi.mock('@lobbyforge/db', () => ({
  getActiveBotById,
  getBotEventEndpoint,
  recordBotEventDeliverySuccess,
  recordBotEventDeliveryFailure,
  logAction,
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));
const fetchIpPinned = vi.fn();
const resolvePublicAddresses = vi.fn();
vi.mock('@/lib/ip-pinned-https', () => ({ fetchIpPinned, resolvePublicAddresses }));

const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SERVER = '11111111-1111-4111-8111-111111111111';
const SECRET = `whsec_${'k'.repeat(43)}`;

function bot(overrides: Record<string, unknown> = {}) {
  return { id: BOT_ID, serverId: SERVER, type: 'custom', enabled: true, permissions: ['receive_events', 'slash_commands', 'read_messages'], ...overrides };
}
function endpoint(overrides: Record<string, unknown> = {}) {
  return { botId: BOT_ID, url: 'https://bot.example.com/hook', secret: SECRET, events: ['interaction_create', 'message_create'], enabled: true, failureCount: 0, ...overrides };
}
const ok = (body = '') => ({ ok: true, status: 200, body: Buffer.from(body), arrayBuffer: new ArrayBuffer(0) });
const status = (code: number) => ({ ok: false, status: code, body: Buffer.alloc(0), arrayBuffer: new ArrayBuffer(0) });

async function load() {
  return import('../event-delivery');
}

beforeEach(() => {
  vi.resetModules();
  for (const fn of [getActiveBotById, getBotEventEndpoint, recordBotEventDeliverySuccess, recordBotEventDeliveryFailure, logAction, fetchIpPinned, resolvePublicAddresses]) {
    fn.mockReset();
  }
  getActiveBotById.mockResolvedValue(bot());
  getBotEventEndpoint.mockResolvedValue(endpoint());
  recordBotEventDeliverySuccess.mockResolvedValue(undefined);
  recordBotEventDeliveryFailure.mockResolvedValue({ endpoint: endpoint({ failureCount: 1 }), justDisabled: false });
  logAction.mockResolvedValue(undefined);
  resolvePublicAddresses.mockResolvedValue(['93.184.216.34']);
  fetchIpPinned.mockResolvedValue(ok());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signature', () => {
  it('is v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>', async () => {
    const { signDelivery } = await load();
    const body = '{"id":"d","event":"ping","timestamp":1700000000,"data":{}}';
    const expected = createHmac('sha256', SECRET).update(`1700000000.${body}`).digest('hex');
    expect(signDelivery(SECRET, 1700000000, body)).toBe(`v1=${expected}`);
    // A known vector, so a change in encoding is caught even if both sides drift.
    expect(signDelivery('secret', '1', 'body')).toBe(`v1=${createHmac('sha256', 'secret').update('1.body').digest('hex')}`);
    expect(signDelivery(SECRET, 1700000000, body)).not.toBe(signDelivery(SECRET, 1700000001, body));
  });

  it('secrets are 256-bit and never repeat', async () => {
    const { generateEndpointSecret } = await load();
    const a = generateEndpointSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateEndpointSecret()).not.toBe(a);
  });
});

describe('URL shape', () => {
  it('https only, no credentials, at most 512 characters; the fragment is dropped', async () => {
    const { checkEndpointUrlShape } = await load();
    expect(checkEndpointUrlShape('http://bot.example.com/')).toMatchObject({ ok: false });
    expect(checkEndpointUrlShape('ftp://bot.example.com/')).toMatchObject({ ok: false });
    expect(checkEndpointUrlShape('https://user:pw@bot.example.com/')).toMatchObject({ ok: false });
    expect(checkEndpointUrlShape(`https://bot.example.com/${'a'.repeat(520)}`)).toMatchObject({ ok: false });
    expect(checkEndpointUrlShape('not a url')).toMatchObject({ ok: false });
    expect(checkEndpointUrlShape('https://bot.example.com/hook#frag')).toEqual({
      ok: true,
      url: 'https://bot.example.com/hook',
      hostname: 'bot.example.com',
    });
  });
});

describe('deliveries', () => {
  it('POSTs the signed body with every header, once, and records the success', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'interaction_create', data: { event: 'interaction_create', interaction: { id: 'i' } } });
    await __drainEventDelivery();
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    const [url, host, addresses, options] = fetchIpPinned.mock.calls[0]!;
    expect([url, host, addresses]).toEqual(['https://bot.example.com/hook', 'bot.example.com', ['93.184.216.34']]);
    expect(options).toMatchObject({ method: 'POST', timeoutMs: 3000, totalTimeoutMs: 3000 });
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ event: 'interaction_create', data: { interaction: { id: 'i' } } });
    expect(options.headers['x-lobbyforge-event']).toBe('interaction_create');
    expect(options.headers['x-lobbyforge-delivery']).toBe(body.id);
    expect(options.headers['x-lobbyforge-timestamp']).toBe(String(body.timestamp));
    const mac = createHmac('sha256', SECRET).update(`${body.timestamp}.${options.body}`).digest('hex');
    expect(options.headers['x-lobbyforge-signature']).toBe(`v1=${mac}`);
    expect(recordBotEventDeliverySuccess).toHaveBeenCalledWith(expect.anything(), { botId: BOT_ID, status: 200 });
  });

  it('sends nothing to a disabled endpoint, an unsubscribed event, a bot without receive_events, or one that fails authorize', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    const job = { botId: BOT_ID, serverId: SERVER, event: 'interaction_create', data: { event: 'interaction_create' } };
    getBotEventEndpoint.mockResolvedValueOnce(endpoint({ enabled: false }));
    enqueueDelivery(job);
    getBotEventEndpoint.mockResolvedValueOnce(endpoint({ events: ['member_join'] }));
    enqueueDelivery(job);
    getActiveBotById.mockResolvedValueOnce(bot({ permissions: ['slash_commands'] }));
    enqueueDelivery(job);
    getActiveBotById.mockResolvedValueOnce(bot({ serverId: 'another-server' }));
    enqueueDelivery(job);
    enqueueDelivery({ ...job, authorize: () => false });
    await __drainEventDelivery();
    expect(fetchIpPinned).not.toHaveBeenCalled();
  });

  it('retries a 5xx after 1 s, 5 s and 30 s, then counts ONE failure', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    fetchIpPinned.mockResolvedValue(status(503));
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    // Attempt 1 at t=0 → retry at 1 s → retry 5 s later (6 s) → 30 s later (36 s).
    await vi.advanceTimersByTimeAsync(1_000); // t = 1.01 s
    expect(fetchIpPinned).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_980); // t = 5.99 s
    expect(fetchIpPinned).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20); // t = 6.01 s
    expect(fetchIpPinned).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(29_980); // t = 35.99 s
    expect(fetchIpPinned).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20); // t = 36.01 s
    expect(fetchIpPinned).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchIpPinned).toHaveBeenCalledTimes(4);
    expect(recordBotEventDeliveryFailure).toHaveBeenCalledTimes(1);
    expect(recordBotEventDeliveryFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ botId: BOT_ID, status: 503, maxFailures: 20 }));
    // Every attempt carried the identical bytes (same delivery id and signature).
    const bodies = new Set(fetchIpPinned.mock.calls.map((call) => call[3].body));
    expect(bodies.size).toBe(1);
  });

  it('a timeout or network error is retried; a 4xx is final', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    fetchIpPinned.mockRejectedValueOnce(new Error('No response headers within 3000 ms')).mockResolvedValueOnce(ok());
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await vi.advanceTimersByTimeAsync(1_010);
    expect(fetchIpPinned).toHaveBeenCalledTimes(2);
    expect(recordBotEventDeliverySuccess).toHaveBeenCalledTimes(1);

    fetchIpPinned.mockReset().mockResolvedValue(status(404));
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    expect(recordBotEventDeliveryFailure).toHaveBeenCalledTimes(1);
  });

  it('re-checks the address on EVERY attempt: a host that now resolves privately is refused, not retried', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    resolvePublicAddresses.mockRejectedValue(new Error('Target resolves to a blocked address: 10.0.0.5'));
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await __drainEventDelivery();
    expect(fetchIpPinned).not.toHaveBeenCalled();
    expect(recordBotEventDeliveryFailure).toHaveBeenCalledTimes(1);
  });

  it('drops a pending retry when the endpoint was replaced or switched off meanwhile', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    fetchIpPinned.mockResolvedValue(status(500));
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await vi.advanceTimersByTimeAsync(10);
    getBotEventEndpoint.mockResolvedValue(endpoint({ secret: `whsec_${'n'.repeat(43)}` }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
  });

  it('the 20th consecutive failure switches the endpoint off and is audited', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    fetchIpPinned.mockResolvedValue(status(410));
    recordBotEventDeliveryFailure.mockResolvedValue({ endpoint: endpoint({ enabled: false, failureCount: 20 }), justDisabled: true });
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await __drainEventDelivery();
    await vi.waitFor(() => expect(logAction).toHaveBeenCalled());
    expect(logAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'bot.event_endpoint.disable', targetId: BOT_ID, serverId: SERVER, actorUserId: null })
    );
  });

  it('hands a 2xx body to onResponse (the synchronous interaction answer)', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    fetchIpPinned.mockResolvedValue(ok('{"type":"respond","content":"6","ephemeral":true}'));
    const onResponse = vi.fn();
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'interaction_create', data: { event: 'interaction_create' }, priority: 'high', onResponse });
    await __drainEventDelivery();
    expect(onResponse).toHaveBeenCalledWith({ status: 200, body: Buffer.from('{"type":"respond","content":"6","ephemeral":true}') });
  });

  it('defaults an endpoint to the events its permissions allow', async () => {
    const { defaultEndpointEvents } = await load();
    expect(defaultEndpointEvents(['receive_events'])).toEqual(['channel_access_changed']);
    expect(defaultEndpointEvents(['read_messages', 'read_members', 'slash_commands']).sort()).toEqual(
      ['channel_access_changed', 'interaction_create', 'member_join', 'member_leave', 'message_create', 'message_delete', 'message_update'].sort()
    );
  });
});
