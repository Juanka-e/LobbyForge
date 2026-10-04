/**
 * ADR-007 on the WebSocket path: the gateway projects official plugins
 * itself (core rules) and asks the web app for every other plugin id —
 * a marketplace plugin projects with its own projectState in the plugin
 * worker, which only web can reach. If web cannot answer, the subscriber
 * gets the event WITHOUT state, never the unprojected row.
 *
 * Real sockets against the real gateway; Redis, the DB and the web call
 * are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { ACTIVITY_PROJECTION_PURPOSE, INTERNAL_SIGNATURE_HEADER, verifyInternalRequest } from '@lobbyforge/core';

const authMocks = vi.hoisted(() => ({
  validateGuestFromHeaders: vi.fn(),
  getRevocationStatus: vi.fn(),
}));
vi.mock('../auth.js', () => authMocks);

const authorizeMocks = vi.hoisted(() => ({ authorizeTopicSubscribe: vi.fn() }));
vi.mock('../authorize.js', () => authorizeMocks);

vi.mock('../db.js', () => ({ getDb: () => ({ __mockDb: true }) }));

const dbMocks = vi.hoisted(() => ({
  getGameSessionById: vi.fn(),
  getPluginInstall: vi.fn(async () => null),
}));
vi.mock('@lobbyforge/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobbyforge/db')>()),
  ...dbMocks,
}));

/** Topic → the bus handler the gateway registered. */
const bus = vi.hoisted(() => new Map<string, (raw: string) => void>());
vi.mock('../redis-subscriber.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../redis-subscriber.js')>()),
  acquireTopicSubscription: (topic: string, handler: (raw: string) => void) => {
    bus.set(topic, handler);
    return { release: () => bus.delete(topic) };
  },
  shutdownSubscriber: vi.fn(),
}));

vi.mock('../access-invalidation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../access-invalidation.js')>()),
  initAccessInvalidationListener: () => () => undefined,
}));

const hostProjection = vi.hoisted(() => ({ fetchHostProjection: vi.fn() }));
vi.mock('../host-projection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host-projection.js')>()),
  fetchHostProjection: hostProjection.fetchHostProjection,
}));

import { createGateway } from '../server.js';
// The module is mocked for the gateway above; the unit tests below use the real one.
const { fetchHostProjection: realFetchHostProjection, internalWebUrl } =
  await vi.importActual<typeof import('../host-projection.js')>('../host-projection.js');

const UID = 'viewer-1';
const TOPIC = 'activity-state:srv-1:sess-1';

let gateway: ReturnType<typeof createGateway>;

