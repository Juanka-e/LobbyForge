# Channels API — M11 / Phase 2

The `channels` API is the second Phase 2 surface (after M10's servers API). A channel is the unit of (a) text chat and (b) voice / activity rooms; it lives inside a server and is the parent of every message and every active voice session.

This document covers:
- The DB query helpers ([`packages/db/src/queries/channels.ts`](../packages/db/src/queries/channels.ts), [`packages/db/src/queries/memberships.ts`](../packages/db/src/queries/memberships.ts))
- The five HTTP endpoints (list / create / get / patch / delete)
- The auth model (member-or-owner for reads, owner-only for mutations)
- The relationship to the M10 servers API
- The out-of-scope list (messages, voice presence, permissions, roles, audit log)

## Auth model

M11 flips the `GET /api/servers/{id}` rule from "owner-only" (M10) to **"any member of the server"**. The `isServerMember(db, userId, serverId)` helper in `packages/db/src/queries/memberships.ts` is the single source of truth. The owner is auto-added as a member by `createServer`, so the owner-only case is implicit in the membership lookup.

For channel operations:

| Operation | Required relationship |
|---|---|
| `GET /api/servers/{id}/channels` | Member of the server |
| `POST /api/servers/{id}/channels` | Member of the server (permission check placeholder; real roles land with M13) |
| `GET /api/servers/{id}/channels/{channelId}` | Member of the server |
| `PATCH /api/servers/{id}/channels/{channelId}` | **Owner** of the server (or someone with `MANAGE_CHANNELS` once M13 lands) |
| `DELETE /api/servers/{id}/channels/{channelId}` | **Owner** of the server |

The "channel belongs to a different server" case (URL says `servers/A/channels/X` but `X.serverId === B`) returns **404**, not 403, so the route doesn't leak the existence of channels in other servers.

## Endpoints

| Method | Path | Body | Description | Rate limit |
|---|---|---|---|---|
| `GET`    | `/api/servers/{id}/channels`        | — | List channels in a server, ordered by `position` ASC. | 60 / min |
| `POST`   | `/api/servers/{id}/channels`        | `{ name, type, topic?, pluginId?, position? }` | Create a channel. Position defaults to `max(position) + 1`. | 10 / min |
| `GET`    | `/api/servers/{id}/channels/{channelId}`   | — | Fetch a single channel. | 60 / min |
| `PATCH`  | `/api/servers/{id}/channels/{channelId}`   | `{ name?, topic?, position? }` | Partial update. | 30 / min |
| `DELETE` | `/api/servers/{id}/channels/{channelId}`   | — | Hard-delete (the `channels` schema has no `deletedAt`). | 10 / min |

All five go through `withApiSecurity(...)` (now generic over `TContext`, see [M10 SERVERS docs](SERVERS.md)) so they inherit the standard security headers, the 405 + `Allow` behavior, and the in-process token-bucket rate limit.

### Atomic Position Shifting (M15.6)

`updateChannel` now performs an atomic "move-and-shift" operation when the `position` is updated. It uses a database transaction to reorder sibling channels, ensuring no gaps or duplicates in the position sequence. This provides stable, predictable ordering for the channel list.

### `POST /api/servers/{id}/channels` body

```ts
interface CreateChannelBody {
  name: string;          // 1..100 chars, no leading '#' (ChannelNameSchema in @lobbyforge/core)
  type: 'text' | 'voice' | 'activity' | 'announcement' | 'stage';
  topic?: string;        // ≤ 512 chars
  pluginId?: string;     // ≤ 64 chars, used for 'activity' channels
  position?: number;     // ≥ 0, defaults to max+1
}
```

### Common response shapes

```ts
// Channel JSON (toJson in route.ts)
interface ChannelJson {
  id: string;            // uuid
  serverId: string;      // uuid
  name: string;          // 1..100 chars
  type: 'text' | 'voice' | 'activity' | 'announcement' | 'stage';
  position: number;      // dense, server-scoped
  pluginId: string | null;
  topic: string | null;
  createdAt: string;     // ISO-8601
}
```

### Status codes

| Code | When |
|---:|---|
| 200 | `GET` / `PATCH` success |
| 201 | `POST` success |
| 400 | Body fails zod validation (name starts with `#`, type not in enum, etc.) |
| 401 | Cookie missing or signature invalid |
| 403 | Caller is not a member (reads) or not the owner (mutations) |
| 404 | Server not found, or channel not found, or channel doesn't belong to the URL's server |
| 500 | Drizzle threw (wrapped with a sanitized message) |
| 503 | Cookie has no `uid` (DB not migrated / down) — see "503 contract" below |

### The 503 contract

If the cookie's `gid` has been minted but the `users` row was never materialized (e.g. Postgres was down at mint time and the `findOrCreateGuestUser` retry path failed), the cookie still has a `null` `uid`. M11 routes — like M10 — return **503** with `howToFix: "Re-issue POST /api/auth/guest"`. The fix-the-DB path is "make sure the DB is up, then re-run POST /api/auth/guest" — the second call materializes the row and the existing cookie is replaced.

## Position semantics

A new channel with no explicit `position` lands at `max(position) + 1` for the server. If the server has no channels yet, it lands at `0`. Positions are dense within a server (no gaps unless `PATCH` explicitly sets one), and the `listChannelsForServer` query sorts `position ASC` so the "general" channel is at the top.

`PATCH` can move a channel to a specific `position`, but the route does not renumber siblings — if you insert `position = 1` into `[0, 2, 3]`, you get `[0, 1, 1, 3]`. A future iteration adds a "move and shift" helper (Discord does the shift client-side today; we'll do it server-side when drag-and-drop reordering lands).

## Soft delete

Channels have **no** `deleted_at` column. Server-level soft delete cascades through the `channels.serverId` foreign key (`ON DELETE CASCADE`), removing the channels implicitly. Explicit channel removal is a hard `DELETE`, owner-only.

## DB schema (no delta from M10)

The `channels` table was in the M3 schema; M11 just exercises it. The only Drizzle change is the `position` ordering and the `nextPosition` computation in `createChannel` (described above).

## Query helpers

```ts
// packages/db/src/queries/channels.ts
createChannel(db, { serverId, name, type, position?, topic?, pluginId? })
  // Asserts the parent server exists (not soft-deleted). Computes the
  // next position as max(position) + 1 if `position` is not supplied.

listChannelsForServer(db, serverId, { limit? })
  // Joins servers, filters soft-deleted, sorts by position ASC. Default
  // limit 200, hard cap 500.

getChannelById(db, channelId)
  // Joins servers, filters soft-deleted parents. Returns null if the
  // channel doesn't exist OR its parent server is soft-deleted.

updateChannel(db, channelId, { name?, topic?, position? })
  // Partial update. Empty patch is a no-op that still returns the
  // current row (so the route can return 200 with the current state).

deleteChannel(db, channelId)
  // Hard delete. Cascades through messages / reactions / attachments.
```

```ts
// packages/db/src/queries/memberships.ts
isServerMember(db, userId, serverId): Promise<boolean>
  // Joins users to filter out soft-deleted accounts. The "owner" case
  // is implicit (createServer inserts an owner membership).

getServerMember(db, serverId, userId): Promise<MembershipRow | null>
  // Returns the membership row (with roleId, nickname) or null. Used
  // by future permission checks once roles land.
```

## Testing

`apps/web/app/api/servers/[id]/channels/__tests__/channels.test.ts` covers all five endpoints with `vi.mock` for `@lobbyforge/db` and `@/lib/security-headers`:

| Scenario | Expected status |
|---|---:|
| `GET` without cookie | 401 |
| `GET` for a missing server | 404 |
| `GET` for a server where the caller is not a member | 403 |
| `GET` for a server where the caller is a member, 2 channels returned in order | 200 |
| `POST` with a name starting with `#` | 400 |
| `POST` with an unknown type | 400 |
| `POST` happy path | 201, `createChannel` called with the right `serverId` and `name` |
| `GET /{channelId}` for a missing channel | 404 |
| `GET /{channelId}` for a channel in a different server | 404 |
| `GET /{channelId}` to a non-owner member | 200 |
| `PATCH /{channelId}` by a non-owner | 403 |
| `PATCH /{channelId}` by the owner | 200, `updateChannel` called |
| `DELETE /{channelId}` by a non-owner | 403 |
| `DELETE /{channelId}` by the owner | 200, `deleteChannel` called |

The cookie sent in each request is a real signed `lf_guest` (built via `buildGuestSessionCookie`) so `readGuestSession` sees the production code path.

## Relationship to M10

- `GET /api/servers/{id}` now uses `isServerMember` (not a direct owner-equality check). The M10 test that asserted "non-owner → 403" was renamed to "non-member → 403" and the M10 "owner → 200" test was renamed to "member → 200" (the mock returns `isServerMember = true` regardless of the actual `ownerUserId`).
- `POST /api/servers` still auto-inserts the owner membership (so the owner can immediately `GET /api/servers/{id}/channels` and see the empty list).
- The "membership check" is what unlocks future M11+ endpoints (membership list, invite-redeem, etc.) — the helper is the primitive every other route leans on.

## Out of scope (deferred to later milestones)

- **Messages.** `POST /api/servers/{id}/channels/{channelId}/messages` is **M12 (done)**. See [`docs/MESSAGES.md`](./MESSAGES.md) for the five endpoints, the author-or-owner mutation rule, the soft-delete story, and the out-of-scope list (reactions, attachments, search, plugins, real-time).
- **Voice presence.** "Who is in this voice channel" is M14 (Redis presence layer + LiveKit `RoomServiceClient.listParticipants`). Today's `channel.type === 'voice'` is just a label.
- **Permission checks on `POST /api/servers/{id}/channels`.** Today any member can create a channel. Once roles land with M13, the route gains a `MANAGE_CHANNELS` check; the `hasPermission` call is already in the route as a placeholder.
- **Drag-and-drop reordering.** `PATCH` accepts a new `position` but doesn't renumber siblings. The "move and shift" helper is M14.
- **Bulk create / bulk delete.** A `POST /api/servers/{id}/channels/bulk` endpoint is in the design notes but not implemented; it's a thin wrapper over the existing single-create query.
- **Audit logging.** Channel create / update / delete are not yet logged. The shape is in the route, the audit-log table writes land with M14.
- **Channel-level rate limits.** Today the per-server limit (`channels-create` rate-limit identifier) is shared across all channels in a server. A future iteration namespaces by `(serverId, action)`.
- **Topic edit history.** `topic` is overwritten in place. Discord-like "edited by X at Y" lands when the audit-log integration ships.
- **Activity-channel plugin resolution.** `pluginId` is a string; the actual plugin manifest is loaded server-side at activity-start time (M14).
