/**
 * A malformed frame must never take the gateway down.
 *
 * ws reports a protocol violation (RSV bits, an oversize or unmasked
 * frame, bad UTF-8) by emitting 'error' on the server-side socket. An
 * EventEmitter 'error' with no listener throws, and the process exits —
 * so the browser 'connection' handler attaches its error listener before
 * anything else: before the cookie check that closes an unauthenticated
 * socket, and before the asynchronous revocation check.
 *
 * Real sockets against the real gateway on an ephemeral port; the frame
 * is written by hand on a raw TCP socket, right behind the upgrade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import WebSocket from 'ws';

const authMocks = vi.hoisted(() => ({
  validateGuestFromHeaders: vi.fn(),
  getRevocationStatus: vi.fn<(uid: string, gid: string) => Promise<'active' | 'revoked' | 'unavailable'>>(),
}));
vi.mock('../auth.js', () => authMocks);

vi.mock('../authorize.js', () => ({ authorizeTopicSubscribe: vi.fn() }));
vi.mock('../db.js', () => ({ getDb: () => ({ __mockDb: true }) }));
vi.mock('../redis-subscriber.js', () => ({
  acquireTopicSubscription: vi.fn(() => ({ release: () => undefined })),
  shutdownSubscriber: vi.fn(),
}));
vi.mock('../access-invalidation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../access-invalidation.js')>()),
  initAccessInvalidationListener: () => () => undefined,
}));

import { __ipConnectionCount, createGateway } from '../server.js';

/** FIN + RSV2 + text opcode, masked, zero length: "RSV2 and RSV3 must be clear". */
const RSV2_FRAME = Buffer.from([0x80 | 0x20 | 0x1, 0x80, 1, 2, 3, 4]);

let gateway: ReturnType<typeof createGateway>;
let port: number;
const uncaught = vi.fn();

async function start(): Promise<void> {
  gateway = createGateway();
  await new Promise<void>((resolve) => gateway.server.once('listening', resolve));
  port = (gateway.server.address() as AddressInfo).port;
}

/**
 * Send the upgrade request and `frame` in ONE write (the frame reaches
 * ws together with the handshake) and resolve once the server answered
 * with a close frame — it has parsed the bad frame by then.
 */
async function upgradeThenBadFrame(cookie: string | null, frame: Buffer): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  let received = Buffer.alloc(0);
  const sawClose = new Promise<void>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf('\r\n\r\n');
      // A close frame (opcode 0x8) anywhere after the 101 response.
      if (headerEnd >= 0 && received.subarray(headerEnd + 4).includes(0x88)) resolve();
    });
    socket.on('close', () => resolve());
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const request = [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...(cookie ? [`Cookie: ${cookie}`] : []),
    '',
    '',
  ].join('\r\n');
  socket.write(Buffer.concat([Buffer.from(request), frame]));
  await sawClose;
  // Let ws finish its error path (it emits 'error' after queueing the close).
  await new Promise((r) => setTimeout(r, 20));
  return socket;
}

/** A healthy client still gets served — the process did not die. */
async function expectHello(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { cookie: 'lf_guest=ok' } });
  const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.once('error', reject);
  });
  expect(first.type).toBe('hello');
  ws.close();
}

beforeEach(() => {
  delete process.env.NODE_ENV;
  process.env.WS_PORT = '0';
  process.env.WS_HOST = '127.0.0.1';
  authMocks.validateGuestFromHeaders.mockReset();
  authMocks.getRevocationStatus.mockReset();
  authMocks.validateGuestFromHeaders.mockImplementation((cookie: string | undefined) =>
    cookie ? { ok: true, guest: { uid: 'user-a', gid: 'g_a', name: 'A' } } : { ok: false, reason: 'no_cookie' }
  );
  authMocks.getRevocationStatus.mockResolvedValue('active');
  uncaught.mockReset();
  process.on('uncaughtException', uncaught);
});

afterEach(async () => {
  process.off('uncaughtException', uncaught);
  await gateway?.close();
});

describe('G1 — a malformed frame cannot crash the gateway', () => {
  it('on an unauthenticated socket (closed with 4401 before any listener used to exist)', async () => {
    await start();
    const raw = await upgradeThenBadFrame(null, RSV2_FRAME);
    expect(uncaught).not.toHaveBeenCalled();
    await expectHello();
    raw.destroy();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it('while the revocation check is still pending', async () => {
    let finishRevocation: ((status: 'active') => void) | null = null;
    authMocks.getRevocationStatus.mockImplementationOnce(
      () => new Promise((resolve) => { finishRevocation = resolve; })
    );
    await start();
    const raw = await upgradeThenBadFrame('lf_guest=ok', RSV2_FRAME);
    expect(finishRevocation).not.toBeNull();
    expect(uncaught).not.toHaveBeenCalled();

    // The check answers after the socket already failed: nothing is set up
    // for it, nothing throws, and the slot is not held.
    finishRevocation!('active');
    await new Promise((r) => setTimeout(r, 20));
    raw.destroy();
    await vi.waitFor(() =>
      expect(__ipConnectionCount('127.0.0.1') + __ipConnectionCount('::ffff:127.0.0.1')).toBe(0)
    );

    await expectHello();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it('on an authenticated socket (an oversize frame)', async () => {
    await start();
    // 127 → 64-bit length: 1 MiB, past the 64 KiB maxPayload.
    const header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0, 0x10, 0, 0, 1, 2, 3, 4]);
    const raw = await upgradeThenBadFrame('lf_guest=ok', header);
    expect(uncaught).not.toHaveBeenCalled();
    await expectHello();
    raw.destroy();
  });
});