async function start(): Promise<string> {
  gateway = createGateway();
  await new Promise<void>((resolve) => gateway.server.once('listening', resolve));
  return `ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
}

async function connectAndSubscribe(url: string): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  const ws = new WebSocket(url, { headers: { cookie: 'lf_guest=x' } });
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error('message timeout')), 3000);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  expect((await next()).type).toBe('hello');
  ws.send(JSON.stringify({ type: 'subscribe', topic: TOPIC }));
  expect((await next()).type).toBe('subscribed');
  return { ws, next };
}

function row(pluginId: string, state: Record<string, unknown>) {
  return { id: 'sess-1', serverId: 'srv-1', channelId: 'ch-1', pluginId, status: 'running', state };
}

beforeEach(() => {
  delete process.env.NODE_ENV;
  process.env.WS_PORT = '0';
  process.env.WS_HOST = '127.0.0.1';
  bus.clear();
  authMocks.validateGuestFromHeaders.mockReturnValue({ ok: true, guest: { uid: UID, gid: 'g_1', name: 'V' } });
  authMocks.getRevocationStatus.mockResolvedValue('active');
  authorizeMocks.authorizeTopicSubscribe.mockResolvedValue({
    ok: true,
    kind: 'activity-state',
    serverId: 'srv-1',
    resourceId: 'sess-1',
    channelId: 'ch-1',
  });
  hostProjection.fetchHostProjection.mockReset();
  dbMocks.getGameSessionById.mockReset();
});

afterEach(async () => {
  await gateway?.close();
});

describe('gateway activity projection routing (ADR-007)', () => {
  it('an official plugin is projected locally by core (Hushle: no deck)', async () => {
    dbMocks.getGameSessionById.mockResolvedValue(row('hushle', { phase: 'playing', deck: [{ id: 'c1' }], usedCardIds: [] }));
    const { ws, next } = await connectAndSubscribe(await start());
    bus.get(TOPIC)!(JSON.stringify({ status: 'running', revision: 4 }));
    const event = await next();
    const state = (event.data as { state: Record<string, unknown> }).state;
    expect(state.deck).toBeUndefined();
    expect(state.deckSize).toBe(1);
    expect(hostProjection.fetchHostProjection).not.toHaveBeenCalled();
    ws.close();
  });

  it('a marketplace plugin is projected by the web app, for this viewer', async () => {
    dbMocks.getGameSessionById.mockResolvedValue(row('sandbox-buzzer', { phase: 'open', buzzes: [{ playerId: 'u-alice', at: 1 }] }));
    hostProjection.fetchHostProjection.mockResolvedValue({ state: { phase: 'open', buzzCount: 1, buzzes: null }, status: 'running', revision: 5 });
    const { ws, next } = await connectAndSubscribe(await start());
    bus.get(TOPIC)!(JSON.stringify({ status: 'running', revision: 5 }));
    const event = await next();
    expect(hostProjection.fetchHostProjection).toHaveBeenCalledWith({ serverId: 'srv-1', sessionId: 'sess-1', viewerUserId: UID });
    expect((event.data as { state: unknown }).state).toEqual({ phase: 'open', buzzCount: 1, buzzes: null });
    expect(JSON.stringify(event)).not.toContain('u-alice');
    ws.close();
  });

  it('if the web app cannot project, the event carries NO state (never the raw row)', async () => {
    dbMocks.getGameSessionById.mockResolvedValue(row('sandbox-buzzer', { phase: 'open', buzzes: [{ playerId: 'u-alice', at: 1 }] }));
    hostProjection.fetchHostProjection.mockRejectedValue(new Error('web projection answered HTTP 502'));
    const { ws, next } = await connectAndSubscribe(await start());
    bus.get(TOPIC)!(JSON.stringify({ status: 'running', revision: 6 }));
    const event = await next();
    expect(event.type).toBe('event');
    expect((event.data as Record<string, unknown>).state).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('u-alice');
    ws.close();
  });
});

describe('fetchHostProjection', () => {
  const SECRET = 'k'.repeat(40);

  it('posts a signed request for exactly this viewer to the internal endpoint', async () => {
    process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ state: { a: 1 }, status: 'running', revision: 3 }), { status: 200 });
    }) as typeof fetch;
    const result = await realFetchHostProjection({ serverId: 's', sessionId: 'x', viewerUserId: 'v' }, fakeFetch);
    expect(result).toEqual({ state: { a: 1 }, status: 'running', revision: 3 });
    expect(calls[0]!.url).toBe('http://web:3000/api/internal/activity-projection');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(
      verifyInternalRequest(SECRET, ACTIVITY_PROJECTION_PURPOSE, headers[INTERNAL_SIGNATURE_HEADER], String(calls[0]!.init.body))
    ).toBe(true);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ serverId: 's', sessionId: 'x', viewerUserId: 'v' });
  });

  it('throws on a refusal or an answer without state', async () => {
    process.env.LOBBYFORGE_SESSION_SECRET = SECRET;
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(realFetchHostProjection({ serverId: 's', sessionId: 'x', viewerUserId: 'v' }, reply(403, { error: 'Forbidden' }))).rejects.toThrow(/403/);
    await expect(realFetchHostProjection({ serverId: 's', sessionId: 'x', viewerUserId: 'v' }, reply(200, { status: 'running' }))).rejects.toThrow(/without a state/);
  });

  it('LOBBYFORGE_INTERNAL_WEB_URL overrides the compose default', () => {
    expect(internalWebUrl({})).toBe('http://web:3000');
    expect(internalWebUrl({ LOBBYFORGE_INTERNAL_WEB_URL: 'http://127.0.0.1:19520/' })).toBe('http://127.0.0.1:19520');
  });
});
