# Presence — M14 / Phase 2 community MVP

The presence system is the Redis-backed heartbeat that powers "who is in this voice channel" and "who is in this server" lists. M14 productionized the M14-stubbed `setUserPresence` + `getUserPresenceInServer` and added the channel-scoped reader + the channel-presence route.

This document covers:
- The Redis key shape
- The 90-second TTL contract
- The 3 lib functions in [`apps/web/lib/redis.ts`](../apps/web/lib/redis.ts)
- The 2 HTTP endpoints (server + channel)
- The heartbeat contract the voice-room UI honors
- The on-disk-TTL-vs-heartbeat-interval budget
- The out-of-scope list (real-time, WebSocket, presence pings, webhooks)

## Redis key shape

Two parallel key families, both with a 90-second TTL:

```
lf:<env>:presence:server:<serverId>:<userId>  → JSON({ userId, status, channelId, lastSeen, activity? })
lf:<env>:presence:channel:<channelId>:<userId> → JSON({ userId, status, channelId, lastSeen, activity? })
```

`<env>` is `process.env.NODE_ENV` (defaults to `dev` when unset). The full key prefix is built once per `setUserPresence` call. The `:<userId>` suffix means each user has at most one live row per server / channel — switching channels silently overwrites the previous channel's row.

The `EX 90` TTL is set with `SET ... EX 90` (or via the ioredis pipeline in `setUserPresence`). ioredis re-issues the `SET` on every heartbeat, which extends the TTL — the TTL is "no heartbeat for 90s → gone", not "lives for 90s after first write".

## The 3 lib functions

```ts
// apps/web/lib/redis.ts
setUserPresence(userId, serverId, channelId, status = 'online', ttlSeconds = 90)
getUserPresenceInServer(serverId)         // returns parsed JSON array, ignores null entries
getUserPresenceInChannel(channelId)       // mirror of the server-scoped reader
```

The `setUserPresence` is a pipelined double-write (server + channel keys), so a single heartbeat updates both readers in one round trip.

The readers use cursor-based `SCAN ... MATCH` + `MGET`. This avoids Redis
`KEYS`, which can block the server as a self-host instance grows.

## Endpoints

| Method | Path | Auth | Body | Status | Rate limit |
|---|---|---|---|---|---|
| `POST` | `/api/presence`                                 | Session + `uid` | `{ serverId, channelId, status: 'online' \| 'idle' \| 'dnd' \| 'offline', activity? }` | 200 / 400 / 401 / 503 | 60 / min |
| `GET`  | `/api/presence?serverId=…`                      | Member  | — | 200 / 400 / 401 / 403 / 404 | 60 / min |
| `GET`  | `/api/servers/{id}/channels/{channelId}/presence` | Member  | — | 200 / 401 / 403 / 404 | 60 / min |

The `POST` body uses a Zod enum to bound the `status` string. Unknown values are 400'd.

`GET /api/presence?serverId=…` is a "show me everyone in this server" endpoint. The membership check is the same shape as the channels endpoint: `server.ownerUserId === session.uid` short-circuits, otherwise `isServerMember`.

`GET /api/servers/{id}/channels/{channelId}/presence` is the channel-scoped version. It also validates the channel belongs to the URL's server so a caller can't probe channel existence in other servers.

Both GETs return `{ presences: Presence[] }` with `Cache-Control: no-store`.
The response is a public snapshot, not the raw Redis value:

- `onlineStatusVisibility: nobody` returns `status: "hidden"` for other viewers.
- `activityVisibility` gates the optional `activity` object.
- `showCurrentGame`, `showMusicStatus`, and `showWatchPartyStatus` hide
  game/music/watch-party activity kinds independently.
- `showServerNameInActivity` controls whether `activity.serverName` is present.
- `friends` visibility is treated as self-only until a friends graph exists.

## Heartbeat contract

The voice-room UI (`apps/web/app/room/[roomName]/page.tsx`) posts a heartbeat every 5 seconds:

