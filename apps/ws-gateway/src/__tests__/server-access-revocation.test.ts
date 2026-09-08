/**
 * LF-SEC-003 + LF-SEC-009 integration tests — REAL sockets against the
 * real gateway server on an ephemeral port.
 *
 *   1. An access-invalidation event re-authorizes the affected live
 *      subscription, removes it and delivers `access_revoked`.
 *   2. An unrelated user's subscription survives the same event.
 *   3. Production handshakes fail CLOSED when the revocation store is
 *      unreachable (1011); a confirmed revocation closes with 1008.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

const authMocks = vi.hoisted(() => ({
  validateGuestFromHeaders: vi.fn(),
  getRevocationStatus: vi.fn<(uid: string, gid: string) => Promise<'active' | 'revoked' | 'unavailable'>>(),
}));
vi.mock('../auth.js', () => authMocks);

const authorizeMocks = vi.hoisted(() => ({
  authorizeTopicSubscribe: vi.fn(),
}));
vi.mock('../authorize.js', () => authorizeMocks);

vi.mock('../db.js', () => ({ getDb: () => ({ __mockDb: true }) }));

const subscriberMocks = vi.hoisted(() => ({
  acquireTopicSubscription: vi.fn(),
}));
vi.mock('../redis-subscriber.js', () => subscriberMocks);

// Capture the invalidation handler so tests can fire events WITHOUT Redis.
const invalidationMocks = vi.hoisted(() => ({
  handler: null as null | ((event: Record<string, unknown>) => void),
}));
vi.mock('../access-invalidation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../access-invalidation.js')>();
  return {
    ...actual,
    initAccessInvalidationListener: (onEvent: (event: Record<string, unknown>) => void) => {
      invalidationMocks.handler = onEvent;
      return () => {
        invalidationMocks.handler = null;
      };
    },
  };
});

import { createGateway } from '../server.js';

const UID = 'user-a';
const GID = 'g_a';

/**
 * Connect and BUFFER every incoming frame from the start — the server
 * sends `hello` immediately on open, before any listener we could
 * attach after `await connect()` would exist (classic EventEmitter
 * miss). nextMessage drains the buffer first.
 */
