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

  it('BOT-004: a single-label host (a Docker service name, a search-domain name) is refused; IP literals go on to the address check', async () => {
    const { checkEndpointUrlShape } = await load();
    for (const url of ['https://postgres/hook', 'https://redis:6379/', 'https://web./hook', 'https://intranet/']) {
      expect(checkEndpointUrlShape(url), url).toMatchObject({ ok: false, reason: 'url needs a fully qualified domain name' });
    }
    expect(checkEndpointUrlShape('https://93.184.216.34/hook')).toMatchObject({ ok: true });
    expect(checkEndpointUrlShape('https://[2606:2800:220:1::248]/hook')).toMatchObject({ ok: true });
    expect(checkEndpointUrlShape('https://bot.example.com./hook')).toMatchObject({ ok: true });
  });

  it('BOT-004: a save-time refusal of the address names no IP, host or resolver error — those go to the server log only', async () => {
    const { validateEndpointUrl, ENDPOINT_NOT_PUBLIC_REASON } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reasons: string[] = [];
    for (const failure of [
      new Error('Target resolves to a blocked address: 172.20.0.4'),
      new Error('getaddrinfo ENOTFOUND postgres.lobbyforge_internal'),
      new Error('Could not resolve "bot.corp.example": ESERVFAIL'),
      new Error('DNS resolution of "slow.example.com" exceeded 2000 ms'),
    ]) {
      resolvePublicAddresses.mockRejectedValueOnce(failure);
      const verdict = await validateEndpointUrl('https://bot.corp.example/hook');
      expect(verdict.ok).toBe(false);
      reasons.push((verdict as { reason: string }).reason);
    }
    expect(new Set(reasons)).toEqual(new Set([ENDPOINT_NOT_PUBLIC_REASON]));
    expect(reasons.join(' ')).not.toMatch(/\d+\.\d+\.\d+\.\d+|ENOTFOUND|ESERVFAIL|blocked|postgres|corp\.example|slow\.example/);
    expect(warn.mock.calls.flat().join(' ')).toContain('172.20.0.4');
    warn.mockRestore();
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

  it('hands a 2xx body to onResponse (the synchronous interaction answer) with the bot as re-read after the answer', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    fetchIpPinned.mockImplementation(async () => {
      // Renamed while the request was out: the answer acts as the CURRENT bot.
      getActiveBotById.mockResolvedValue(bot({ name: 'Renamed' }));
      return ok('{"type":"respond","content":"6","ephemeral":true}');
    });
    const onResponse = vi.fn();
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'interaction_create', data: { event: 'interaction_create' }, priority: 'high', onResponse });
    await __drainEventDelivery();
    expect(onResponse).toHaveBeenCalledWith({
      status: 200,
      body: Buffer.from('{"type":"respond","content":"6","ephemeral":true}'),
      bot: expect.objectContaining({ id: BOT_ID, name: 'Renamed' }),
    });
  });

  it('resolves the endpoint host with the 2 s deadline (c-ares, off the libuv threadpool)', async () => {
    const { enqueueDelivery, __drainEventDelivery, ENDPOINT_DNS_TIMEOUT_MS } = await load();
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await __drainEventDelivery();
    expect(ENDPOINT_DNS_TIMEOUT_MS).toBe(2_000);
    expect(resolvePublicAddresses).toHaveBeenCalledWith('bot.example.com', { timeoutMs: 2_000 });
  });

  it('sends nothing to an endpoint switched off by a token rotate / revoke (BOT-002)', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    getBotEventEndpoint.mockResolvedValue(endpoint({ enabled: false, disabledReason: 'token_changed' }));
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'interaction_create', data: { event: 'interaction_create' }, priority: 'high', onResponse: vi.fn() });
    enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await __drainEventDelivery();
    expect(fetchIpPinned).not.toHaveBeenCalled();
  });

  it('defaults an endpoint to the events its permissions allow', async () => {
    const { defaultEndpointEvents } = await load();
    expect(defaultEndpointEvents(['receive_events'])).toEqual(['channel_access_changed']);
    expect(defaultEndpointEvents(['read_messages', 'read_members', 'slash_commands']).sort()).toEqual(
      ['channel_access_changed', 'interaction_create', 'member_join', 'member_leave', 'message_create', 'message_delete', 'message_update'].sort()
    );
  });
});