```ts
setInterval(() => {
  void fetch(`/api/servers/${serverId}/channels/${channelId}/presence`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'online' }),
  });
}, 5_000);
```

The first heartbeat fires immediately on mount so the new joiner shows up in the channel list without a 5-second wait.

The on-disk-TTL-vs-heartbeat-interval budget is simple: with `TTL = 90s` and `heartbeat = 5s`, the system tolerates up to 17 consecutive missed heartbeats before the user is "offline". One or two dropped POSTs (e.g. the browser tab is backgrounded for a few seconds, or the network blipped) don't drop the user out. A hard tab close does — the keys expire within 90s and the user drops out of the channel list naturally.

A future iteration can lower the heartbeat interval for better fidelity, but 5s is the right balance for a 14" laptop on a coffee-shop Wi-Fi.

## Relationship to LiveKit

The presence system is **independent** of LiveKit. The voice room UI:

1. Joins the LiveKit room (WebSocket, via `livekit-client`).
2. **In parallel**, posts a heartbeat to the LobbyForge presence API.

A user can be in the LiveKit room (and audible to other LiveKit participants) but missing from the LobbyForge presence list if their heartbeat POST fails. Conversely, a user can be in the presence list (their last heartbeat was 4 seconds ago) but no longer in the LiveKit room.

That decoupling is deliberate: LiveKit is the audio layer; the presence list is the LobbyForge layer. The two don't need to be the same source of truth, and making them so would mean every LiveKit connection event (join, leave, reconnect) would need to flow through our API to update presence. Today the 5-second heartbeat converges the two.

## Cross-platform

- ioredis is platform-agnostic at the protocol level; the dev stack runs the same Redis on Windows (via Docker) and Linux.
- The `redis.keys` + `redis.mget` pattern works the same on both OSes. The key set is small enough that a synchronous `KEYS` is fine.

## Tests

The `lib/redis.ts` file is not directly unit-tested (Redis is a network dependency; the route tests in M15 will use a real or fakeredis instance). The presence routes are not covered by the M14 test expansion — the M13-test-coverage-gap pass (which delivered the 15 roles + 13 members tests) was the priority. The presence route tests are a M15 follow-up.

## Out of scope

- **Real-time delivery.** The presence read path is "client polls every N seconds". The real-time layer (WebSocket / SSE / LiveKit data channels) is M17.
- **Presence pings (Slack / Discord-style "X is playing a game").** Today the `status` enum is `online / idle / dnd / offline`. A "playing X" string is the natural extension; the UI lands with M15.
- **Cross-device presence.** A user on two devices shows up as one row (the keys are per-user, not per-device). Multi-device fanout is M15+.
- **Status from external services (Spotify, Steam, etc.).** Plugin territory; the `plugin-sdk` can write to the same key prefix.
- **Webhooks on presence change.** A `lf:presence-changed:<serverId>` Pub/Sub channel would let the desktop app push notifications. Not in scope until a consumer needs it.
- **Geographic "from city" metadata.** The `lastSeen` is a server-side timestamp, not a client-side geo. Adding `lat` / `lon` is a privacy decision (and a M15+ feature).
- **Per-channel permission overrides for presence.** The channel-presence read requires the caller to be a member of the server, not of the channel. A future iteration can add a "this channel is hidden from the channel list" gate.
- **Presence rate-limit namespacing.** Today the per-user limit is shared across all `POST /api/presence` calls. A future iteration namespaces by `(userId, action)`.
- **Connection-counting.** "X online, Y idle, Z dnd" is a simple reduction over the presence list. The route layer can add it; the UI can compute it client-side for now.

## Security Hardening Update

Current behavior after the security pass:

- `POST /api/presence` verifies that the server exists, the caller is
  owner/member, and the channel belongs to that server before writing
  presence.
- Presence readers use cursor-based Redis `SCAN ... MATCH` plus `MGET`, not
  blocking `KEYS`.
- The generic API wrapper applies an Origin guard for state-changing browser
  requests.
- Rate limiting is route + caller-IP scoped in-process. A Redis-backed limiter
  remains the production-scale follow-up.