async function connect(url: string): Promise<WebSocket & { __queue: Record<string, unknown>[] }> {
  const ws = new WebSocket(url, { headers: { cookie: 'lf_guest=whatever' } }) as WebSocket & {
    __queue: Record<string, unknown>[];
  };
  ws.__queue = [];
  ws.on('message', (raw) => {
    ws.__queue.push(JSON.parse(String(raw)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function nextMessage(ws: WebSocket & { __queue?: Record<string, unknown>[] }, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const queue = ws.__queue;
  if (queue && queue.length > 0) {
    return Promise.resolve(queue.shift()!);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    // The collector is the SINGLE source of frames — resolve only by
    // draining the queue, so a waiter-resolved frame never leaves a
    // ghost copy behind for the next read.
    const tryShift = () => {
      const queued = ws.__queue?.shift();
      if (queued) {
        cleanup();
        resolve(queued);
      }
    };
    const onMessage = () => tryShift();
    const onClose = () => {
      cleanup();
      reject(new Error('closed before message'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
    tryShift(); // already-queued frames
  });
}

function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

let baseUrl: string;
let gateway: Awaited<ReturnType<typeof createGateway>>;

/** createGateway + wait for the ephemeral port to be bound. */
async function start(): Promise<string> {
  gateway = createGateway();
  await new Promise<void>((resolve) => gateway.server.once('listening', resolve));
  const addr = gateway.server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}`;
}

beforeEach(() => {
  delete process.env.NODE_ENV;
  process.env.WS_PORT = '0';
  process.env.WS_HOST = '127.0.0.1';
  for (const fn of [
    authMocks.validateGuestFromHeaders,
    authMocks.getRevocationStatus,
    authorizeMocks.authorizeTopicSubscribe,
    subscriberMocks.acquireTopicSubscription,
  ]) {
    fn.mockReset();
  }
  invalidationMocks.handler = null;

  authMocks.validateGuestFromHeaders.mockReturnValue({
    ok: true,
    guest: { uid: UID, gid: GID, name: 'A' },
  });
  authMocks.getRevocationStatus.mockResolvedValue('active');
  authorizeMocks.authorizeTopicSubscribe.mockResolvedValue({
    ok: true,
    kind: 'chat',
    serverId: 'srv-1',
    resourceId: 'ch-1',
  });
  subscriberMocks.acquireTopicSubscription.mockImplementation(
    (_topic: string, handler: (raw: string) => void) => {
      let released = false;
      return {
        release: () => {
          // Real semantics: releasing the Redis subscription STOPS bus
          // delivery — mirror that so post-release __handler calls are
          // provably dead (LF-SEC-003 no-delivery assertion).
          released = true;
        },
        __released: () => released,
        __handler: (raw: string) => {
          if (!released) handler(raw);
        },
      };
    }
  );
});

afterEach(async () => {
  delete process.env.WS_ALLOWED_ORIGINS;
  await gateway?.close();
});

describe('LF-SEC-003 — invalidation removes live subscriptions', () => {
  it('revokes the affected subscription and delivers access_revoked', async () => {
    baseUrl = await start();

    const ws = await connect(baseUrl);
    await nextMessage(ws); // hello

    ws.send(JSON.stringify({ type: 'subscribe', topic: 'chat:srv-1:ch-1' }));
    const subAck = await nextMessage(ws);
    expect(subAck.type).toBe('subscribed');

    // The role is removed → the re-check now denies.
    authorizeMocks.authorizeTopicSubscribe.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
    });
    invalidationMocks.handler!({
      kind: 'user-server-access',
      serverId: 'srv-1',
      userId: UID,
      reason: 'roles_changed',
    });

    const revoked = await nextMessage(ws);
    expect(revoked.type).toBe('access_revoked');
    expect(revoked.topic).toBe('chat:srv-1:ch-1');
    expect(revoked.reason).toBe('roles_changed');

    // The Redis subscription was released.
    const handle = subscriberMocks.acquireTopicSubscription.mock.results[0]!.value as {
      __released: () => boolean;
    };
    expect(handle.__released()).toBe(true);

    // A later bus event must NOT reach the socket anymore.
    handle.__handler(JSON.stringify({ hello: 'nope' }));
    await expect(nextMessage(ws, 300)).rejects.toThrow('message timeout');

    ws.close();
  });

  it('unrelated users keep their subscriptions', async () => {
    baseUrl = await start();

    const ws = await connect(baseUrl);
    await nextMessage(ws); // hello
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'chat:srv-1:ch-1' }));
    await nextMessage(ws); // subscribed

    // A DIFFERENT user lost access — this socket must be untouched.
    invalidationMocks.handler!({
      kind: 'user-server-access',
      serverId: 'srv-1',
      userId: 'someone-else',
      reason: 'kick',
    });

    await expect(nextMessage(ws, 300)).rejects.toThrow('message timeout');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe('LF-SEC-009 — revocation outage policy at the handshake', () => {
  it('production fails CLOSED when the store is unavailable (1011)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WS_ALLOWED_ORIGINS = 'https://ci.example.com';
    authMocks.getRevocationStatus.mockResolvedValue('unavailable');
    const url = await start();

    const ws = new WebSocket(url, {
      headers: { cookie: 'lf_guest=whatever', origin: 'https://ci.example.com' },
    });
    const closed = await nextClose(ws);
    expect(closed.code).toBe(1011);
    expect(closed.reason).toContain('unavailable');
  });

  it('a confirmed revocation closes with 1008 even outside production', async () => {
    authMocks.getRevocationStatus.mockResolvedValue('revoked');
    const url = await start();

    const ws = new WebSocket(url, {
      headers: { cookie: 'lf_guest=whatever' },
    });
    const closed = await nextClose(ws);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain('revoked');
  });

  it('development tolerates an unavailable store (socket opens)', async () => {
    process.env.NODE_ENV = 'development';
    authMocks.getRevocationStatus.mockResolvedValue('unavailable');
    const url = await start();

    const ws = await connect(url);
    const hello = await nextMessage(ws);
    expect(hello.type).toBe('hello');
    ws.close();
  });
});
