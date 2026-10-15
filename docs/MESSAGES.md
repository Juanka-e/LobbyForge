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
| `POST`   | `/api/servers/{id}/channels/{channelId}/messages`        | `{ content, replyToId? }` | Create a message. `content` is 1-4000 chars (`MessageContentSchema`). | 30 / min |
| `GET`    | `/api/servers/{id}/channels/{channelId}/messages/{messageId}`   | — | Fetch a single message (soft-deleted returns 404). | 60 / min |
| `PATCH`  | `/api/servers/{id}/channels/{channelId}/messages/{messageId}`   | `{ content?, pinned? }` | Partial update. Always stamps `editedAt`. | 30 / min |
| `DELETE` | `/api/servers/{id}/channels/{channelId}/messages/{messageId}`   | — | **Soft delete** (sets `deletedAt`). | 10 / min |

All five go through `withApiSecurity(...)` so they inherit the standard security headers, the 405 + `Allow` behavior, and the in-process token-bucket rate limit.

**Body cap.** `POST` and `PATCH` refuse a body over **16 KiB** with `413`
before the handler runs (`MESSAGE_BODY_MAX_BYTES`, `lib/message-limits.ts`;
the same cap applies to `POST /api/dm/{channelId}/messages`). 4000
characters are at most 12 000 bytes of UTF-8, so every valid message fits.

### `POST` body

```ts
interface CreateMessageBody {
  content: string;          // 1..4000 chars, MessageContentSchema in @lobbyforge/core
  replyToId?: string;       // uuid of an existing message in the SAME channel
}
```

The schema is strict: any other field is a `400`, and `metadata` gets its own
`400 { code: "metadata_not_allowed" }` (see *`metadata` blob* below).

The route enforces three things:

1. The caller is a member of the server.
2. The body passes zod validation (the `replyToId`, if present, is a valid uuid).
3. The reply target, if present, is in the same channel — the DB helper rejects cross-channel replies with a 500 wrapped error.

### Mention Everyone

Content that mentions `@everyone` **or `@here`** needs the **Mention
Everyone** permission (`mention_everyone`); without it the route answers
`403`. As in Discord, the one permission covers both: `@here` pings everyone
online, the same mass ping for the people it reaches. The check
(`mentionsEveryoneOrHere`, `lib/everyone-mention.ts`) runs on:

- a new message (`POST`);
- an edit (`PATCH` with `content`) — posting "hi" and editing it to
  "hi @everyone" no longer gets round it;
- a chat poll's question and options together (docs/CHAT_POLLS.md).

Every mention a reader sees counts, wherever it sits: `(@everyone)`,
`hi,@here` and a full-width `＠everyone` (the text is NFKC-normalised
first) all need the permission. A letter, digit or `_` right before the `@`
or right after the word means it is not a mention, so `ada@everyone.example`
and `@everyones` pass. Bots and webhooks may never mention either; that is
the same rule (`containsMassMention`, docs/BOTS.md).

### `PATCH` body

```ts
interface PatchMessageBody {
  content?: string;         // 1..4000 chars — the author only
  pinned?: boolean;         // owner / Manage Messages; stamps metadata.$pinnedAt / $pinnedBy
}
```

`userId`, `channelId`, `createdAt`, `replyToId` and `metadata` are **immutable** through this route (the schema is strict). An empty patch (no `content` and no `pinned`) returns 200 with the current row — the route treats it as a "re-read" rather than a 400.

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
| 400 | Body fails zod validation (empty content, > 4000 chars, invalid `replyToId` uuid, an unknown field, client `metadata` → `metadata_not_allowed`) — or query string fails (`?before=not-a-date`, `?limit=abc`) — or `replyToId` names a message that does not exist or is in another channel (`invalid_reply`; it used to be a 500) |
| 401 | Cookie missing or signature invalid |
| 413 | `POST` / `PATCH` body over 16 KiB |
| 403 | Caller is not a member (reads) or not the author/owner (mutations); `@everyone` / `@here` in the content without Mention Everyone |
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

