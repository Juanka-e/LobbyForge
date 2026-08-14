/**
 * WebSocket gateway server.
 *
 * Listens on a configurable port (default 3001) for upgrade requests.
 * Validates the guest cookie on upgrade, opens a connection-scoped
 * subscription manager, and serves `subscribe` / `unsubscribe`
 * messages routed through the Redis subscriber pool.
 *
 * Transport is intentionally minimal: JSON text frames in both
 * directions. The browser uses `apps/web/lib/realtime-client.ts` which
 * handles reconnect / backoff.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import * as http from 'node:http';
import { validateGuestFromHeaders, type ResolvedGuest } from './auth.js';
import { authorizeTopicSubscribe } from './authorize.js';
import { ConnectionSubscriptions } from './subscriptions.js';
import { ClientMessageSchema, type ServerMessage } from './protocol.js';
import { getDb } from './db.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const SUBSCRIBE_RATE_LIMIT_WINDOW_MS = 60_000;
const SUBSCRIBE_RATE_LIMIT_MAX = 30;

interface ConnectionState {
  guest: ResolvedGuest;
  subs: ConnectionSubscriptions;
  subscribeTimestamps: number[];
  alive: boolean;
}

function getEnvPort(): number {
  const raw = process.env.WS_PORT;
  if (!raw) return 3001;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid WS_PORT: ${raw}`);
  }
  return n;
}

function getEnvHost(): string {
  return process.env.WS_HOST ?? '0.0.0.0';
}

function configuredOrigins(): Set<string> {
  const origins = new Set<string>();
  const rawList = process.env.WS_ALLOWED_ORIGINS;
  for (const raw of rawList?.split(',') ?? []) {
    const origin = normalizeOrigin(raw);
    if (origin) origins.add(origin);
  }
  for (const raw of [process.env.LOBBYFORGE_APP_ORIGIN, process.env.NEXT_PUBLIC_BASE_URL]) {
    const origin = normalizeOrigin(raw);
    if (origin) origins.add(origin);
  }
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
  }
  return origins;
}

function normalizeOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function isAllowedWsOrigin(originHeader: string | undefined): boolean {
  const origin = normalizeOrigin(originHeader);
  if (!origin) {
    return process.env.NODE_ENV !== 'production';
  }
  return configuredOrigins().has(origin);
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch (err) {
    console.warn(`[ws-gateway] send failed: ${(err as Error).message}`);
  }
}

function recordSubscribe(state: ConnectionState): boolean {
  const now = Date.now();
  const cutoff = now - SUBSCRIBE_RATE_LIMIT_WINDOW_MS;
  while (state.subscribeTimestamps.length && state.subscribeTimestamps[0] < cutoff) {
    state.subscribeTimestamps.shift();
  }
  if (state.subscribeTimestamps.length >= SUBSCRIBE_RATE_LIMIT_MAX) {
    return false;
  }
  state.subscribeTimestamps.push(now);
  return true;
}

const MAX_CONNECTIONS_PER_IP = parseInt(process.env.WS_MAX_CONN_PER_IP || '10', 10);
const ipConnectionCounts = new Map<string, number>();

export function createGateway(): { wss: WebSocketServer; close: () => Promise<void> } {
  // Create an HTTP server first — it serves the /health endpoint for
  // Docker healthchecks (the WS-only server returns 426 for plain HTTP).
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'ws-gateway' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({
    server: httpServer, // Share the HTTP server — WS upgrades + /health on one port.
    perMessageDeflate: false,
    maxPayload: 64 * 1024, // 64 KB — reject oversized messages
    verifyClient: (info: { origin: string; secure: boolean; req: import('http').IncomingMessage }) => {
      if (!isAllowedWsOrigin(info.origin)) return false;
      // Per-IP connection cap — prevents DoS via unauthenticated WS floods.
      // Use x-forwarded-for only when behind a trusted proxy (production Nginx).
      const ip = process.env.NODE_ENV === 'production'
        ? (info.req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
          || info.req.socket.remoteAddress
          || 'unknown')
        : (info.req.socket.remoteAddress || 'unknown');
      const count = ipConnectionCounts.get(ip) ?? 0;
      if (count >= MAX_CONNECTIONS_PER_IP) {
        console.warn(`[ws-gateway] rejecting connection from ${ip}: ${count} active (max ${MAX_CONNECTIONS_PER_IP})`);
        return false;
      }
      ipConnectionCounts.set(ip, count + 1);
      return true;
    },
  });

  httpServer.listen(getEnvPort(), getEnvHost());

  const connections = new WeakMap<WebSocket, ConnectionState>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const state = connections.get(client);
      if (!state) continue;
      if (!state.alive) {
        try {
          client.terminate();
        } catch {
          /* swallow */
        }
        continue;
      }
      state.alive = false;
      try {
        client.ping();
      } catch {
        /* swallow */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('connection', (socket, req) => {
    const connectionIp = process.env.NODE_ENV === 'production'
      ? (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
        || req.socket.remoteAddress
        || 'unknown')
      : (req.socket.remoteAddress || 'unknown');

    // Single-fire cleanup — prevents counter leak/double-decrement when
    // both 'close' and 'error' fire on the same socket.
    let ipReleased = false;
    const releaseIpSlot = () => {
      if (ipReleased) return;
      ipReleased = true;
      const count = ipConnectionCounts.get(connectionIp) ?? 0;
      if (count <= 1) {
        ipConnectionCounts.delete(connectionIp);
      } else {
        ipConnectionCounts.set(connectionIp, count - 1);
      }
    };

    const cookieHeader = req.headers.cookie;
    const auth = validateGuestFromHeaders(cookieHeader);
    if (!auth.ok) {
      send(socket, {
        type: 'error',
        code: 'forbidden',
        message: 'Authentication required',
      });
      // Release the IP slot even on auth failure.
      releaseIpSlot();
      socket.close(4401, 'unauthenticated');
      return;
    }

    const state: ConnectionState = {
      guest: auth.guest,
      subs: new ConnectionSubscriptions(),
      subscribeTimestamps: [],
      alive: true,
    };
    connections.set(socket, state);

    send(socket, {
      type: 'hello',
      ok: true,
      uid: auth.guest.uid,
      at: new Date().toISOString(),
    });

    socket.on('pong', () => {
      state.alive = true;
    });

    socket.on('message', async (data) => {
      let parsed: unknown;
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        parsed = JSON.parse(text);
      } catch {
        send(socket, {
          type: 'error',
          code: 'bad_message',
          message: 'Invalid JSON',
        });
        return;
      }

      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        send(socket, {
          type: 'error',
          code: 'bad_message',
          message: result.error.message,
        });
        return;
      }

      const msg = result.data;
      if (msg.type === 'subscribe') {
        if (!recordSubscribe(state)) {
          send(socket, {
            type: 'error',
            topic: msg.topic,
            code: 'rate_limited',
            message: 'Too many subscribe requests',
          });
          return;
        }
        if (state.subs.has(msg.topic)) {
          send(socket, {
            type: 'subscribed',
            topic: msg.topic,
            at: new Date().toISOString(),
          });
          return;
        }
        try {
          const authz = await authorizeTopicSubscribe(getDb(), state.guest.uid, msg.topic);
          if (!authz.ok) {
            send(socket, {
              type: 'error',
              topic: msg.topic,
              code: authz.reason === 'forbidden' ? 'forbidden' : 'unknown_topic',
              message: authz.reason,
            });
            return;
          }
          state.subs.add(msg.topic, (raw) => {
            try {
              const data = JSON.parse(raw);
              send(socket, {
                type: 'event',
                topic: msg.topic,
                data,
                at: new Date().toISOString(),
              });
            } catch {
              /* drop malformed payload — the publisher side is responsible for shape */
            }
          });
          send(socket, {
            type: 'subscribed',
            topic: msg.topic,
            at: new Date().toISOString(),
          });
        } catch (err) {
          send(socket, {
            type: 'error',
            topic: msg.topic,
            code: 'unknown_topic',
            message: (err as Error).message,
          });
        }
      } else {
        if (state.subs.has(msg.topic)) {
          state.subs.remove(msg.topic);
        }
        send(socket, {
          type: 'unsubscribed',
          topic: msg.topic,
          at: new Date().toISOString(),
        });
      }
    });

    socket.once('close', () => {
      state.subs.closeAll();
      releaseIpSlot();
    });
    socket.once('error', () => {
      state.subs.closeAll();
      releaseIpSlot();
    });
  });

  return {
    wss,
    close: async () => {
      clearInterval(heartbeat);
      for (const client of wss.clients) {
        try {
          client.close(1001, 'shutting down');
        } catch {
          /* swallow */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
