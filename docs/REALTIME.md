# Realtime architecture

LobbyForge has two transports for pushing server-to-client state changes:
**SSE** (Server-Sent Events) and **WebSocket**. Both are layered on top
of a shared **Redis pub/sub bus**, so the Next.js app stays the only
process that writes to `game_sessions` / `messages`; the WS gateway is a
read-only fan-out.

This doc covers the architecture, the wire protocol, the authorization
rules, and the production layout. The SDK-level conventions for
plugins that want to push their own events live in
[`docs/PLUGIN_SDK.md`](./PLUGIN_SDK.md); the per-activity route surface
is in [`docs/ACTIVITIES.md`](./ACTIVITIES.md).

## Architecture overview

```
                ┌──────────────────────────────────────┐
                │  Browser (Next.js client)            │
                │  RealtimeClient (apps/web/lib)        │
                └────────┬─────────────────┬────────────┘
                         │ WS               │ EventSource (fallback)
                         │                  │
              ┌──────────▼──────┐   ┌───────▼──────────────┐
              │  apps/ws-       │   │  Next.js             │
              │  gateway (3001) │   │  apps/web            │
              │  ws + ioredis   │   │  /api/.../stream     │
              └──────────┬──────┘   └───────┬──────────────┘
                         │                  │
                         │ Redis SUBSCRIBE  │
                         │ Redis PUBLISH    │
                         └────────┬─────────┘
                                  │
                          ┌───────▼─────────┐
                          │  Redis pub/sub  │
                          │  lf:{env}:*     │
                          └─────────────────┘
```

The Next.js app publishes to Redis on the action / end / message routes.
The ws-gateway and the SSE route both subscribe to the same topics.
Clients pick whichever transport fits their needs — modern browsers get
WS by default; hosts behind proxies that strip WS upgrades stay on SSE.

## Topics

| Topic (wire) | Redis channel | Publisher | Consumer(s) |
|---|---|---|---|
| `activity-state:{serverId}:{sessionId}` | `lf:{env}:activity-state:{serverId}:{sessionId}` | activity `actions` + `end` routes | SSE stream route, ws-gateway |
| `chat:{serverId}:{channelId}` | `lf:{env}:chat:{serverId}:{channelId}` | messages `POST` route | ws-gateway (chat UI is M20+) |

Both topics are scoped to `(serverId, resourceId)`. A user can subscribe
only to topics whose `serverId` they have access to.

## Wire protocol (WebSocket)

Client → server (JSON text frames):

```json
{ "type": "subscribe",   "topic": "activity-state:srv-1:abc" }
{ "type": "unsubscribe", "topic": "chat:srv-1:def" }
```

Server → client:

```json
{ "type": "hello",       "ok": true, "uid": "...", "at": "..." }
{ "type": "subscribed",  "topic": "...", "at": "..." }
{ "type": "unsubscribed","topic": "...", "at": "..." }
{ "type": "event",       "topic": "...", "data": {...}, "at": "..." }
{ "type": "error",       "topic": "...", "code": "forbidden", "message": "..." }
```

Errors carry one of:

- `bad_message` — payload didn't match the schema (invalid JSON, missing fields, etc.).
- `forbidden` — the caller isn't a member of the topic's server.
- `unknown_topic` — topic shape is unknown.
- `rate_limited` — subscribe rate limit exceeded.

The gateway enforces 30 subscribe messages / 60s / connection.

## Authentication

The browser sends the `lf_guest` cookie in the `Cookie` header on the
HTTP upgrade request. The gateway validates it via
`@lobbyforge/core`'s `readGuestSession` and closes the socket with code
`4401` (a non-standard "unauthenticated" code picked for the gateway) on
failure. The cookie's HMAC must verify against `LOBBYFORGE_SESSION_SECRET`
and the payload's `uid` must be non-null (post-`POST /api/auth/guest`).

## Authorization

Every `subscribe` is gated by `authorizeTopicSubscribe(...)`:

- The server's owner always passes (no DB lookup beyond `getServerById`).
- Everyone else must be a member of `serverId` (`isServerMember`).

A non-member's subscribe receives `{type: 'error', code: 'forbidden'}` —
the connection stays open so the client can retry with a different topic
or refresh their session.

