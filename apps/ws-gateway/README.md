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
- `WS_HOST` (default `127.0.0.1`) + `WS_PORT` (default `3001`).

In development, point the browser at `ws://localhost:3001`.

## Wire protocol

See `src/protocol.ts`. Clients send JSON `{type: 'subscribe'|'unsubscribe', topic}`
and receive `{type: 'hello'|'subscribed'|'unsubscribed'|'event'|'error', ...}`.

Topics: `activity-state:{serverId}:{sessionId}`, `chat:{serverId}:{channelId}`.
