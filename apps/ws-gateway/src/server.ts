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
import { getRevocationStatus, validateGuestFromHeaders, type ResolvedGuest } from './auth.js';
import { authorizeTopicSubscribe } from './authorize.js';
import { ConnectionSubscriptions } from './subscriptions.js';
import { ClientMessageSchema, type ServerMessage } from './protocol.js';
import { getDb } from './db.js';
import { initAccessInvalidationListener, topicMatchesInvalidation } from './access-invalidation.js';

import { projectActivityState } from '@lobbyforge/core';
import { getGameSessionById, getPluginInstall } from '@lobbyforge/db';

const HEARTBEAT_INTERVAL_MS = 30_000;
const SUBSCRIBE_RATE_LIMIT_WINDOW_MS = 60_000;
const SUBSCRIBE_RATE_LIMIT_MAX = 30;

interface ConnectionState {
  guest: ResolvedGuest;
  subs: ConnectionSubscriptions;
  subscribeTimestamps: number[];
  alive: boolean;
  /** LF-SEC-009: when revocation checks first became unavailable on
   * this socket (null = healthy). Past the grace window the socket
   * closes — realtime never fails open indefinitely. */
  revocationUnavailableSince: number | null;
}

function getEnvPort(): number {
  const raw = process.env.WS_PORT;
  if (!raw) return 3001;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) { // 0 = ephemeral (tests)
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

/**
 * SEC-001: load the session, run the CANONICAL projector for THIS
 * viewer, and forward the projected state. The bus payload itself
 * carries no state — this is the only place a WS subscriber gets one.
 */
async function forwardProjectedActivity(
  socket: WebSocket,
  topic: string,
  authz: { serverId: string; resourceId: string },
  data: { status?: string; revision?: number; publicSummary?: Record<string, unknown> },
  viewerUserId: string
): Promise<void> {
  try {
    const row = await getGameSessionById(getDb() as never, authz.resourceId);
    if (!row || row.serverId !== authz.serverId) {
      // Session vanished or belongs elsewhere — the subscriber just
      // gets the lean event (no state).
      send(socket, { type: 'event', topic, data, at: new Date().toISOString() });
      return;
    }
    const install = await getPluginInstall(getDb() as never, authz.serverId, row.pluginId).catch(() => null);
    const pluginId = install?.pluginId ?? row.pluginId;
    const projected = projectActivityState(row.state, pluginId, viewerUserId);
    send(socket, {
      type: 'event',
      topic,
      data: {
        status: data.status ?? row.status,
        revision: data.revision,
        publicSummary: data.publicSummary,
        state: projected,
      },
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[ws-gateway] activity projection failed: ${(err as Error).message}`);
    // Fail CLOSED for state — never forward unprojected state.
    send(socket, { type: 'event', topic, data, at: new Date().toISOString() });
  }
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

/** LF-SEC-009: how long a live socket tolerates an unreachable
 * revocation store before it is closed (fail-closed with grace). */
const REVOCATION_UNAVAILABLE_GRACE_MS = parseInt(
  process.env.WS_REVOCATION_GRACE_MS || String(60_000),
  10
);

/** 9th-audit: Redis Pub/Sub is fire-and-forget — a lost invalidation
 * message would leave stale authorization alive indefinitely. As
 * defense-in-depth the gateway re-runs the FULL subscription
 * authorization for every live topic on this cadence (default 30s),
 * independently of any event arriving. */
const PERIODIC_REAUTH_INTERVAL_MS = parseInt(
  process.env.WS_REAUTH_INTERVAL_MS || String(30_000),
  10
);
const ipConnectionCounts = new Map<string, number>();

export function createGateway(): { wss: WebSocketServer; server: http.Server; close: () => Promise<void> } {
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
      // SEC-004: LAST XFF entry (the trusted-proxy-observed hop), never
      // the first (client-controllable in a forwarded chain).
      const ip = process.env.NODE_ENV === 'production'
        ? trustedClientIp(info.req.headers, info.req.socket.remoteAddress)
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

  // 9th-audit: periodic FULL reauthorization of every live topic —
  // catches anything the (lossy) Pub/Sub invalidation missed. Shares
  // the invalidation sweep's re-check + removal logic.
  const periodicReauth = setInterval(() => {
    for (const client of wss.clients) {
      const state = connections.get(client);
      if (!state?.guest) continue;
      for (const topic of state.subs.topics()) {
        void (async () => {
          try {
            const authz = await authorizeTopicSubscribe(getDb(), state.guest!.uid, topic);
            if (authz.ok) return;
          } catch {
            // Transient DB error — the next sweep retries; do NOT mass-
            // disconnect on a blip.
            return;
          }
          if (client.readyState === client.OPEN) {
            send(client, {
              type: 'access_revoked',
              topic,
              reason: 'periodic_reauthorization',
              at: new Date().toISOString(),
            });
          }
          state.subs.remove(topic);
        })();
      }
    }
  }, Math.max(5_000, PERIODIC_REAUTH_INTERVAL_MS));

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
      // SEC-003 + LF-SEC-009: re-check revocation on LIVE sockets each
      // heartbeat — logout must close an already-open WS, not just
      // block new ones. 'unavailable' gets a BOUNDED grace (Redis
      // blips don't mass-disconnect), then the socket closes — no more
      // indefinite fail-open.
      if (state.guest) {
        void getRevocationStatus(state.guest.uid, state.guest.gid)
          .then((status) => {
            if (status === 'active') {
              state.revocationUnavailableSince = null;
              return;
            }
            if (status === 'revoked') {
              try {
                client.close(1008, 'session revoked');
              } catch {
                /* already closed */
              }
              return;
            }
            const now = Date.now();
            if (state.revocationUnavailableSince == null) {
              state.revocationUnavailableSince = now;
              return;
            }
            if (now - state.revocationUnavailableSince > REVOCATION_UNAVAILABLE_GRACE_MS) {
              try {
                client.close(1011, 'revocation store unavailable');
              } catch {
                /* already closed */
              }
            }
          })
          .catch(() => {
            /* getRevocationStatus never rejects; defensive no-op */
          });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  /**
 * SEC-004: extract the client IP safely. nginx now sends
 * X-Forwarded-For: $remote_addr ONLY (no chain), but defensively take
 * the LAST comma-separated entry — the address the TRUSTED proxy
 * observed — instead of the first, which an attacker controls when a
 * chain leaks through.
 */
function trustedClientIp(headers: import('http').IncomingMessage['headers'], socketRemote: string | undefined): string {
  const raw = headers['x-forwarded-for']?.toString();
  if (raw) {
    const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return socketRemote || 'unknown';
}

  // LF-SEC-003: event-driven access invalidation. When the web app
  // reports a kick/ban/role loss/channel-policy/block change, re-run
  // the subscription authorization for every AFFECTED live topic and
  // remove the ones that no longer pass — REST and realtime must lose
  // access at the same moment.
  const stopInvalidationListener = initAccessInvalidationListener((event) => {
    for (const client of wss.clients) {
      const state = connections.get(client);
      if (!state?.guest) continue;
      // user-server-access only concerns the named user.
      if (event.kind === 'user-server-access' && event.userId !== state.guest.uid) continue;

      for (const topic of state.subs.topics()) {
        if (!topicMatchesInvalidation(topic, event)) continue;
        void (async () => {
          try {
            const authz = await authorizeTopicSubscribe(getDb(), state.guest!.uid, topic);
            if (authz.ok) return;
          } catch {
            // On a transient DB error, REMOVE the subscription — fail
            // closed for a security invalidation (it will be re-granted
            // on the client's next subscribe if access is intact).
          }
          if (client.readyState === client.OPEN) {
            send(client, {
              type: 'access_revoked',
              topic,
              reason: event.reason,
              at: new Date().toISOString(),
            });
          }
          state.subs.remove(topic);
        })();
      }
    }
  });

  wss.on('connection', async (socket, req) => {
    const connectionIp = process.env.NODE_ENV === 'production'
      ? trustedClientIp(req.headers, req.socket.remoteAddress)
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
    // SEC-003: a revoked session must not open (or keep) a socket.
    // The early return MUST release the IP slot — the audit found a
    // revoked-cookie client could re-handshake forever and pin all 10
    // slots of its NAT IP (DoS on legitimate users behind the same IP).
    if (auth.ok) {
      const revocation = await getRevocationStatus(auth.guest.uid, auth.guest.gid);
      if (revocation === 'revoked') {
        releaseIpSlot();
        socket.close(1008, 'session revoked');
        return;
      }
      // LF-SEC-009: production fails CLOSED when the revocation store
      // cannot answer — REST already applies this model, and a signed
      // but revoked cookie must not slip back in through realtime
      // during an outage. Development stays permissive (local stacks
      // routinely run without the revocation Redis).
      if (revocation === 'unavailable' && process.env.NODE_ENV === 'production') {
        releaseIpSlot();
        socket.close(1011, 'revocation store unavailable');
        return;
      }
    }
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
      revocationUnavailableSince: null,
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
              // SEC-001: the bus payload carries NO canonical state (the
              // publisher only sends status/revision/publicSummary). For
              // activity-state topics we load the session and project it
              // for THIS viewer — the same projector the REST routes
              // use — so no subscriber ever sees another player's
              // secrets (Hushle deck/cards, Quiz correctIndex).
              if (authz.kind === 'activity-state') {
                void forwardProjectedActivity(socket, msg.topic, authz, data, state.guest.uid);
                return;
              }
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
    // The underlying HTTP server — tests need its ephemeral port.
    server: httpServer,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(periodicReauth);
      stopInvalidationListener();
      for (const client of wss.clients) {
        try {
          client.close(1001, 'shutting down');
        } catch {
          /* swallow */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
