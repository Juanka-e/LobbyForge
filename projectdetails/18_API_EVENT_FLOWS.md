# 18 — API ve Event Akışları

## 1. Login

```txt
Client → POST /api/auth/login
API → PostgreSQL users/session
API → secure httpOnly cookie
Client → app authenticated
```

## 2. Guest join

```txt
Client → invite link
Client → nickname seçer
API → guest user oluşturur
API → session cookie
Client → server/channel’a girer
```

## 3. Server oluşturma

```txt
POST /api/servers
body: { name }

DB:
- servers insert
- owner membership
- default roles
- default channels
```

## 4. Channel oluşturma

```txt
POST /api/servers/:serverId/channels
body: { name, type }
```

Permission:

```txt
manage_channels
```

## 5. Text mesaj gönderme

```txt
POST /api/channels/:channelId/messages
body: { content }
```

Akış:

1. auth check
2. permission check
3. PostgreSQL insert
4. Redis pub/sub event
5. connected clients receive event

## 6. Voice kanala girme

```txt
POST /api/livekit/token
body: { channelId }
```

Akış:

1. auth check
2. membership check
3. channel permission check
4. room name üret
5. LiveKit token üret
6. Redis presence update
7. client LiveKit’e bağlanır

## 7. Plugin başlatma

```txt
POST /api/activities/start
body: { channelId, pluginId, settings }
```

Akış:

1. permission check
2. plugin enabled mı?
3. game_session oluştur
4. initial state oluştur
5. Redis cache set
6. channel event broadcast
7. UI activity panel açar

## 8. Plugin action

```txt
POST /api/activities/:sessionId/actions
body: { type, payload }
```

Akış:

1. auth check
2. session status check
3. plugin handleAction
4. new state validate
5. Redis update
6. PostgreSQL important event insert
7. pub/sub broadcast

## 9. Vampir Köylü vote

```txt
POST /api/activities/:sessionId/actions
{
  "type": "submit_vote",
  "payload": { "targetUserId": "..." }
}
```

Backend:

- faz voting mi?
- oyuncu alive mı?
- daha önce oy vermiş mi?
- target valid mi?
- vote kaydet
- herkes verdiyse faz değiştir

## 10. Hushle correct card

```txt
POST /api/activities/:sessionId/actions
{
  "type": "mark_correct",
  "payload": { "cardId": "..." }
}
```

Backend:

- actor host/current controller mı?
- current round active mi?
- score update
- event insert
- next card

## 11. Public registry heartbeat

```txt
POST /api/registry/heartbeat
```

Instance → official registry:

- instanceId
- timestamp
- onlineUsers
- publicRooms
- version
- doctorScore
- signature

Registry:

- signature verify
- update row
- abuse checks
- list status update

## 12. Optional Sign in with LobbyForge

Bu akis sadece instance sahibi ozelligi actiysa kullanilir.

```txt
Client -> GET /api/auth/providers
Instance -> lobbyforge provider enabled mi?
Client -> /api/auth/lobbyforge/start
Instance -> official OAuth/OIDC authorize URL
Official LobbyForge -> callback code
Instance -> code exchange
Instance -> provider subject'i user_identity_links ile local user'a baglar
Instance -> local session cookie
Client -> instance authenticated
```

Kritik kural: official account local membership/role yerine gecmez. Instance local user row ve session olusturur.

## 13. Registry app install handoff

```txt
Client -> lobbyforge.org/apps/hushle
Client -> Install to server
Registry -> kullanicinin owner/admin oldugu instance'lari listeler
Client -> instance secer
Registry -> signed install handoff URL uretir
Client -> https://voice.example.com/admin/apps/install?handoff=...
Instance -> local auth + permission check
Instance -> manifest ve signature verify
Instance -> izin ekranini gosterir
Admin -> onaylar
Instance -> plugins_enabled/app_install kaydini yazar
Instance -> audit log: app.install
```

Registry app'i zorla kuramaz; instance son karari verir ve local audit log tutar.

## Realtime Transport Decision

### Chosen Architecture: Hybrid Model

LobbyForge uses a **hybrid realtime model** with two transport layers:

| Transport | Use Case | When |
|---|---|---|
| **LiveKit Data Channel** | Game events, voice room presence, plugin state, typing in voice rooms | User is in a voice/activity room |
| **Server-Sent Events (SSE)** | Text chat messages, global presence, notifications, server events | Always connected when app is open |

### Why NOT a Separate WebSocket Server

- Users in voice rooms already have a LiveKit WebSocket connection — adding a second WS connection doubles complexity
- Next.js App Router doesn't support native WebSocket handlers
- SSE works through standard HTTP — no special server needed, works with Next.js API routes
- SSE has automatic reconnection built into the browser EventSource API
- For game events, LiveKit Data Channel provides lower latency (~20-50ms) than any separate WS

### LiveKit Data Channel Usage

