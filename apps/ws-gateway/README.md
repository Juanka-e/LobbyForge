# @lobbyforge/ws-gateway

Standalone WebSocket gateway for LobbyForge realtime updates.

The Next.js web app publishes activity-state changes and chat messages to
Redis pub/sub topics. This gateway subscribes on behalf of browser
clients, fans messages out over WebSocket connections, and validates
authorization on every `subscribe` call (same guest cookie + server
membership rule the SSE route uses).

## Run

```bash
# dev (watch mode)
pnpm -F @lobbyforge/ws-gateway dev

# prod
pnpm -F @lobbyforge/ws-gateway build
pnpm -F @lobbyforge/ws-gateway start
```

Required env vars:

- `LOBBYFORGE_SESSION_SECRET` (32+ chars) — guest cookie HMAC key.
- `REDIS_URL` — Redis the gateway subscribes to. Required in production; dev falls back to the local Docker default when omitted.
- `LF_DB_URL` — Postgres URL for membership checks on subscribe.
- `WS_ALLOWED_ORIGINS` — comma-separated browser origins allowed to open WebSocket connections. In production, also set `LOBBYFORGE_APP_ORIGIN` or `NEXT_PUBLIC_BASE_URL` if you do not use this list.
- `WS_HOST` (default `127.0.0.1`) + `WS_PORT` (default `19521`).

In development, point the browser at `ws://localhost:19521`.

## Wire protocol

See `src/protocol.ts`. Clients send JSON `{type: 'subscribe'|'unsubscribe', topic}`
and receive `{type: 'hello'|'subscribed'|'unsubscribed'|'event'|'error', ...}`.

Topics: `activity-state:{serverId}:{sessionId}`, `chat:{serverId}:{channelId}`,
`presence:{serverId}`, `dm:{channelId}`, and `user:{userId}` (Bot API v2:
ephemeral interaction answers from `lf:{env}:user-events:{uid}`; only the
session whose uid matches may subscribe).

## Bot connections (`/ws/bot`)

Bots (Bot API v2, [`docs/BOT_API_V2.md`](../../docs/BOT_API_V2.md) §4)
connect on `/ws/bot` with `Authorization: Bot <token>` on the upgrade or a
first `{ "type": "identify", "token": "lfb_…" }` message within 5 s. No
cookie and no Origin are needed. The gateway checks the token like the REST
API, then `enabled` and `receive_events`, sends `hello` + `ready`, and feeds
the bot its channels' messages (loaded from the database, filtered by
`read_messages` and channel access, never its own) plus interactions and
member events from `lf:{env}:bot-events:{botId}`. One connection per bot
(the older one closes with 4009); close codes 4001 / 4003 / 4009 / 4029 /
1011 are listed in `src/bot-protocol.ts` (`BotCloseCode`). Code:
`src/bot-gateway.ts` (connections), `src/bot-store.ts` (database reads),
`src/bot-token.ts` (token twin of `apps/web/lib/bots/token.ts`).

Optional env vars: `WS_BOT_MAX_CONN_PER_IP` (10), `WS_BOT_AUTH_FAIL_MAX`
(30 failed identifies per address per minute), `WS_BOT_CONNECT_MAX` (30
connects per bot per minute), `WS_BOT_IDENTIFY_TIMEOUT_MS` (5000),
`WS_BOT_MAX_CHANNELS` (500), `WS_BOT_MAX_PENDING_EVENTS` (500),
`WS_BOT_INBOUND_MAX` (60 messages per minute from a bot).
