# Messages API — M12 / Phase 2

The `messages` API is the third Phase 2 surface (after M10's servers API and M11's channels API). A message is a single text post in a channel — it is the unit of chat, replies, and (eventually) reactions and embeds.

This document covers:
- The DB query helpers ([`packages/db/src/queries/messages.ts`](../packages/db/src/queries/messages.ts))
- The five HTTP endpoints (list / create / get / patch / delete)
- The auth model (member-or-owner for reads, **author-or-owner** for mutations)
- The relationship to M10 (servers) and M11 (channels)
- The out-of-scope list (reactions, attachments, search, plugins, real-time)

## Auth model

A message is the smallest unit in the API, so the auth model has to be tighter than for channels. The rule is:

| Operation | Required relationship |
|---|---|
| `GET /api/servers/{id}/channels/{channelId}/messages` | Member of the server |
| `POST /api/servers/{id}/channels/{channelId}/messages` | Member of the server (permission check placeholder; real roles land with M13) |
| `GET /api/servers/{id}/channels/{channelId}/messages/{messageId}` | Member of the server |
| `PATCH /api/servers/{id}/channels/{channelId}/messages/{messageId}` | **Author of the message OR owner of the server** |
| `DELETE /api/servers/{id}/channels/{channelId}/messages/{messageId}` | **Author of the message OR owner of the server** |

The "message belongs to a different channel" case (URL says `channels/X/messages/Z` but `Z.channelId === Y`) returns **404**, not 403, so the route doesn't leak the existence of messages in other channels.

The owner override exists because moderation needs it: a server owner must be able to remove a message that violates rules, even if they did not author it. The "owner override" is the same shape M11 uses for `PATCH /channels/{channelId}`; once M13's role system lands, the owner override is replaced by a `MANAGE_MESSAGES` permission check on the caller's role.

## Endpoints

| Method | Path | Body | Description | Rate limit |
|---|---|---|---|---|
| `GET`    | `/api/servers/{id}/channels/{channelId}/messages`        | — | List messages in a channel, newest-first. Supports `?before=ISO` cursor and `?limit=N` (1-100, default 50). Soft-deleted messages are excluded. | 60 / min |
| `POST`   | `/api/servers/{id}/channels/{channelId}/messages`        | `{ content, replyToId?, metadata? }` | Create a message. `content` is 1-4000 chars (`MessageContentSchema`). | 30 / min |
| `GET`    | `/api/servers/{id}/channels/{channelId}/messages/{messageId}`   | — | Fetch a single message (soft-deleted returns 404). | 60 / min |
| `PATCH`  | `/api/servers/{id}/channels/{channelId}/messages/{messageId}`   | `{ content?, metadata? }` | Partial update. Always stamps `editedAt`. | 30 / min |
| `DELETE` | `/api/servers/{id}/channels/{channelId}/messages/{messageId}`   | — | **Soft delete** (sets `deletedAt`). | 10 / min |

All five go through `withApiSecurity(...)` so they inherit the standard security headers, the 405 + `Allow` behavior, and the in-process token-bucket rate limit.

### `POST` body

```ts
interface CreateMessageBody {
  content: string;          // 1..4000 chars, MessageContentSchema in @lobbyforge/core
  replyToId?: string;       // uuid of an existing message in the SAME channel
  metadata?: Record<string, unknown>;  // free-form, plugin-attached data
}
```

The route enforces three things:

1. The caller is a member of the server.
2. The body passes zod validation (the `replyToId`, if present, is a valid uuid).
3. The reply target, if present, is in the same channel — the DB helper rejects cross-channel replies with a 500 wrapped error.

### `PATCH` body

```ts
interface PatchMessageBody {
  content?: string;         // 1..4000 chars
  metadata?: Record<string, unknown>;
}
```

`userId`, `channelId`, `createdAt`, and `replyToId` are **immutable** through this route. An empty patch (no `content` and no `metadata`) returns 200 with the current row — the route treats it as a "re-read" rather than a 400.

### Common response shapes

```ts
// Message JSON (toJson in route.ts)
interface MessageJson {
  id: string;            // uuid
  channelId: string;     // uuid
  userId: string | null; // null if the author was anonymized via ON DELETE SET NULL
  content: string;       // 1..4000 chars
  metadata: Record<string, unknown>;
  replyToId: string | null;
  createdAt: string;     // ISO-8601
  editedAt: string | null;   // ISO-8601 or null
  deletedAt: string | null;  // ISO-8601 or null — tombstoned, never returned by GET
}
```

### Status codes