// ── re-authorization: every attempt, and the synchronous answer ──────────

describe('re-authorization before every retry and before a synchronous answer', () => {
  const job = { botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create' } };

  it.each([
    ['the bot lost receive_events', () => getActiveBotById.mockResolvedValue(bot({ permissions: ['read_messages'] }))],
    ['the bot was switched off', () => getActiveBotById.mockResolvedValue(bot({ enabled: false }))],
    ['the bot was deleted', () => getActiveBotById.mockResolvedValue(null)],
    ['the token changed (endpoint switched off)', () => getBotEventEndpoint.mockResolvedValue(endpoint({ enabled: false, disabledReason: 'token_changed' }))],
    ['the endpoint no longer subscribes to the event', () => getBotEventEndpoint.mockResolvedValue(endpoint({ events: ['interaction_create'] }))],
  ])('a pending retry is dropped when %s', async (_label, change) => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    fetchIpPinned.mockResolvedValue(status(503));
    enqueueDelivery(job);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    change();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
  });

  it('a pending retry is dropped when the job’s own check fails now (e.g. the channel is no longer reachable)', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    fetchIpPinned.mockResolvedValue(status(503));
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    enqueueDelivery({ ...job, authorize });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it('the synchronous answer is NOT applied when the token changed while the request was out', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    fetchIpPinned.mockImplementation(async () => {
      getBotEventEndpoint.mockResolvedValue(endpoint({ enabled: false, disabledReason: 'token_changed' }));
      return ok('{"type":"respond","content":"posted by the old token holder"}');
    });
    const onResponse = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueDelivery({ ...job, event: 'interaction_create', data: { event: 'interaction_create' }, priority: 'high', onResponse });
    await __drainEventDelivery();
    expect(fetchIpPinned).toHaveBeenCalledTimes(1);
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('the synchronous answer is NOT applied when the job’s check fails by then (slash_commands or the channel lost)', async () => {
    const { enqueueDelivery, __drainEventDelivery } = await load();
    fetchIpPinned.mockResolvedValue(ok('{"type":"respond","content":"x"}'));
    const onResponse = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueDelivery({
      ...job,
      event: 'interaction_create',
      data: { event: 'interaction_create' },
      authorize: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      onResponse,
    });
    await __drainEventDelivery();
    expect(onResponse).not.toHaveBeenCalled();
  });
});

// ── fairness (security review BOT-003) ───────────────────────────────────

describe('fairness: per-bot caps and round-robin across servers and bots', () => {
  /** Bots by id → their server; every bot gets its own endpoint host. */
  const serverOf = new Map<string, string>();
  function useBots(): void {
    getActiveBotById.mockImplementation(async (_db: unknown, id: string) => bot({ id, serverId: serverOf.get(id) ?? SERVER }));
    getBotEventEndpoint.mockImplementation(async (_db: unknown, id: string) => endpoint({ botId: id, url: `https://${id}.example.com/hook` }));
  }
  const jobFor = (botId: string, serverId: string, extra: Record<string, unknown> = {}) => {
    serverOf.set(botId, serverId);
    return { botId, serverId, event: 'message_create', data: { event: 'message_create', ...extra } };
  };
  const hostOf = (call: unknown[]) => new URL(call[0] as string).hostname.split('.')[0]!;
  const nOf = (call: unknown[]) => JSON.parse((call[3] as { body: string }).body).data.n as number;

  beforeEach(() => {
    serverOf.clear();
    useBots();
  });

  it('at most 2 in flight per bot; 100 waiting per bot, the overflow drops THAT bot’s own oldest deliveries', async () => {
    const { enqueueDelivery, __eventDeliveryState } = await load();
    const release: Array<() => void> = [];
    fetchIpPinned.mockImplementation(() => new Promise((resolve) => release.push(() => resolve(ok()))));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let n = 0; n < 110; n++) enqueueDelivery(jobFor('floody', 'srv-flood', { n }));
    enqueueDelivery(jobFor('quiet', 'srv-quiet', { n: 0 }));
    await vi.waitFor(() => expect(fetchIpPinned).toHaveBeenCalledTimes(3));
    const lanes = __eventDeliveryState().lanes;
    expect(lanes.find((l) => l.botId === 'floody')).toMatchObject({ active: 2, waiting: 100 });
    expect(lanes.find((l) => l.botId === 'quiet')).toMatchObject({ active: 1 });
    // n = 0, 1 went out; n = 2..9 (the oldest waiting) were dropped; the next one out is n = 10.
    expect(fetchIpPinned.mock.calls.filter((c) => hostOf(c) === 'floody').map(nOf)).toEqual([0, 1]);
    release.shift()!();
    await vi.waitFor(() => expect(fetchIpPinned).toHaveBeenCalledTimes(4));
    expect(nOf(fetchIpPinned.mock.calls[3]!)).toBe(10);
    for (const r of release.splice(0)) r();
  });

  it('a flood of slow-but-successful deliveries from one server does not hold up another server’s bot', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    fetchIpPinned.mockImplementation(async (url: string) => {
      if (url.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 2_900));
      return ok();
    });
    // 20 slow bots in one server, 20 deliveries each — enqueued before anyone else.
    for (let b = 0; b < 20; b++) for (let n = 0; n < 20; n++) enqueueDelivery(jobFor(`slow${b}`, 'srv-flood', { n }));
    enqueueDelivery(jobFor('fast', 'srv-other', { n: 0 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchIpPinned.mock.calls.some((c) => hostOf(c) === 'fast')).toBe(true);
    // The flooding server holds at most 8 of the 16 slots.
    expect(fetchIpPinned.mock.calls.filter((c) => hostOf(c).startsWith('slow'))).toHaveLength(8);
  });

  it('when every slot is busy, freed slots go round-robin: a server that waited is served before anyone gets more', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    fetchIpPinned.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return ok();
    });
    // 10 servers, one bot each, 4 deliveries each, enqueued server by server:
    // the first 8 servers fill the 16 slots (2 each); s8 and s9 wait.
    for (let s = 0; s < 10; s++) for (let n = 0; n < 4; n++) enqueueDelivery(jobFor(`b${s}`, `s${s}`, { n }));
    await vi.advanceTimersByTimeAsync(10);
    const firstWave = fetchIpPinned.mock.calls.map(hostOf);
    expect(firstWave).toHaveLength(16);
    expect(firstWave).not.toContain('b8');
    expect(firstWave).not.toContain('b9');
    // The first wave completes: s8 and s9 are among the very next deliveries.
    await vi.advanceTimersByTimeAsync(500);
    const secondWave = fetchIpPinned.mock.calls.slice(16).map(hostOf);
    expect(secondWave.slice(0, 4)).toEqual(expect.arrayContaining(['b8', 'b9']));
    // Nobody is ahead by more than the per-bot cap.
    for (let s = 0; s < 10; s++) expect(fetchIpPinned.mock.calls.filter((c) => hostOf(c) === `b${s}`).length).toBeLessThanOrEqual(4);
  });

  it('interactions go first within a bot’s lane', async () => {
    const { enqueueDelivery } = await load();
    const release: Array<() => void> = [];
    fetchIpPinned.mockImplementation(() => new Promise((resolve) => release.push(() => resolve(ok()))));
    for (let n = 0; n < 4; n++) enqueueDelivery(jobFor('dice', 'srv-1', { n }));
    getBotEventEndpoint.mockImplementation(async (_db: unknown, id: string) =>
      endpoint({ botId: id, url: `https://${id}.example.com/hook`, events: ['message_create', 'interaction_create'] })
    );
    enqueueDelivery({ ...jobFor('dice', 'srv-1'), event: 'interaction_create', data: { event: 'interaction_create', n: 99 }, priority: 'high' as const });
    await vi.waitFor(() => expect(fetchIpPinned).toHaveBeenCalledTimes(2));
    release.shift()!();
    await vi.waitFor(() => expect(fetchIpPinned).toHaveBeenCalledTimes(3));
    expect(nOf(fetchIpPinned.mock.calls[2]!)).toBe(99);
    for (const r of release.splice(0)) r();
  });

  it('the process-wide bound (2 000 waiting) costs the longest lanes, never a bot with a few deliveries', async () => {
    const { enqueueDelivery, __eventDeliveryState, MAX_QUEUED_DELIVERIES } = await load();
    fetchIpPinned.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueDelivery(jobFor('early', 'srv-early', { n: 0 }));
    enqueueDelivery(jobFor('early', 'srv-early', { n: 1 }));
    enqueueDelivery(jobFor('early', 'srv-early', { n: 2 }));
    for (let b = 0; b < 25; b++) for (let n = 0; n < 100; n++) enqueueDelivery(jobFor(`heavy${b}`, `srv-${b}`, { n }));
    const state = __eventDeliveryState();
    expect(state.queued).toBeLessThanOrEqual(MAX_QUEUED_DELIVERIES);
    // `early` keeps its one waiting delivery (2 are in flight).
    expect(state.lanes.find((l) => l.botId === 'early')).toMatchObject({ waiting: 1 });
  });
});

