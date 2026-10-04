/**
 * `LobbyForgeBot` (BOT_API_V2 §6): REST helpers against a fake fetch, the
 * event stream against a fake WebSocket — identify, typed dispatch,
 * interaction answers, reconnect with backoff + jitter, fatal close codes,
 * the heartbeat watchdog and close().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BotApiError,
  BotAuthError,
  BotForbiddenError,
  BotNetworkError,
  BotValidationError,
  LobbyForgeBot,
  type LobbyForgeBotOptions,
  type WebSocketLike,
} from '../index.js';

const BOT_ID = '20000000-0000-4000-8000-000000000001';
const TOKEN = `lfb_${BOT_ID.replace(/-/g, '')}_${'A'.repeat(43)}`;
const SERVER = '10000000-0000-4000-8000-000000000001';
const CH1 = '30000000-0000-4000-8000-000000000001';
const USER = '50000000-0000-4000-8000-000000000001';
const INTERACTION = '60000000-0000-4000-8000-000000000001';
const BASE = 'https://chat.example.com';
const GATEWAY = 'wss://chat.example.com/ws/bot';

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  private fire(type: string, event: Parameters<Listener>[0]): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  // server side
  open(): void {
    this.readyState = 1;
    this.fire('open', {});
  }
  frame(payload: unknown): void {
    this.fire('message', { data: JSON.stringify(payload) });
  }
  event(data: Record<string, unknown>): void {
    this.frame({ type: 'event', topic: 'bot', data, at: new Date().toISOString() });
  }
  ready(channels = [{ id: CH1, name: 'general' }]): void {
    this.frame({ type: 'hello', ok: true, bot: { id: BOT_ID, serverId: SERVER }, at: 'now' });
    this.event({
      event: 'ready',
      bot: { id: BOT_ID, name: 'Roller', serverId: SERVER, permissions: ['receive_events'] },
      channels,
    });
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.fire('close', { code, reason });
  }
}

/** A Response-like object (microtask-only, works under fake timers). */
function reply(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

type Route = (url: string, init: RequestInit) => Response | undefined;

function fakeFetch(route: Route = () => undefined) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const answered = route(url, init ?? {});
    if (answered) return answered;
    if (url.endsWith('/api/bot/v2/gateway')) return reply(200, { url: GATEWAY });
    return reply(200, {});
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function makeBot(overrides: Partial<LobbyForgeBotOptions> = {}, fetch = fakeFetch()) {
  const bot = new LobbyForgeBot({
    baseUrl: BASE,
    token: TOKEN,
    fetch,
    WebSocket: FakeWebSocket,
    random: () => 0.5,
    ...overrides,
  });
  return { bot, fetch };
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('no socket opened');
  return socket;
}

/** connect() until `ready`. */
async function connected(overrides: Partial<LobbyForgeBotOptions> = {}, fetch = fakeFetch()) {
  const made = makeBot(overrides, fetch);
  const promise = made.bot.connect();
  await settle();
  const socket = lastSocket();
  socket.open();
  socket.ready();
  await promise;
  return { ...made, socket };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connect', () => {
  it('discovers the gateway, identifies with the token (never in the URL) and resolves on ready', async () => {
    const { bot, fetch } = makeBot();
    const onReady = vi.fn();
    bot.on('ready', onReady);
    const promise = bot.connect();
    await settle();
    expect(String(fetch.mock.calls[0]![0])).toBe(`${BASE}/api/bot/v2/gateway`);
    const socket = lastSocket();
    expect(socket.url).toBe(GATEWAY);
    expect(socket.url).not.toContain(TOKEN);
    socket.open();
    expect(socket.sent).toEqual([{ type: 'identify', token: TOKEN }]);
    socket.ready();
    await expect(promise).resolves.toBeUndefined();
    expect(onReady).toHaveBeenCalledWith({
      bot: { id: BOT_ID, name: 'Roller', serverId: SERVER, permissions: ['receive_events'] },
      channels: [{ id: CH1, name: 'general' }],
    });
    expect(bot.ready?.channels).toEqual([{ id: CH1, name: 'general' }]);
    bot.close();
  });

  it('uses gatewayUrl when given (http(s) becomes ws(s)) and never downgrades an https instance', async () => {
    const { bot, fetch } = makeBot({ gatewayUrl: 'https://rt.example.com/ws/bot' });
    bot.connect().catch(() => undefined); // close() below rejects it
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(lastSocket().url).toBe('wss://rt.example.com/ws/bot');
    bot.close();

    const insecure = makeBot({ gatewayUrl: 'ws://rt.example.com/ws/bot' }).bot;
    await expect(insecure.connect()).rejects.toBeInstanceOf(BotValidationError);
  });

  it('falls back to /ws/bot when the instance has no discovery route', async () => {
    const fetch = fakeFetch((url) => (url.endsWith('/gateway') ? reply(404, { error: 'Not found', code: 'not_found' }) : undefined));
    const { bot } = makeBot({}, fetch);
    bot.connect().catch(() => undefined); // close() below rejects it
    await settle();
    expect(lastSocket().url).toBe(GATEWAY);
    bot.close();
  });

  it('rejects at once when discovery says the token is bad', async () => {
    const fetch = fakeFetch((url) => (url.endsWith('/gateway') ? reply(401, { error: 'Invalid bot token', code: 'unauthorized' }) : undefined));
    const { bot } = makeBot({}, fetch);
    await expect(bot.connect()).rejects.toBeInstanceOf(BotAuthError);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('events', () => {
  it('dispatches typed events and a raw copy of each', async () => {
    const { bot, socket } = await connected();
    const seen: Array<[string, unknown]> = [];
    for (const name of ['message', 'message_update', 'message_delete', 'member_join', 'member_leave', 'channel_access_changed'] as const) {
      bot.on(name, (payload) => {
        seen.push([name, payload]);
      });
    }
    const raw = vi.fn();
    bot.on('raw', raw);
    const message = {
      id: 'm1',
      channelId: CH1,
      content: 'hi',
      author: { id: USER, displayName: 'Ayşe' },
      createdAt: '2026-10-03T12:00:00.000Z',
      editedAt: null,
      replyToId: null,
    };
    socket.event({ event: 'message_create', message });
    socket.event({ event: 'message_update', message: { ...message, content: 'edited' } });
    socket.event({ event: 'message_delete', id: 'm1', channelId: CH1 });
    socket.event({ event: 'member_join', member: { id: USER, displayName: 'Ayşe' } });
    socket.event({ event: 'member_leave', member: { id: USER, displayName: 'Ayşe' }, reason: 'kick' });
    socket.event({ event: 'channel_access_changed', channels: [] });
    socket.event({ event: 'something_new', x: 1 });
    expect(seen).toEqual([
      ['message', message],
      ['message_update', { ...message, content: 'edited' }],
      ['message_delete', { id: 'm1', channelId: CH1 }],
      ['member_join', { id: USER, displayName: 'Ayşe' }],
      ['member_leave', { id: USER, displayName: 'Ayşe', reason: 'kick' }],
      ['channel_access_changed', []],
    ]);
    expect(raw).toHaveBeenCalledTimes(7);
    expect(bot.ready?.channels).toEqual([]);
    bot.close();
  });

  it('interactions come with reply() and followup() bound to their id', async () => {
    const fetch = fakeFetch((url) => (url.includes('/interactions/') ? reply(200, { ok: true }) : undefined));
    const { bot, socket } = await connected({}, fetch);
    const interaction = {
      id: INTERACTION,
      commandName: 'roll',
      options: { sides: 20 },
      channelId: CH1,
      user: { id: USER, displayName: 'Ayşe' },
      expiresAt: '2026-10-03T12:15:00.000Z',
    };
    const received = new Promise<void>((resolve) => {
      bot.on('interaction', async (i) => {
        expect(i).toMatchObject(interaction);
        await i.reply('🎲 17', { ephemeral: true });
        await i.followup('again');
        resolve();
      });
    });
    socket.event({ event: 'interaction_create', interaction });
    await received;
    const calls = fetch.mock.calls.filter(([url]) => String(url).includes('/interactions/'));
    expect(String(calls[0]![0])).toBe(`${BASE}/api/bot/v2/interactions/${INTERACTION}/respond`);
    expect(calls[0]![1]!.method).toBe('POST');
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({ content: '🎲 17', ephemeral: true });
    expect(String(calls[1]![0])).toBe(`${BASE}/api/bot/v2/interactions/${INTERACTION}/followup`);
    expect(JSON.parse(String(calls[1]![1]!.body))).toEqual({ content: 'again', ephemeral: false });
    bot.close();
  });

  it('a throwing or rejecting listener becomes an error event; the others still run', async () => {
    const { bot, socket } = await connected();
    const errors: Error[] = [];
    bot.on('error', (e) => {
      errors.push(e);
    });
    const after = vi.fn();
    bot.on('member_join', () => {
      throw new Error('sync boom');
    });
    bot.on('member_join', async () => {
      throw new Error('async boom');
    });
    bot.on('member_join', after);
    socket.event({ event: 'member_join', member: { id: USER, displayName: 'A' } });
    await settle();
    expect(after).toHaveBeenCalledTimes(1);
    expect(errors.map((e) => e.message).sort()).toEqual(['async boom', 'sync boom']);
    bot.close();
  });

  it('on() returns an unsubscribe function', async () => {
    const { bot, socket } = await connected();
    const listener = vi.fn();
    const off = bot.on('member_join', listener);
    off();
    socket.event({ event: 'member_join', member: { id: USER, displayName: 'A' } });
    expect(listener).not.toHaveBeenCalled();
    bot.close();
  });
});

describe('reconnect', () => {
  it('backs off exponentially with jitter, re-identifies, and resets after ready', async () => {
    const { bot, socket } = await connected({ reconnect: { initialDelayMs: 1000, maxDelayMs: 8000 } });
    const delays: Array<number | null> = [];
    bot.on('disconnect', (info) => {
      delays.push(info.delayMs);
    });
    socket.serverClose(1006);
    // random() = 0.5 → ceiling * 0.75: 750, 1500, 3000, 6000, then capped at 8000 → 6000.
    for (const expected of [750, 1500, 3000, 6000, 6000]) {
      expect(delays.at(-1)).toBe(expected);
      const before = FakeWebSocket.instances.length;
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(FakeWebSocket.instances).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(FakeWebSocket.instances).toHaveLength(before + 1);
      const next = lastSocket();
      next.open();
      expect(next.sent).toEqual([{ type: 'identify', token: TOKEN }]);
      if (expected === 6000 && delays.length === 5) {
        next.ready();
        next.serverClose(1001, 'shutting down');
        expect(delays.at(-1)).toBe(750); // attempt counter reset by ready
        break;
      }
      next.serverClose(1006);
    }
    bot.close();
  });

  it('waits at least 10 s after a 4029', async () => {
    const { bot, socket } = await connected();
    const info = new Promise<number | null>((resolve) => bot.on('disconnect', (d) => resolve(d.delayMs)));
    socket.serverClose(4029, 'rate_limited');
    expect(await info).toBeGreaterThanOrEqual(10_000);
    bot.close();
  });

  it.each([
    [4001, BotAuthError, { type: 'error', code: 'unauthorized', message: 'The bot token was revoked or rotated' }],
    [4003, BotForbiddenError, { type: 'error', code: 'missing_permission', message: 'no', permission: 'receive_events' }],
    [4009, BotApiError, { type: 'error', code: 'replaced', message: 'Replaced by a newer connection for this bot' }],
  ])('a fatal %i stops for good with a typed error', async (code, ErrorClass, frame) => {
    const { bot } = makeBot();
    const promise = bot.connect();
    await settle();
    const socket = lastSocket();
    socket.open();
    socket.frame(frame);
    socket.serverClose(code, String(frame.code));
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect((error as Error).message).toBe(frame.message);
    if (code === 4003) expect((error as BotForbiddenError).permission).toBe('receive_events');
    if (code === 4009) expect((error as BotApiError).code).toBe('replaced');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a fatal close after ready surfaces on the error event', async () => {
    const { bot, socket } = await connected();
    const error = new Promise<Error>((resolve) => bot.on('error', resolve));
    socket.serverClose(4009, 'replaced');
    expect(await error).toBeInstanceOf(BotApiError);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('gives up after maxAttempts, and never retries with reconnect: false', async () => {
    const { bot } = makeBot({ reconnect: { maxAttempts: 2, initialDelayMs: 100 } });
    const promise = bot.connect();
    await settle();
    lastSocket().serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    lastSocket().serverClose(1006);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    lastSocket().serverClose(1006);
    await expect(promise).rejects.toBeInstanceOf(BotNetworkError);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances = [];
    const once = makeBot({ reconnect: false }).bot;
    const p2 = once.connect();
    await settle();
    lastSocket().serverClose(1006);
    await expect(p2).rejects.toBeInstanceOf(BotNetworkError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('heartbeat watchdog', () => {
  it('reconnects when the stream goes silent, but not while heartbeats arrive', async () => {
    const { bot, socket } = await connected({ heartbeatTimeoutMs: 75_000 });
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      socket.frame({ type: 'heartbeat', at: 'now' });
    }
    expect(socket.closedWith).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const disconnect = new Promise<number>((resolve) => bot.on('disconnect', (d) => resolve(d.code)));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'heartbeat timeout' });
    expect(await disconnect).toBe(4000);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(2);
    bot.close();
  });
});

describe('close', () => {
  it('closes with 1000, stops reconnecting and rejects a pending connect', async () => {
    const { bot, socket } = await connected();
    const info = new Promise((resolve) => bot.on('disconnect', resolve));
    bot.close();
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'client closing' });
    expect(await info).toMatchObject({ willReconnect: false });
    socket.serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const pending = makeBot().bot;
    const promise = pending.connect();
    pending.close();
    await expect(promise).rejects.toBeInstanceOf(BotNetworkError);
  });

  it('connect() during a scheduled reconnect waits instead of opening a second socket', async () => {
    const { bot, socket } = await connected();
    socket.serverClose(1006);
    const again = bot.connect();
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(2);
    lastSocket().open();
    lastSocket().ready();
    await expect(again).resolves.toBeUndefined();
    bot.close();
  });
});

describe('REST helpers (v2)', () => {
  function restBot(route: Route) {
    const fetch = fakeFetch(route);
    const { bot } = makeBot({}, fetch);
    const call = (i = -1) => {
      const [url, init] = fetch.mock.calls.at(i) as [string, RequestInit];
      return {
        url: String(url),
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
    };
    return { bot, fetch, call };
  }

  it('commands: set (bulk overwrite), get, delete', async () => {
    const commands = [
      { name: 'roll', description: 'Roll dice', options: [{ name: 'sides', type: 'integer' as const, min: 2, max: 1000 }] },
    ];
    const { bot, call } = restBot((url, init) =>
      url.endsWith('/commands') ? reply(200, { commands: init.method === 'PUT' ? commands : [] }) : url.includes('/commands/') ? reply(204) : undefined
    );
    await expect(bot.commands.set(commands)).resolves.toEqual(commands);
    expect(call()).toMatchObject({ url: `${BASE}/api/bot/v2/commands`, method: 'PUT', body: { commands } });
    expect(call().headers.Authorization).toBe(`Bot ${TOKEN}`);
    await expect(bot.commands.get()).resolves.toEqual([]);
    expect(call()).toMatchObject({ url: `${BASE}/api/bot/v2/commands`, method: 'GET' });
    await expect(bot.commands.delete('roll')).resolves.toBeUndefined();
    expect(call()).toMatchObject({ url: `${BASE}/api/bot/v2/commands/roll`, method: 'DELETE' });
  });

  it('validates commands before sending', async () => {
    const { bot, fetch } = restBot(() => undefined);
    await expect(bot.commands.set([{ name: 'Roll!', description: 'x' }])).rejects.toBeInstanceOf(BotValidationError);
    await expect(bot.commands.set([{ name: 'a', description: '' }])).rejects.toBeInstanceOf(BotValidationError);
    await expect(
      bot.commands.set([
        { name: 'a', description: 'x' },
        { name: 'a', description: 'y' },
      ])
    ).rejects.toBeInstanceOf(BotValidationError);
    await expect(
      bot.commands.set(Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, description: 'x' })))
    ).rejects.toBeInstanceOf(BotValidationError);
    await expect(bot.commands.delete('../admin')).rejects.toBeInstanceOf(BotValidationError);
    await expect(bot.interactions.respond('not-a-uuid', 'hi')).rejects.toBeInstanceOf(BotValidationError);
    await expect(bot.interactions.respond(INTERACTION, '  ')).rejects.toBeInstanceOf(BotValidationError);
    await expect(bot.members.get('nope')).rejects.toBeInstanceOf(BotValidationError);
    await expect(bot.eventEndpoint.set('http://bot.example.com/hook')).rejects.toBeInstanceOf(BotValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('members, event endpoint, gateway and the v2 message routes', async () => {
    const member = { id: USER, displayName: 'Ayşe', roles: [], joinedAt: '2026-09-01T00:00:00.000Z' };
    const { bot, call } = restBot((url, init) => {
      if (url.includes('/members/')) return reply(200, { member });
      if (url.endsWith('/event-endpoint')) return init.method === 'PUT' ? reply(200, { endpoint: { url: 'x' }, secret: 'whsec_x' }) : reply(204);
      if (url.endsWith('/me')) return reply(200, { bot: { id: BOT_ID, name: 'Roller' } });
      return undefined;
    });
    await expect(bot.members.get(USER)).resolves.toEqual(member);
    expect(call().url).toBe(`${BASE}/api/bot/v2/members/${USER}`);
    await expect(bot.eventEndpoint.set('https://bot.example.com/hook', { events: ['interaction_create'] })).resolves.toMatchObject({
      secret: 'whsec_x',
    });
    expect(call()).toMatchObject({
      url: `${BASE}/api/bot/v2/event-endpoint`,
      method: 'PUT',
      body: { url: 'https://bot.example.com/hook', events: ['interaction_create'] },
    });
    await expect(bot.eventEndpoint.get()).resolves.toBeNull(); // the fake answers 204 to non-PUT
    await expect(bot.eventEndpoint.remove()).resolves.toBeUndefined();
    expect(call()).toMatchObject({ url: `${BASE}/api/bot/v2/event-endpoint`, method: 'DELETE' });
    await expect(bot.getGatewayUrl()).resolves.toBe(GATEWAY);
    await expect(bot.getMe()).resolves.toMatchObject({ id: BOT_ID });
    expect(call().url).toBe(`${BASE}/api/bot/v2/me`);
  });

  it('maps errors to the typed classes', async () => {
    const { bot } = restBot(() => reply(403, { error: 'Missing permission', code: 'missing_permission', permission: 'slash_commands' }));
    const error = (await bot.commands.get().catch((e: unknown) => e)) as BotForbiddenError;
    expect(error).toBeInstanceOf(BotForbiddenError);
    expect(error.permission).toBe('slash_commands');
  });
});