| Code | When |
|---:|---|
| 200 | `GET` / `PATCH` success (PATCH also returns 200 for an empty patch) |
| 201 | `POST` success |
| 400 | Body fails zod validation (empty content, > 4000 chars, invalid `replyToId` uuid, etc.) — or query string fails (`?before=not-a-date`, `?limit=abc`) |
| 401 | Cookie missing or signature invalid |
| 403 | Caller is not a member (reads) or not the author/owner (mutations) |
| 404 | Server not found, channel not found, channel doesn't belong to the URL's server, message not found, or message doesn't belong to the URL's channel |
| 500 | Drizzle threw (wrapped with a sanitized message) — including the "reply target is in a different channel" case |
| 503 | Cookie has no `uid` (DB not migrated / down) — see "503 contract" below |

### The 503 contract

If the cookie's `gid` has been minted but the `users` row was never materialized (e.g. Postgres was down at mint time and the `findOrCreateGuestUser` retry path failed), the cookie still has a `null` `uid`. M12 routes — like M10 + M11 — return **503** with `howToFix: "Re-issue POST /api/auth/guest"`. The fix-the-DB path is "make sure the DB is up, then re-run POST /api/auth/guest" — the second call materializes the row and the existing cookie is replaced.

## Soft delete

Messages are **soft-deleted**: the row stays in the `messages` table with a non-null `deletedAt`, and every list / get helper filters it out (`isNull(messages.deletedAt)`). The `DELETE` route calls `softDeleteMessage` which is idempotent — deleting an already-deleted message is a 500 with a "not found or already deleted" message (the route treats this as a 500 because the `where` filter means the row was either never there or already gone, both of which are programming errors from the caller's perspective).

The soft-delete column is what makes "edit history" feasible later — a `PATCH` is a real `UPDATE messages SET content=…` and the old content is overwritten. The "see older versions of an edited message" feature is M14+ (it requires an `message_edits` table).

## `replyToId` semantics

A reply target must be a message in the **same channel**. Cross-channel replies are rejected by the DB helper (`createMessage`):

```ts
if (target[0]?.channelId !== input.channelId) {
  throw new Error('Reply target is in a different channel');
}
```

This is the current rule, not a constraint in the schema. The schema's self-FK is just `messages.id` with `ON DELETE SET NULL`; a future iteration may relax this to allow cross-channel replies (Discord added the feature in 2022), but the route layer is the gate for now.

`replyToId` is a **soft target**: if the reply target is soft-deleted, the helper still accepts the insert (the row is still in the table, just hidden from the list). The UI is responsible for rendering "(reply to deleted message)" or hiding the reply chip.

## `metadata` blob

`metadata` is a JSONB column, free-form. Today it carries no schema — the route validates it as `Record<string, unknown>` and the DB helper reads it through. The intended consumers are:

- **Reactions** (M14) — keys like `reactions: { '👍': 3, '🎉': 1 }`.
- **Embeds** (M15) — keys like `embeds: [{ url, title, image }]`.
- **Plugin payloads** (M16) — keys like `plugin: { id: 'hushle', data: { … } }`.

M12 just stores and returns the blob; the readers are not yet implemented.

## DB schema (no delta from M3)

The `messages` table was in the M3 schema; M12 just exercises it. The relevant indexes (already in the M3 migration):

```sql
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_reply ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
```

The first index makes the "newest N messages in a channel" query a single index range scan; the second makes the "this message has N replies" lookup cheap.

## Query helpers

```ts
// packages/db/src/queries/messages.ts
createMessage(db, { channelId, userId, content, metadata?, replyToId? })
  // Asserts the channel exists (joins servers to filter out soft-deleted
  // parents) and that the reply target, if any, is in the same channel.

listMessagesForChannel(db, channelId, { limit?, before? })
  // Joins channels + servers, filters soft-deleted messages, sorts newest
  // first. The `before` cursor is an ISO-8601 timestamp; "give me messages
  // older than this". Default limit 50, hard cap 100.

getMessageById(db, messageId)
  // Joins channels + servers, filters soft-deleted messages AND
  // soft-deleted parents. Returns null for unknown ids AND for
  // soft-deleted messages (callers treat both as 404).

updateMessage(db, messageId, { content?, metadata? })
  // Partial update. Always stamps `editedAt`. Only `content` and
  // `metadata` are mutable; everything else is immutable through this
  // helper.

softDeleteMessage(db, messageId, now?)
  // Idempotent soft delete. The `where` filter (`isNull(deletedAt)`)
  // makes deleting an already-deleted message a no-op — the route
  // surfaces the empty-returning as a 500 because the caller asked
  // us to delete a row that wasn't there.
```

## Testing

`apps/web/app/api/servers/[id]/channels/[channelId]/messages/__tests__/messages.test.ts` covers all five endpoints with `vi.mock` for `@lobbyforge/db` and `@/lib/security-headers`:

| Scenario | Expected status |
|---|---:|
| `GET` without cookie | 401 |
| `GET` for a server where the caller is not a member | 403 |
| `GET` happy path, 2 messages returned in order | 200 |
| `GET ?before=not-a-date` | 400 |
| `GET ?limit=abc` | 400 |
| `POST` with empty content | 400 |
| `POST` with content > 4000 chars | 400 |
| `POST` happy path | 201, `createMessage` called with the right `channelId` and `userId` |
| `GET /{messageId}` for a missing message | 404 |
| `GET /{messageId}` for a message in a different channel | 404 |
| `GET /{messageId}` to a non-owner member | 200 |
| `PATCH /{messageId}` by a non-author, non-owner | 403 |
| `PATCH /{messageId}` by the author | 200, `updateMessage` called, `editedAt` set |
| `PATCH /{messageId}` by the server owner of a message they did not author | 200 (the owner override) |
| `DELETE /{messageId}` by a non-author, non-owner | 403 |
| `DELETE /{messageId}` by the author | 200, `softDeleteMessage` called |

The cookie sent in each request is a real signed `lf_guest` (built via `buildGuestSessionCookie`) so `readGuestSession` sees the production code path.

## Relationship to M10 + M11

- `GET /api/servers/{id}/channels/{channelId}/messages` reuses the M11 `isServerMember` check (member-of-server is the gate).
- The M11 `loadAndAuthorize` pattern (server → channel → message) is what M12's `loadAndAuthorize` mirrors, with one twist: the auth check at the message layer is "author OR server owner" instead of "owner only".
- `createMessage` joins `channels` to `servers` to filter out channels whose parent is soft-deleted — the M12 list / get / soft-delete helpers all rely on this. A soft-deleted server hides its messages from the list query, but the rows stay in the table.
- The "membership check" is now load-bearing for the chat surface — the `isServerMember` helper is the primitive the messages routes lean on. A future iteration adds a "is the caller in `users.deletedAt IS NOT NULL`?" check, but for M12 the membership check is the only authorization gate.

## Out of scope (deferred to later milestones)

- **Reactions.** The `reactions` table is in the M3 schema; a `POST /api/servers/{id}/channels/{channelId}/messages/{messageId}/reactions` endpoint is M14. Today the `metadata` blob is the only way a UI can attach a reaction count, and no route writes to it.
- **Attachments / file uploads.** The `attachments` table is in the M3 schema; the upload pipeline (S3-compatible storage, presigned URLs, MIME validation) is M15. The `metadata.attachments` key is reserved for that integration.
- **Message search.** Full-text search across all messages in a server (or all servers a caller is a member of) is a Postgres `tsvector` index + a `GET /api/servers/{id}/messages?q=…` endpoint. M16+.
- **Plugin-attached messages.** The `metadata.plugin` key is reserved for plugin payloads (Hushle game state, Quiz score update, etc.). The plugin SDK gains `MessageMetadataPatch` and `MessageMetadataRender` in M16.
- **Real-time delivery.** Today's read path is "client polls `GET /api/messages?before=…`". The real-time layer (WebSocket / SSE / LiveKit data channels) is M17. The `metadata` blob is forward-compatible with the realtime layer's optimistic-update model.
- **Audit logging for moderation actions.** "Owner X deleted user Y's message at T" is in the design notes; the `audit_log` table writes land with the M14 moderation pass.
- **Edit history.** A `PATCH` is destructive. The "see older versions of an edited message" feature requires a `message_edits` table; M14+.
- **Author anonymization on user delete.** The schema has `ON DELETE SET NULL` on `user_id`; the route layer renders `userId: null` as "Deleted User" once the M14 user-delete flow ships.
- **Cross-channel replies.** Today rejected by the helper. The schema allows it; the route layer is the gate. M15 if Discord's pattern is worth copying.
- **Bulk fetch.** "Give me the last 50 messages from 5 channels" is not in scope; the UI does N round-trips. M15 if the latency hurts.
- **@-mentions / notifications.** Parsing `@username` out of the content, resolving it to a user, and dispatching a notification is M16. The content is stored as-is today.
- **Rate-limit namespacing.** Today the per-channel limit is shared across all channels. A future iteration namespaces by `(channelId, action)` to prevent one chatty channel from starving the others.