`metadata` is a JSONB column, free-form, and **written by the server only**:
a poll (`poll`), a bot's command answer (`interaction`), an incoming
webhook (`webhook`), a game plugin's chat line (`app`), a built-in bot's
catalogue text (`i18n`) and pins (`$pinnedAt`, `$pinnedBy`).

**No client metadata (security-review AUTHZ-008).** A member's `POST` used
to accept a free-form record and only checked its top-level key names, so
about 1 MB could ride along on every message (30 a minute) into each lobby
render, list response and live subscriber. No first-party client sends
metadata, so `POST` now refuses it outright — `400 { code:
"metadata_not_allowed" }`, whatever its keys — and `PATCH` has never taken
it. A future client-written field gets an allowlisted key with a small
serialized cap, not a free-form record.

`poll` belongs to polls in text channels (docs/CHAT_POLLS.md): a poll
message stores `metadata.poll = { id }`, written by the poll route in the
same transaction as the poll. `GET …/messages` adds a `poll` field
(projected for the caller) to those messages only, and a poll message's
`content` cannot be edited (403 `poll_message_readonly`).

## Blocked authors

A viewer never reads the words of someone they blocked. `GET …/messages`
and the server-rendered lobby replace such a message with a placeholder
(`blocked: true`, no author, no content, `poll: null`). The live chat
(`LobbyLiveRoster`) applies the same rule to messages that arrive over the
realtime feed and to the local echo, using the viewer's block list
(`BlockListProvider`): the same placeholder, and **no desktop
notification** for a blocked author. Someone blocked while the channel is
open has their messages on screen masked at once (security-review
AUTHZ-009).

The typing indicator (`GET …/typing`) leaves out users the viewer blocked,
users who blocked the viewer, and users whose *Online status* privacy hides
them from the viewer — the presence rule (docs/PRESENCE.md). Saying you are
typing (`POST …/typing`) takes what posting takes — membership, seeing the
channel and `SEND_MESSAGES` (the message route's send check), and not being
timed out (`403 actor_timed_out`) — and the name shown is resolved on the
server: the community nickname, else the account's display name (it used to
be the session cookie's name, without the nickname and stale after a rename).

## Direct messages

`POST /api/dm { recipientUserId }` opens (or reuses) a 1:1 conversation.
The recipient must be a live user who **shares a community** with the
caller — both current members of a live server, neither banned there — or
one the caller **already has a conversation** with. Anything else (an
unknown id, a stranger) is the same `404 { error: "User not found" }`: no
existence oracle (an unknown id used to be an FK error and a 500). A block
in either direction is still `403`. The ids are compared and the pair is
ordered in lower case (the database's spelling of a uuid), so an upper-case
id neither opens a second conversation with the same person nor a
"conversation" with yourself; two first messages at once reuse one row
(the insert does nothing on the pair's unique index and reads the winner
back). `POST /api/dm/{channelId}/messages`
takes `{ content, replyToId? }` (strict) with the 16 KiB body cap above.
`GET /api/dm/{channelId}/messages?limit=&before=` pages back in time:
`limit` is an integer clamped to 1..100 (default 50) and `before` a date;
anything else is `400`, and a channel id that is not a UUID is `404` (both
used to reach Postgres and come back as a 500).

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
  // first (then by id, so ties keep one order). The `before` cursor is an
  // ISO-8601 timestamp; "give me messages older than this". Default limit
  // 50, hard cap 100. `created_at` has microseconds but the cursor (the
  // last row's createdAt) only milliseconds, so a full page also carries
  // the rows that share its last row's millisecond (queries/pagination.ts)
  // and can run past `limit` by those; the next page then misses nothing.
  // listDmMessages and listAuditLogsForServer page the same way.

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