```ts
// Reliable: game actions, chat in voice room, phase changes
room.localParticipant.publishData(
  encoder.encode(JSON.stringify(action)),
  DataPacket_Kind.RELIABLE
);

// Lossy: typing indicators, cursor position, audio levels
room.localParticipant.publishData(
  encoder.encode(JSON.stringify(indicator)),
  DataPacket_Kind.LOSSY
);
```

**Server-side handling:** LiveKit server receives data channel messages via webhooks or the LiveKit Server SDK. The server validates, processes, and rebroadcasts.

### SSE Connection

```
GET /api/events/stream
Headers: Accept: text/event-stream
         Authorization: session cookie

Events:
  - message:new          (new text chat message)
  - message:edited       (message edited)
  - message:deleted      (message deleted)
  - presence:update      (user online/offline/idle)
  - server:update        (server settings changed)
  - channel:update       (channel created/edited/deleted)
  - member:join          (new member joined server)
  - member:leave         (member left/kicked)
  - notification:new     (mention, invite, game invite)
  - typing:start         (user started typing — text channels only)
  - typing:stop          (user stopped typing)
```

**Server-side:** Redis Pub/Sub → SSE endpoint. Each SSE connection subscribes to the user's relevant Redis channels.

```
Client ← SSE ← Next.js API Route ← Redis Pub/Sub ← Event Producer (API handlers, workers)
```

### Latency Targets

| Event Type | Target Latency | Transport |
|---|---|---|
| Game action (Hushle correct/pass) | <50ms | LiveKit Data Channel |
| Vampire Village phase change | <100ms | LiveKit Data Channel |
| Text chat message | <200ms | SSE |
| Presence update | <2s | SSE |
| Typing indicator | <100ms | Data Channel (voice) / SSE (text) |
| Notification | <1s | SSE |

### Offline / Reconnection

- SSE: browser EventSource auto-reconnects. Server sends `Last-Event-ID` support for catch-up.
- LiveKit: SDK handles reconnection automatically. Game state snapshot requested on reconnect.
- Client keeps a local event buffer. On reconnect, requests missed events since last received ID.
- If too many events missed (>5 min offline), client does a full state refresh via REST.

## API Error Response Format

All API errors follow a consistent format:

```json
{
  "error": {
    "code": "CHANNEL_NOT_FOUND",
    "message": "The requested channel does not exist or you don't have access.",
    "status": 404,
    "details": {}           // optional, extra context
  }
}
```

### Error Code Categories

| Prefix | Domain | Example |
|---|---|---|
| `AUTH_` | Authentication/Authorization | `AUTH_INVALID_CREDENTIALS`, `AUTH_SESSION_EXPIRED` |
| `PERM_` | Permissions | `PERM_INSUFFICIENT`, `PERM_ROLE_REQUIRED` |
| `SERVER_` | Server operations | `SERVER_NOT_FOUND`, `SERVER_FULL` |
| `CHANNEL_` | Channel operations | `CHANNEL_NOT_FOUND`, `CHANNEL_TYPE_INVALID` |
| `MSG_` | Messages | `MSG_TOO_LONG`, `MSG_RATE_LIMITED` |
| `GAME_` | Plugin/Game | `GAME_SESSION_FULL`, `GAME_INVALID_ACTION` |
| `UPLOAD_` | File uploads | `UPLOAD_TOO_LARGE`, `UPLOAD_INVALID_TYPE` |
| `RATE_` | Rate limiting | `RATE_LIMIT_EXCEEDED` |
| `INTERNAL_` | Server errors | `INTERNAL_ERROR` |

### HTTP Status Code Usage

- `200` — Success
- `201` — Created (new resource)
- `204` — No Content (delete operations)
- `400` — Bad Request (validation error, include field errors in details)
- `401` — Unauthorized (not logged in)
- `403` — Forbidden (logged in but no permission)
- `404` — Not Found
- `409` — Conflict (duplicate, already exists)
- `422` — Unprocessable Entity (valid JSON but semantically wrong)
- `429` — Too Many Requests (rate limited, include `Retry-After` header)
- `500` — Internal Server Error

## Pagination Strategy

### Cursor-Based Pagination (Default)

Used for: messages, audit logs, game sessions, plugin events — any time-ordered data.

```
GET /api/channels/:id/messages?cursor=<lastMessageId>&limit=50&direction=before

Response:
{
  "data": [...],
  "pagination": {
    "cursor_next": "uuid-of-last-item",    // null if no more
    "cursor_prev": "uuid-of-first-item",   // null if at start
    "has_more": true,
    "limit": 50
  }
}
```

**Why cursor-based:**
- No skipped/duplicate items when new messages arrive
- Consistent performance (no OFFSET scan)
- Natural for infinite scroll UIs

### Offset-Based Pagination (Rare)

Used only for: member lists, role lists, server search — stable, non-time-ordered data.

```
GET /api/servers/:id/members?page=1&limit=50

Response:
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 234,
    "total_pages": 5
  }
}
```

### Default Limits

| Resource | Default Limit | Max Limit |
|---|---|---|
| Messages | 50 | 100 |
| Members | 50 | 200 |
| Audit logs | 50 | 100 |
| Game sessions | 25 | 50 |
| Search results | 20 | 50 |