## Redis subscriber pool

The gateway's `apps/ws-gateway/src/redis-subscriber.ts` keeps one ioredis
connection per topic with a refcounted handler set:

1. First `acquire` for a topic opens a fresh connection and starts the
   Redis `SUBSCRIBE`.
2. Subsequent `acquire`s on the same topic share the existing connection
   (handler is appended to the fan-out set).
3. `release` decrements the refcount; when it hits zero, the connection
   issues `UNSUBSCRIBE` and quits.

This means a popular voice room with 100 spectators costs **one** Redis
connection, not 100. The web app's `apps/web/lib/activity-bus.ts` and
`chat-bus.ts` use the same pattern locally.

## Browser client (`apps/web/lib/realtime-client.ts`)

```ts
import { getRealtimeClient } from '@/lib/realtime-client';

const client = getRealtimeClient();
client.connect();

const unsubscribe = client.subscribe(
  `activity-state:${serverId}:${sessionId}`,
  (data) => {
    // `data` is whatever the publisher JSON.stringified.
    // For activity-state: { status, state, at }
    // For chat: { id, channelId, userId, content, ... }
  }
);

// Later:
unsubscribe();
```

`RealtimeClient` is a module-level singleton — one connection per page
load. It auto-reconnects with exponential backoff (cap 30s), queues
subscribes that arrive while disconnected, and replays them on the
next `open`. A 60s heartbeat closes the socket if the server hasn't
pinged in time, which triggers reconnect.

The default URL is `ws://{window.location.hostname}:3001`. Override
via `NEXT_PUBLIC_WS_URL` (the env var the build reads).

## Transport selection

The M20-bis room page uses `RealtimeClient` exclusively. The SSE route
stays in place as a fallback — some hosts sit behind reverse proxies
that strip WS upgrade headers. Future code can choose per-feature:

| Use case | Recommended transport | Why |
|---|---|---|
| Activity state streaming | WS | already wired in the room page; lower latency on first message |
| Chat message streaming (M20+) | WS | higher message volume, multiplexing helps |
| Push notifications / one-off alerts | SSE | simpler, no client state to manage |
| Bidirectional events (typing, presence heartbeats) | WS | only transport that supports it |

When the chat UI lands (M20+), it will use the WS path too. The SSE
route stays untouched and continues to serve the activity stream as a
backup.

## Production layout

- **Dev**: `pnpm -F @lobbyforge/ws-gateway dev` runs the gateway on
  `:3001` with `node --watch`. The Next.js dev server runs on `:3000`.
  Both talk to the same Redis instance via `REDIS_URL`.
- **Prod**: The gateway runs as a separate container/pod behind a load
  balancer. Reverse-proxy rules forward WS upgrades (the `Upgrade:
  websocket` + `Connection: Upgrade` headers) to the gateway. The
  Next.js app is unchanged.

Required env vars on the gateway container:

- `LOBBYFORGE_SESSION_SECRET` (32+ chars)
- `REDIS_URL` — required in production; development falls back to the local Docker default only when omitted
- `LF_DB_URL` — Postgres URL for the membership checks
- `WS_ALLOWED_ORIGINS` — optional comma-separated allowlist for browser WebSocket origins. `LOBBYFORGE_APP_ORIGIN` and `NEXT_PUBLIC_BASE_URL` are also accepted when set. Production rejects missing or unlisted origins.
- `WS_HOST` (default `127.0.0.1`)
- `WS_PORT` (default `3001`)

## Future

- **WebSocket auth refresh.** Today the cookie is validated once at
  upgrade; a long-lived connection whose cookie expires mid-session
  keeps streaming until the next subscribe attempt fails. M21+ should
  add a `refresh` message the client can send with a fresh cookie.
- **Server-side broadcast.** Plugins that want to push events outside
  the activity-state namespace (e.g. leaderboard updates, world events)
  should declare the topic via `manifest.realtime?.topics` and let the
  host mediate publication. M20+ design work.
- **Server-initiated pings.** The gateway already pings every 30s; the
  client detects missed pings and reconnects. No change needed unless
  we add a richer keep-alive protocol.