describe('back-off of a slow endpoint (BOT-003)', () => {
  it('3 slow answers in a row (> 1 s, even 2xx) back the endpoint off; a quick answer clears it', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery, __eventDeliveryState } = await load();
    let delayMs = 1_500;
    fetchIpPinned.mockImplementation(async () => {
      const wait = delayMs;
      await new Promise((resolve) => setTimeout(resolve, wait));
      return ok();
    });
    for (let n = 0; n < 8; n++) enqueueDelivery({ botId: BOT_ID, serverId: SERVER, event: 'message_create', data: { event: 'message_create', n } });
    // t = 0: two out; t = 1.5 s: two more (2 slow so far).
    await vi.advanceTimersByTimeAsync(1_510);
    expect(fetchIpPinned).toHaveBeenCalledTimes(4);
    // t = 3.0 s: the 3rd and 4th slow answers — backed off (1 s, then 2 s), nothing goes out.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchIpPinned).toHaveBeenCalledTimes(4);
    expect(__eventDeliveryState().backoffUntil(BOT_ID)).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(1_900); // t = 4.91 s
    expect(fetchIpPinned).toHaveBeenCalledTimes(4);
    // t = 5.0 s: the back-off ends; the endpoint answers quickly now, which clears it.
    delayMs = 10;
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchIpPinned).toHaveBeenCalledTimes(8);
    expect(__eventDeliveryState().backoffUntil(BOT_ID)).toBe(0);
    // Every delivery was still made (and counted as a success).
    expect(recordBotEventDeliverySuccess).toHaveBeenCalledTimes(8);
  });

  it('a backed-off bot does not hold up other bots', async () => {
    vi.useFakeTimers();
    const { enqueueDelivery } = await load();
    getActiveBotById.mockImplementation(async (_db: unknown, id: string) => bot({ id }));
    getBotEventEndpoint.mockImplementation(async (_db: unknown, id: string) => endpoint({ botId: id, url: `https://${id}.example.com/hook` }));
    fetchIpPinned.mockImplementation(async (url: string) => {
      if (url.includes('sluggish')) await new Promise((resolve) => setTimeout(resolve, 1_500));
      return ok();
    });
    for (let n = 0; n < 10; n++) enqueueDelivery({ botId: 'sluggish', serverId: SERVER, event: 'message_create', data: { event: 'message_create', n } });
    await vi.advanceTimersByTimeAsync(3_100);
    const before = fetchIpPinned.mock.calls.length;
    enqueueDelivery({ botId: 'brisk', serverId: SERVER, event: 'message_create', data: { event: 'message_create' } });
    await vi.advanceTimersByTimeAsync(20);
    expect(fetchIpPinned.mock.calls.slice(before).some((c) => String(c[0]).includes('brisk'))).toBe(true);
  });
});
