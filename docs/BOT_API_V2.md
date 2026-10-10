# Bot API v2 — design contract

Status: **in implementation** (branch `feat/bot-api-v2-marketplace-sandbox`).
This document is the shared contract for everyone building v2: database,
REST, realtime, SDK and UI must match it. When an implementation detail
forces a change, update this file in the same change.

v1 (`/api/bot/v1`: `me`, `channels`, read/post messages, polling) keeps
working unchanged. v2 adds four things, all **scoped per channel**:

1. **Slash commands** — bots register commands; members run them from the
   composer with `/`.
2. **Interactions** — a command run is an interaction the bot answers
   (publicly or only to the invoker).
3. **Event stream** — bots receive events over the WebSocket gateway
   instead of polling.
4. **Webhooks** — incoming (external services post into a channel) and
   outgoing (the instance POSTs a bot's events and interactions to the
   bot's HTTPS endpoint, signed).

## 1. Scoping and permissions

### 1.1 Channel access per bot (`bots.channel_access_mode` + `bot_channel_access`)
- The mode is **stored** on the bot (`bots.channel_access_mode`, `'all'` |
  `'selected'`, default `'all'`):
  - `all` keeps the v1 rule: every text/announcement channel of its server
    that has **no role gate**. Grant rows are not used (switching to `all`
    deletes them).
  - `selected` reaches exactly its `bot_channel_access` rows (still text or
    announcement channels of its own server) — and **no channel at all**
    when it has none left. "No rows" never means "all": a grant row
    cascades away with its channel, and deleting (or revoking) a bot's last
    channel must narrow it, never widen it to every open channel.
  - Anything but the exact `'all'` (an unknown value, a missing bot row) is
    read as `selected`.
- A role-gated channel may be granted only by someone who can see that
  channel AND has `MANAGE_CHANNELS` (owner/administrator always). When a
  channel gets (or changes) a role restriction (`PATCH …/channels/{id}`
  with a non-empty `visibleToRoleIds`), every grant on it whose granter is
  not the owner and does not hold `MANAGE_CHANNELS` at that moment (or who
  left / was banned / deleted their account) is dropped — audited as
  `bot.channel_access` `{ removed: [channelId], reason:
  'channel_restricted' }`, with a `bot-access` invalidation and
  `channel_access_changed` to each bot. A grant that stays through a bulk
  replace keeps its original `granted_by`.
- Deleting a channel: its grants cascade; the route reads the granted bots
  first, then audits `bot.channel_access` `{ removed: [channelId], reason:
  'channel_deleted' }` per bot, publishes `bot-access` per bot and a
  `channel-policy` invalidation for the channel, and drops the fan-out
  cache.
- Every v1/v2 route, every event and every command/interaction check uses
  ONE helper: `botCanAccessChannel(bot, channelId)` in
  `apps/web/lib/bots/access.ts` (and a gateway twin reading the same
  query from `packages/db`).
- As implemented: the rule itself lives in `@lobbyforge/db`
  (`getBotReachableChannel(db, { id, serverId }, channelId)` and
  `listBotReachableChannels(db, { id, serverId })`); the web helper and the
  gateway both call those. The built-in bots go through it too
  (`postBotMessage`), so v1 behaviour for a bot in mode `all` (every bot
  until a manager chooses channels) is unchanged. The fan-out cache and the
  composer list read the mode from the bot row they already load
  (`BotEventTarget.channelAccessMode`, `ServerCommandRow.bot.channelAccessMode`)
  and decide with `botReachesChannel({ mode, granted, channelId,
  openToBots })` — no query per bot.
- Managing access (Manage Community, like every bot setting):
  `GET|PUT /api/servers/{id}/bots/{botId}/channel-access` — PUT
  `{ channelIds: [...] | null }`, mode and rows written in ONE transaction
  (`null` = mode `all`, rows deleted; a list = mode `selected`, exactly
  those, 1..500 — rows not in it deleted, new ones inserted). A mode switch
  with no grant added or removed (`selected` with no channel → `null`) is a
  change too. Response `{ access: { mode: 'all' |
  'selected', channels: [{ id, name, type, position, gated, granted,
  reachable, grantable }], hiddenGrantCount } }`. Only text/announcement
  channels the MANAGER can see are listed; a grant on a private channel
  they cannot see is only counted, and a replace keeps it as it is
  (switching to `null` over such a grant needs Manage Channels: 403
  `cannot_change_hidden_access`). Adding a role-gated channel without
  Manage Channels → 403 `cannot_grant_channel`; a channel that is not an
  eligible, visible text channel → 400 `invalid_channel`.
  `PUT|DELETE …/channel-access/{channelId}` grant / revoke one channel in
  `selected` mode only (409 `access_mode_all` otherwise — one grant would
  silently narrow "every open channel" to one; the grant itself re-checks
  the mode under a row lock on the bot, so a concurrent switch to `all`
  leaves no stray row). Revoking the LAST grant is allowed and leaves the
  bot with no channel (there is no `last_channel_access` refusal any more:
  with the mode stored, two concurrent revokes cannot widen anything).
  Every change: audit `bot.channel_access` `{ mode, added, removed }`, an
  access invalidation `{ kind: 'bot-access', serverId, botId, reason:
  'channel_access_changed' }`, and `channel_access_changed` to the bot's
  endpoint (the gateway re-sends it on the stream).
- The bot admin routes also publish `bot-access` invalidations:
  `permissions_changed` / `enabled_changed` (PATCH), `deleted` (DELETE),
  `token_changed` (token rotate / revoke).

### 1.2 New bot permissions (`@lobbyforge/bot-sdk` `BotPermission`)
| id | needs from the granter (core) | allows |
|---|---|---|
| `slash_commands` | `SEND_MESSAGES` | register commands, receive and answer interactions |
| `read_members` | none | `member_join` / `member_leave` events, member lookups |
| `receive_events` | none | open the event stream / set an event webhook |

Existing ids (`read_messages`, `send_messages`, …) keep their meaning:
message events need `read_messages`; answering publicly needs
`send_messages`. Grants follow `findUngrantableBotPermissions`.

### 1.3 Webhook management
Creating, rotating or deleting a channel's **incoming webhook** needs core
`MANAGE_CHANNELS` (+ seeing the channel). Configuring a bot's **outgoing
event URL** needs the same rights as managing the bot (`requireBotManager`).

## 2. Database (migration `0044_bot_api_v2.sql`)

All new tables cascade on server/bot/channel delete. Secrets are hashed
unless the server must sign with them.

```
bots.channel_access_mode text NOT NULL DEFAULT 'all'
                   CHECK (channel_access_mode IN ('all', 'selected'))  -- §1.1

bot_channel_access(bot_id uuid FK bots, channel_id uuid FK channels,
                   granted_by uuid FK users SET NULL, created_at,
                   PK(bot_id, channel_id))      -- used in 'selected' mode only

bot_commands(id uuid PK, bot_id FK bots, server_id FK servers,
             name text            -- ^[a-z0-9_-]{1,32}$, unique per server
             description text     -- 1..100 chars
             options jsonb        -- ≤ 25 options, see §3.1
             channel_ids jsonb    -- null = every channel the bot can access;
                                  -- else a subset of them
             required_permission text NULL  -- a CorePermission id the
                                  -- INVOKER must hold (e.g. 'kick_members')
             enabled boolean default true,
             created_at, updated_at,
             UNIQUE(server_id, name))

bot_command_overrides(bot_id FK bots CASCADE, name text,  -- the managers'
             enabled boolean NOT NULL default true,       -- switches per
             admin_channel_ids jsonb NULL,                -- (bot, name): they
             updated_by FK users SET NULL, updated_at,    -- outlive the row
             PK(bot_id, name))

bot_interactions(id uuid PK, bot_id FK, command_id FK bot_commands SET NULL,
             server_id FK, channel_id FK, user_id FK users,
             command_name text, options jsonb,
             status text  -- 'pending' | 'answered' | 'expired' | 'failed'
             response jsonb NULL, -- {content, ephemeral}
             created_at, answered_at, expires_at)   -- expires_at = +15 min
             -- indexes: (bot_id, status, expires_at), (user_id, created_at),
             -- (channel_id), (command_id) WHERE command_id IS NOT NULL

channel_webhooks(id uuid PK, server_id FK, channel_id FK,
             name text (1..32), token_hash text  -- sha256$<hex>, token shown once
             enabled boolean default true, created_by FK users SET NULL,
             created_at, last_used_at)

bot_event_endpoints(bot_id uuid PK FK bots, url text (https only, ≤ 512),
             secret text      -- HMAC key the instance signs with (shown once,
                              -- stored because the server must sign)
             events jsonb     -- subset of §4 event names
             enabled boolean, failure_count int default 0,
             disabled_reason text NULL, last_delivery_at, last_status int NULL,
             created_at, updated_at)
```

As implemented (`packages/db/drizzle/0044_bot_api_v2.sql`, expand-only —
six new tables and one added column on `bots` (NOT NULL with a constant
default, so no rewrite and a rollback-safe previous image) — idempotent
(`IF NOT EXISTS` everywhere, `ADD COLUMN IF NOT EXISTS`); queries in
`packages/db/src/queries/bot*.ts` and `channelWebhooks.ts`), with these
additions to the contract above:
- `bots.channel_access_mode` — the stored §1.1 mode (see §1.1).
- `bot_commands.admin_channel_ids jsonb NULL` — the **managers'** channel
  restriction (Admin → Bots → commands). The bot owns `channel_ids`; a
  command runs only where BOTH lists allow it. A bot re-registering its
  commands (`PUT /commands`) never resets `enabled` or
  `admin_channel_ids`, so a bot cannot undo a manager's switch — not even
  with `DELETE /commands/{name}` (or an empty `PUT`) followed by a
  re-register: the admin PATCH writes the row AND
  `bot_command_overrides(bot_id, name)` in one transaction, and a newly
  inserted command takes `enabled` / `admin_channel_ids` from that
  override (defaults only for a name no manager touched). Overrides go
  with the bot.
- `bot_interactions` indexes on `channel_id` and (partial) `command_id`
  for the channel-delete cascade and the command-delete `SET NULL`. No
  `server_id` index: no path deletes by server (servers are soft-deleted;
  a hard delete also cascades through `bots`, whose `bot_id` is indexed).
- `bot_interactions.followup_count int` (CHECK 0..5) — the follow-up cap.
- `channel_webhooks.updated_at`.
- `bot_interactions.user_id` is `ON DELETE CASCADE` (an interaction
  belongs to its invoker); every other user reference is `SET NULL`.
- SQL CHECKs back the app's validation: the access mode, command/option
  (and override) name pattern, description 1..100, ≤ 25 options (array),
  interaction status values,
  webhook name 1..32 and `token_hash ~ '^sha256\$[0-9a-f]{64}$'`, endpoint
  URL `https://…` ≤ 512, secret 32..128 characters.
- No DB-level check ties `bot_commands.server_id` / `bot_channel_access`
  rows to the bot's server; the routes set and check it, and the access
  rule ignores a grant pointing at another server's channel.

## 3. Slash commands and interactions

### 3.1 Command shape (Bot API)
```json
{ "name": "roll", "description": "Roll dice",
  "options": [ { "name": "sides", "description": "Sides", "type": "integer",
                 "required": false, "min": 2, "max": 1000 },
               { "name": "who", "type": "user" },
               { "name": "mode", "type": "string",
                 "choices": [ {"name": "Public", "value": "public"} ] } ],
  "channelIds": null, "requiredPermission": null }
```
Option types: `string` (≤ 1000 chars, optional `choices` ≤ 25),
`integer`, `number` (optional `min`/`max`), `boolean`, `user` (a member
of the server), `channel` (a channel the INVOKER can see). Option names
follow the command name rule; required options first.

### 3.2 Bot API v2 routes (bot token, `Authorization: Bot <token>`)
Base path `/api/bot/v2` (v1 routes stay at `/api/bot/v1`; `/v2/me`,
`/v2/channels`, `/v2/channels/{id}/messages` behave like v1 but honour
§1.1).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/commands` | `slash_commands` | this bot's commands |
| PUT | `/commands` | `slash_commands` | bulk overwrite (≤ 50 per bot); 409 `command_name_taken` if another bot of the server owns a name |
| DELETE | `/commands/{name}` | `slash_commands` | |
| POST | `/interactions/{id}/respond` | `slash_commands` (+ `send_messages` unless ephemeral) | body `{content (1..4000), ephemeral?: boolean}`; once per interaction (409 after); 410 `interaction_expired` after 15 min |
| POST | `/interactions/{id}/followup` | same | more messages for the same interaction within 15 min (≤ 5) |
| GET | `/gateway` | `receive_events` | `{ url }` of the event stream (§4) |
| PUT | `/event-endpoint` / DELETE | `receive_events` | set/remove the outgoing webhook URL; PUT returns the signing secret ONCE |
| GET | `/members/{userId}` | `read_members` | `{ id, displayName, roles[], joinedAt }` |

Rate limits (per bot): commands PUT 5/min, respond+followup 60/min,
other reads 60/min. All responses use the v1 error shape `{error, code}`.

As implemented (`apps/web/app/api/bot/v2/**`, on v1's pipeline in
`lib/bots/api.ts`):
- `/v2/me`, `/v2/channels`, `/v2/channels/{id}/messages` re-export the v1
  handlers (same budgets). A message object may carry two optional extra
  fields (v1 too): `webhook: { id, name }` on an incoming-webhook post
  (its `author` stays `{ type: 'unknown' }`, so v1 clients see no new
  author type) and `interaction: { id, commandName }` on a command answer.
- `GET /commands` → `{ commands: [{ id, name, description, options,
  channelIds, requiredPermission, enabled, createdAt, updatedAt }] }`; it
  also sweeps this bot's overdue interactions to `expired`.
- `PUT /commands` body: the list as a JSON array OR `{ commands: [...] }`
  (exactly that key); ≤ 256 KiB. Validation: names `^[a-z0-9_-]{1,32}$`,
  description 1..100, ≤ 25 options, option names unique, required options
  first, `min`/`max` only on integer/number (integers for integer),
  `choices` (1..25, unique, typed like the option) on string, integer or
  number, `requiredPermission` a CorePermission id, `channelIds` (1..500)
  only channels the bot reaches. Errors: 400 `invalid_request` with
  `issues: ["0.options.1.name: …"]`; 409 `command_name_taken` with
  `names` (nothing is written — also when a concurrent registration wins
  the race). Response `{ commands }`.
- `DELETE /commands/{name}` → `{ ok: true }`; 404 `not_found`.
- `respond` / `followup` → `200 { interaction: { id, status: 'answered',
  followupCount }, message? }` (`message` for a public answer). Codes:
  404 `not_found` (unknown id, another bot's id, or the channel is no
  longer reachable), 409 `interaction_already_answered`, 409
  `interaction_not_answered` (a follow-up needs the respond first), 409
  `followup_limit_reached` (5), 409 `interaction_failed` (also returned —
  and the interaction marked `failed` for good, its stored answer dropped —
  when an EPHEMERAL answer's invoker is no longer a member or can no
  longer see the channel), 410
  `interaction_expired`, 403 `missing_permission` (`slash_commands`, or
  `send_messages` for a public answer), 403 `mass_mention_forbidden`
  (public answers only — an ephemeral one pings nobody). Checks run before
  the atomic claim, so a refused answer never consumes it; a public post
  that fails gives the claim back.
- `GET /gateway` → `{ url }`: `LOBBYFORGE_PUBLIC_BOT_GATEWAY_URL` if set,
  else the realtime URL (`LOBBYFORGE_PUBLIC_WS_URL`) with `/ws/bot`
  (`wss://host/ws` → `wss://host/ws/bot`), else `wss://<host>/ws/bot`
  behind HTTPS / `ws://<host>:19521/ws/bot` on plain HTTP.
- `GET /event-endpoint` (added) → `{ endpoint: {...} | null }`, never the
  secret. `PUT /event-endpoint` `{ url, events? }` → `{ endpoint, secret }`:
  **every PUT issues a new secret** (returned only there; the old one stops
  signing at once) and re-arms a disabled endpoint. `events` ⊆ the §4.2
  names minus `ready`; default = everything the bot's permissions allow.
  A URL that is not https, has credentials, or does not resolve only to
  public addresses → 400 `invalid_endpoint`. PUT/DELETE share 10/min.
  Audit `bot.event_endpoint.set` / `.remove` (host + events, never the
  secret).
- `GET /members/{userId}` → `{ member: { id, displayName, nickname,
  roles: [{ id, name }], joinedAt } }` (roles highest first); 404 for
  anyone who is not a member of the bot's server.

### 3.3 Running a command (member side)
`POST /api/servers/{id}/channels/{channelId}/commands/{commandId}/invoke`
body `{ options: { [name]: value } }` → checks, in order: member can see
the channel and has `SEND_MESSAGES` (timeouts block it), command enabled
in this channel, invoker holds `requiredPermission` (owner bypass), bot
enabled + has `slash_commands` + `botCanAccessChannel`, options validate
against the schema (server-side, never trust the client). Creates a
`bot_interactions` row and delivers `interaction_create` (§4) to the
bot's stream AND its event endpoint (whichever exist). Response `202
{ interaction: { id, status: 'pending' } }`. Rate limit 20/min per user.

`GET /api/servers/{id}/commands?channelId=` → the commands this member
may run in that channel (name, description, options, bot {id,name}) for
the composer's autocomplete.

As implemented:
- invoke answers `202 { interaction: { id, status: 'pending',
  commandName, channelId, bot: { id, name }, expiresAt } }`. Refusals, in
  check order: 401; 403/404 from the channel check (membership,
  visibility, `SEND_MESSAGES`); 403 `timed_out` (`until`); 404
  `command_not_found` (unknown or another server's); 403
  `command_disabled`; 404 `command_not_available` (not allowed in this
  channel by the bot's or the managers' list, or the bot cannot reach the
  channel); 403 `missing_permission` (`permission`); 409 `bot_unavailable`
  (bot disabled, not custom, or without `slash_commands`); 400
  `invalid_options` with `issues: ["<option>: …"]` (unknown names, types,
  ranges, choices, ≤ 1000-char strings, `user` not a member of this
  server, `channel` not visible to the invoker); 422
  `blocked_by_moderation` (`rule`); 409 `bot_offline` (`bot: { id, name }`)
  — nobody is there to answer: the bot has no live event-stream connection
  and no enabled event endpoint subscribed to `interaction_create` (or it
  lacks `receive_events`, which both need). Nothing is written or audited,
  so the member sees "offline" at once instead of a "thinking…" row that
  expires 15 minutes later. A bot WITH such an endpoint keeps the 202 (the
  endpoint is called whether its process is up or not). "Live connection"
  is read from Redis: the gateway subscribes to `lf:{env}:bot-events:{botId}`
  exactly while a connection for the bot is open, so `PUBSUB NUMSUB` on that
  channel counts them (`lib/bots/reachability.ts`); when Redis cannot be
  asked, the run goes ahead as before. 429 `rate_limited` (20/min per
  member, plus 60/min per address).
- "Exactly like member posts" for the Moderation Bot means its CONTENT
  rules (blocked words, links, mentions) run over the free-text string
  options (choice values come from the bot's list); its counting rules
  (flood / repeat) do not — the per-member invoke limit stands in for
  them, so running `/roll` four times is not a "repeat". Bans need no
  extra check: a banned user has no membership.
- Audit `command.invoke` (actor = member, target = bot, with command name,
  channel and interaction id).
- The composer list answers `{ commands: [{ id, name, description,
  options, bot: { id, name, online } }] }`, ordered by bot then name, and hides
  everything the invoke would refuse on the command's side (disabled
  command or bot, missing `slash_commands`, channel restrictions, bot
  access, `requiredPermission` the member lacks). A fixed number of
  queries whatever the number of bots.
- `online: false` means the invoke would answer `bot_offline` right now
  (no live event stream, no endpoint taking `interaction_create`). The
  picker keeps those commands listed after the online bots, greyed out
  under an "Offline" label, and the keys and clicks skip them. Same rule
  and same fail-open as the invoke check, in one endpoint query and one
  `PUBSUB NUMSUB`.
- Managers: `GET /api/servers/{id}/bots/{botId}/commands` → `{ commands:
  [... + adminChannelIds] }`; `PATCH …/commands/{commandId}` `{ enabled?,
  channelIds?: [...] | null }` (the managers' restriction, text channels
  of this server) → `{ command }`, audit `bot.command.update`; the
  resulting state is also kept in `bot_command_overrides` (bot, name), so
  it survives the bot deleting and re-registering the command.

### 3.4 Answers
- **Public** answer → a normal bot message in the channel
  (`messages.bot_id` set) with `metadata.interaction = { id, commandName,
  invokedBy }`; the chat shows "↳ <user> used /<name>".
- **Ephemeral** answer → never stored as a message; kept in
  `bot_interactions.response` and pushed to the invoker only, on the
  gateway topic `user:{uid}` (§4.3). The client shows it inline in that
  channel, marked "Only you can see this", until reload.
- No answer within 15 min → status `expired`; the invoker's pending row
  shows "<bot> did not respond".
- An endpoint delivery (§5.2) may answer synchronously: a 200 response
  body `{ "type": "respond", "content": "...", "ephemeral": true }` within
  3 s counts as the respond call.
- As implemented: the sync answer goes through exactly the respond checks
  (current bot row, `send_messages` for a public answer, once only). A
  public answer stores `metadata.interaction = { id, commandName,
  invokedBy: { id, displayName }, followup? }`. An ephemeral answer is
  published on `lf:{env}:user-events:{uid}` as `{ type:
  'interaction_response', interaction: { id, serverId, channelId,
  commandName, bot: { id, name } }, response: { content, ephemeral: true,
  followup }, at }` — only after re-checking that the invoker is still a
  member (a ban removes the membership) who can see the channel
  (`authorizeChannelMessageAccess`, `mutate`); otherwise nothing is
  published, the interaction becomes `failed` (response cleared) and the
  bot gets 409 `interaction_failed`. A public answer is a channel message
  and is not re-checked against the invoker. Expiry is lazy: an overdue
  pending row turns
  `expired` when answered (410), when its bot lists its commands, and
  when a new command of that bot runs; no `interaction_status` event is
  published (the client times the pending row out at `expiresAt`).
- **Retention** (`pruneBotInteractions`, run with that same sweep — on
  invoke and on `GET /commands` — at most once a minute per bot and
  process): a row past `expires_at` keeps no answer text (`response` →
  NULL; nothing can follow up any more, and an ephemeral answer only lived
  there), and a row more than **24 h past `expires_at`** is deleted (a late
  respond then gets 404 instead of 410). Both statements are scoped to the
  bot and use `idx_bot_interactions_bot_status`. A bot that is never
  invoked and never lists its commands keeps its old rows until it is
  (or until it is deleted — rows cascade with the bot, channel, server and
  invoker).

## 4. Event stream (WebSocket gateway)

Implemented in `apps/ws-gateway/src/bot-gateway.ts`. The wire types live in
`apps/ws-gateway/src/bot-protocol.ts`, and the SDK ships a byte-identical
copy (`packages/bot-sdk/src/gateway-protocol.ts`); a test pins the two
files together.

### 4.1 Connecting
Bots connect to the gateway at **`/ws/bot`** (a separate path; browser
sessions keep `/ws`). No cookie and no Origin are needed on this path
(any Origin is accepted: the token is the only credential). The bot
authenticates EITHER with the upgrade header
`Authorization: Bot <token>` (libraries such as `ws`) OR — because the
standard WebSocket API (browsers, Node's global `WebSocket`) cannot set
headers — by sending `{ "type": "identify", "token": "lfb_…" }` as its
first message within 5 s. If a header is sent, it alone decides (a
malformed one fails). Anything else first, or nothing, closes the
socket with `4001`. The gateway verifies the token like the REST API
(same `sha256$` hash and constant-time compare, a test pins the gateway
copy to `apps/web/lib/bots/token.ts`; custom bot; server not deleted),
then checks bot enabled + `receive_events`, and sends
`{ type: 'hello', ok: true, bot: { id, serverId }, at }` followed at once
by the `ready` event. It subscribes the connection to the bot's own feed
automatically — the bot does not choose topics. One connection per bot
(a new one closes the old with `4009`).

Every refusal sends an error frame first, then closes:
`{ type: 'error', code, message, permission? }` with `code` one of
`unauthorized`, `bot_disabled`, `missing_permission` (+ `permission`),
`replaced`, `rate_limited`, `bad_message`, `internal_error`. Database
errors are never echoed.

**Close codes** (`BotCloseCode`):

| code | meaning | client should |
|---|---|---|
| 1000 | normal close | — |
| 1001 | gateway shutting down | reconnect |
| 1011 | gateway could not reach the database during the handshake/feed setup | reconnect with backoff |
| 4001 | no/invalid token, identify timeout, wrong first message; later: token rotated or revoked, bot deleted | stop |
| 4003 | bot disabled, or lacks `receive_events` (at connect or later) | stop |
| 4009 | replaced by a newer connection for the same bot | stop |
| 4029 | too many failed identifies from this address, too many connects for this bot, or too many messages | back off (SDK: ≥ 10 s) |
| (1006) | terminated after two missed heartbeats — no close frame | reconnect |

**Heartbeat**: every 30 s the server sends a protocol ping AND a
`{ type: 'heartbeat', at }` frame (the standard WebSocket API hides
pings, so SDKs watch for frames); a bot that misses two pongs is
terminated. After identifying, the only message a bot may send is
`{ type: 'ping' }` (answered with `{ type: 'pong', at }`); anything else
gets `bad_message`, and more than 60 messages a minute closes with 4029.

**Limits** (per gateway process, env-configurable):

| What | Default | Env |
|---|---|---|
| `/ws/bot` sockets per address (counted apart from browser sockets; over it the upgrade gets HTTP 429) | 10 | `WS_BOT_MAX_CONN_PER_IP` |
| failed identifies per address per minute (then 4029 before any lookup) | 30 | `WS_BOT_AUTH_FAIL_MAX` |
| successful connects per bot per minute | 30 | `WS_BOT_CONNECT_MAX` |
| identify timeout | 5 s | `WS_BOT_IDENTIFY_TIMEOUT_MS` |
| channels one bot hears | 500 | `WS_BOT_MAX_CHANNELS` |
| events waiting for a DB read per connection (then dropped — at-most-once) | 500 | `WS_BOT_MAX_PENDING_EVENTS` |
| messages a bot may send per minute after identifying (then 4029) | 60 | `WS_BOT_INBOUND_MAX` |

The one-connection rule and these limits are kept in memory per gateway
process. The shipped stacks run one gateway; a deployment with several
gateway replicas behind a load balancer would let a bot hold one stream
per replica until a shared (Redis) registry is added.

**Freshness**: the bot row is re-read and the channel set recomputed on
every `bot-access` invalidation for that bot, on every `channel-policy` /
`server-policy` invalidation in its server, and every 30 s (the periodic
re-authorization sweep, in case Pub/Sub lost an invalidation). A rotated
or revoked token, or a deleted bot, closes with 4001; a disabled bot or a
lost `receive_events` with 4003. A lost `read_messages` /
`read_members` / `slash_commands` just stops those events. If the
database cannot answer during an invalidation, the connection fails
closed: its message subscriptions are dropped until a later recheck
succeeds.

### 4.2 Events (`{ type: 'event', topic: 'bot', data: { event, … }, at }`)
| event | needs | data |
|---|---|---|
| `ready` | — | `{ bot: {id, name, serverId, permissions}, channels: [{id,name}] }` (the §1.1 set) |
| `message_create` | `read_messages` + channel access | `{ message: {id, channelId, content, author:{id, displayName, bot?, webhook?}, createdAt, editedAt, replyToId} }` — never the bot's own messages |
| `message_update` | same | `{ message }` (same shape, `editedAt` set) |
| `message_delete` | same | `{ id, channelId }` |
| `member_join` | `read_members` | `{ member: {id, displayName} }` |
| `member_leave` | `read_members` | `{ member: {id, displayName}, reason? }` (`leave` / `kick` / `ban`) |
| `interaction_create` | `slash_commands` + channel access | `{ interaction: {id, commandName, options, channelId, user:{id,displayName}, expiresAt} }` — forwarded only while the bot still reaches `channelId` (its live channel set; beyond a capped set, one database check) |
| `channel_access_changed` | — | `{ channels }` — sent after every `bot-access` invalidation for the bot, and whenever a policy change or the periodic recheck changes its set |

Message `author`: a member → `{ id, displayName }`; a bot →
`{ id, displayName, bot: true }`; an incoming webhook →
`{ id: <webhook id>, displayName: <username or webhook name>, webhook: true }`;
a deleted user → `{ id: null, displayName: null }`. On the stream
`editedAt` and `replyToId` are always present (null when unset); endpoint
deliveries (§5.2) omit them when null.

Each permission is checked when the event is about to be sent (and again
after any database read), against the bot's latest row. Events are
at-most-once; there is no replay. A bot that reconnects backfills with
`GET /channels/{id}/messages?before=`.

### 4.3 Internal plumbing (web → gateway)
- Message events reuse the chat bus (`apps/web/lib/chat-bus.ts`): the
  gateway subscribes each bot connection to the chat topics of its
  channels on the ONE shared Redis subscriber, treats a bus payload as a
  trigger only, and loads the message by id from the database (content,
  author, deleted state, and that it belongs to the topic's channel)
  before anything is sent. Envelopes it understands:
  `{ type: 'message', message: { id, botId? }, at }` (every new message),
  `{ type: 'message_update', message: { id, botId? }, at }` (a text edit)
  and `{ type: 'message_delete', id, botId?, at }` (a delete), published
  by the single-message route through `publishChatMessageUpdate` /
  `publishChatMessageDelete` in `chat-bus.ts`; `botId` is the AUTHOR bot.
  Browser consumers act only on `type: 'message'`. A delete always names
  the topic's channel, never the publisher's claim.
- Endpoint deliveries of message events do NOT come from the gateway: the
  web app fans them out where messages are created, edited and deleted
  (`emitMessageEvent` in `lib/bots/events.ts`, called by the member
  messages routes, `postBotMessage` and the webhook route). Who listens is
  decided from a per-server cache (enabled custom bots, permissions,
  endpoint, explicit grants: two queries per fill, 15 s, dropped at once
  in the process that changed something) plus at most one role-gate
  lookup per message — never a query per bot. Each queued delivery
  re-reads the bot and re-checks `read_messages` + channel access before
  it is sent, so a stale cache cannot leak a message.
- Access changes publish on `lf:access-invalidation`:
  `{ kind: 'bot-access', serverId, botId, reason }`. Browser
  subscriptions ignore it.
- Interactions and member events publish on Redis channel
  `lf:{env}:bot-events:{botId}` with the §4.2 `data` payload (a payload
  wrapped as `{ data }` is accepted too). The gateway forwards only
  `member_join`, `member_leave` and `interaction_create` from it, so
  `ready`, `channel_access_changed` and message events cannot be injected
  there; an `interaction_create` whose `channelId` is malformed or not
  reachable by the bot any more is dropped.
- A bot in `selected` mode with no grant left has an EMPTY feed (`ready` /
  `channel_access_changed` with `channels: []`), never the v1 rule. A
  gateway running against a database without 0044 (no mode column / grants
  table: Postgres `42703` / `42P01`) applies the v1 rule — the only mode
  that can exist then.
- Ephemeral answers publish on `lf:{env}:user-events:{uid}` and reach the
  browser on the gateway topic `user:{uid}` (subscribe like any topic;
  authorised only when the session uid equals `{uid}`, with no database
  read; no server/channel invalidation revokes it). The payload is
  forwarded verbatim: `{ type: 'event', topic: 'user:{uid}', data, at }`.

## 5. Webhooks

### 5.1 Incoming (channel webhooks)
- Created in channel settings (admin) → URL
  `https://<instance>/api/webhooks/{webhookId}/{token}` (token shown once).
- `POST` JSON `{ "content": "…", "username": "optional display name (≤ 32)" }`
  (a Discord-style subset; unknown fields ignored). `?wait=true` returns
  `{ message }`, else `204`.
- Machine route (`withMachineApiSecurity`, no Origin), 30 posts/min per
  webhook, 4000 chars, `@everyone/@here` refused, the Moderation Bot's
  content rules apply. Messages are stored with `user_id NULL`,
  `metadata.webhook = { id, name, username? }` and render with a
  WEBHOOK badge. A disabled or deleted webhook answers 404.
- As implemented (`app/api/webhooks/[webhookId]/[token]/route.ts`,
  `lib/bots/webhooks.ts`): the token is `lfw_` + 43 base64url characters
  (256 random bits), stored as a domain-separated `sha256$<hex>` and
  compared in constant time. A wrong token, an unknown, disabled or
  deleted webhook, a soft-deleted server and a channel that is gone or no
  longer a text channel all answer the same 404 `not_found`. Limits: 30
  posts/min per webhook (once the token checks out), 120 lookups/min and
  30 failed attempts/min per client address, 16 KiB body. `username` is
  1..32 characters, whitespace collapsed, then refused if it still holds a
  control, invisible-formatting or separator character (`/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u`:
  zero-width characters, bidi embeddings / overrides / isolates
  U+202A–202E and U+2066–2069, U+061C, U+180E, U+FEFF, soft hyphen …) —
  the same rule as a webhook's own name. The token is in the URL path, so
  the shipped nginx config serves `/api/webhooks/` from its own location
  with `access_log off`. Content
  is trimmed, 1..4000. `?wait=true` → `200 { message }` in the Bot API
  message shape (with `webhook: { id, name }`). Every post is audited as
  `message.create` (`webhookId`); a Moderation Bot block is audited as
  `bot.moderation.block` with `targetType: 'webhook'` (content rules only,
  no staff exemption — a webhook has no roles). The `webhook` and
  `interaction` metadata keys are reserved: the member messages API
  refuses them.
- Managing (Manage Channels + seeing the channel; text / announcement
  channels only; ≤ 10 per channel → 409 `webhook_limit_reached`):
  `GET|POST /api/servers/{id}/channels/{channelId}/webhooks` (POST
  `{ name }` → `201 { webhook, token, path, url }` — the only time the
  token is returned), `PATCH|DELETE …/webhooks/{webhookId}`
  (`{ name?, enabled? }`), `POST …/webhooks/{webhookId}/token` (rotate →
  `{ webhook, token, path, url }`; the old URL stops at once). The URL's
  origin is `LOBBYFORGE_APP_ORIGIN`, else `NEXT_PUBLIC_BASE_URL`, else the
  request's (checked) Origin. Audit `webhook.create`, `webhook.update`,
  `webhook.enable`, `webhook.disable`, `webhook.token.rotate`,
  `webhook.delete` — never the token.

### 5.2 Outgoing (bot event endpoint)
- HTTPS only; the URL is checked with the IP-pinned SSRF transport
  (`apps/web/lib/ip-pinned-https.ts`) — private, loopback, link-local and
  metadata addresses are refused at save time AND at delivery time.
- Each delivery: `POST <url>` with body `{ id, event, timestamp, data }`
  and headers
  `X-LobbyForge-Event`, `X-LobbyForge-Delivery` (uuid),
  `X-LobbyForge-Timestamp` (unix s),
  `X-LobbyForge-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`.
  Receivers must reject timestamps older than 5 min (SDK does).
- Timeout 3 s, 3 attempts with backoff (1 s, 5 s, 30 s) for 5xx/timeouts;
  after 20 consecutive failures the endpoint is disabled
  (`disabled_reason`) and the bot manager sees it in the admin UI.
- Interactions are delivered first and may be answered synchronously
  (§3.4).
- As implemented (`lib/bots/event-delivery.ts`):
  - the secret is `whsec_` + 43 base64url characters; the HMAC key is that
    string as UTF-8. `body.id` equals `X-LobbyForge-Delivery` and
    `body.timestamp` equals `X-LobbyForge-Timestamp`; retries resend the
    IDENTICAL bytes (same id, timestamp, signature) so a receiver can
    dedupe on the id;
  - "3 attempts with backoff (1 s, 5 s, 30 s)" = the first attempt, then
    up to three retries after 1 s, 5 s and 30 s (≈ 36 s in all, inside the
    5-minute window). Retried: timeouts, network errors, 408, 429, 5xx.
    Final at once: any other status, and a host that now resolves to a
    private address (the rebinding case — refused, not retried). A
    delivery that ends in failure counts ONCE; a success resets the
    counter; the 20th consecutive failure sets `enabled = false`,
    `disabled_reason = 'too_many_failures'` and is audited
    (`bot.event_endpoint.disable`). Managers: `GET|PATCH|DELETE
    /api/servers/{id}/bots/{botId}/event-endpoint` (status without the
    secret; PATCH `{ enabled: true }` re-enables and resets the counter;
    audit `bot.event_endpoint.enable` / `.remove`);
  - every attempt re-resolves DNS, refuses private / loopback /
    link-local / CGNAT / ULA / metadata addresses and pins the connection
    to the addresses it checked; redirects are never followed; the answer
    is read up to 64 KiB;
  - the queue is in-process (16 deliveries in flight, 2 000 waiting,
    interactions first) and NOT durable: deliveries waiting for a retry
    are lost when the web process restarts (events are at-most-once);
  - before the first attempt the current bot row is re-read: still
    enabled, still `receive_events`, the endpoint still enabled and
    subscribed, plus the event's own check (message events:
    `read_messages` + channel access; member events: `read_members`;
    interactions: `slash_commands` + channel access). A retry is dropped
    if the endpoint was switched off or its URL/secret replaced.

## 6. SDK (`@lobbyforge/bot-sdk` v2)
```ts
const bot = new LobbyForgeBot({ baseUrl, token });
await bot.commands.set([{ name: 'roll', description: 'Roll dice', options: [...] }]);
bot.on('interaction', async (i) => i.reply(`🎲 ${roll(i.options.sides ?? 6)}`, { ephemeral: false }));
bot.on('message', (m) => { /* ... */ });
await bot.connect();                         // event stream with auto-reconnect
// HTTP mode instead of a socket:
const ok = verifySignature({ secret, timestamp, body, signature });
// Incoming webhook helper:
await postToWebhook(url, { content: 'Deploy finished' });
```
Zero runtime dependencies: it uses the global `fetch` and `WebSocket`
(browsers, Node ≥ 22) with the `identify` message, or implementations
passed in (`new LobbyForgeBot({ fetch, WebSocket })` — e.g. the `ws`
package). v1's `createBotClient` is unchanged.

As implemented (`packages/bot-sdk/src/bot.ts`, `signature.ts`,
`webhook.ts`):
- **REST (v2 base)**: `getMe` / `listChannels` / `readMessages` /
  `sendMessage`; `commands.get()`, `commands.set(list)` (sends
  `PUT /commands` with `{ commands: [...] }`, validated client-side:
  names, 1–100 char descriptions, ≤ 25 options, ≤ 50 commands, no
  duplicates), `commands.delete(name)`; `interactions.respond(id,
  content, { ephemeral })` / `.followup(...)`; `members.get(userId)`
  (unwraps `{ member }`); `eventEndpoint.get()` / `.set(url, { events })`
  (returns `{ endpoint, secret }` — the secret once) / `.remove()`;
  `getGatewayUrl()`. Same typed errors as v1, no redirects, 15 s timeout.
- **Stream**: `connect()` discovers the URL with `GET /gateway` (or uses
  `gatewayUrl`; falls back to `<baseUrl>/ws/bot` on a 404; an https
  instance never gets a `ws://` stream), sends `identify`, and resolves
  on the first `ready`. It keeps retrying through network failures and
  rejects only on a fatal close — 4001 → `BotAuthError`, 4003 →
  `BotForbiddenError` (`.permission`), 4009 → `BotApiError` with
  `code: 'replaced'` — or after `reconnect.maxAttempts`. Reconnects use
  exponential backoff with "equal jitter" (initial 1 s, cap 30 s; at
  least 10 s after a 4029); the attempt counter resets on `ready`. A
  watchdog reconnects when no frame (event, heartbeat, pong) arrived for
  75 s (`heartbeatTimeoutMs`). `close()` closes with 1000 and stops.
- **Events** (`on()` returns an unsubscribe): `ready` `{ bot, channels }`,
  `message`, `message_update`, `message_delete`, `member_join`,
  `member_leave`, `interaction` (with `reply(content, { ephemeral })` and
  `followup(...)` bound to its id), `channel_access_changed`, `raw` (every
  event payload), `disconnect` `{ code, reason, willReconnect, delayMs }`,
  `error`. A listener that throws or rejects becomes an `error` event.
  `bot.ready` holds the latest bot + channel list.
- **`verifySignature({ secret, timestamp, body, signature,
  toleranceSeconds = 300, now? })`** is SYNCHRONOUS (a Promise would be
  truthy inside `if (…)`), constant-time, accepts a comma-separated list
  of `v1=` signatures, rejects timestamps more than the tolerance away in
  either direction, and never throws. `toleranceSeconds` is clamped to
  1..3600 (`0` / negative → 1 s, larger → 1 hour); a non-finite value
  (`Infinity`, `NaN`) or a non-number falls back to 300 — a bad setting can
  narrow the replay window, never switch it off. `body` is the raw request (string,
  `Uint8Array` or `ArrayBuffer`). SHA-256/HMAC are implemented in the SDK
  (pinned to `node:crypto` by tests); `signPayload` produces the header.
- **`postToWebhook(url, { content, username? }, { wait?, fetch?,
  timeoutMs? })`** → `null` (204), or the stored message with `wait: true`.
- The protocol types (`BotEventData`, `BotFeedMessage`, `BotCloseCode`, …)
  are exported from the package root.

Ships two examples under `packages/bot-sdk/examples/`: `roll-bot.mjs`
(a `/roll` command and `!roll` over the socket) and `http-bot.mjs` (a
`node:http` endpoint that verifies signatures and answers interactions
synchronously). Both turn every refusal into one line a person can act on
(`/roll is already registered by another bot on this server — pick another
name` for `command_name_taken`, a revoked token, a missing permission, a
port in use) instead of a stack trace, and exit 1 on anything fatal —
including, for `roll-bot.mjs`, a stream the gateway closed for good after
it was running (4001 token rotated/revoked, 4003 disabled, 4009 another
copy took over), where a bot would otherwise just stop with exit 0 — and 0
only after Ctrl+C / SIGTERM.

## 7. UI
- Composer: typing `/` opens a command picker (keyboard accessible,
  grouped by bot), then option fields; submit calls §3.3; a pending
  "<bot> is thinking…" row is shown to the invoker only.
- Messages: "↳ used /cmd" header on interaction answers, WEBHOOK badge,
  ephemeral answers with "Only you can see this · Dismiss". A desktop /
  browser notification cannot show a badge, so its title carries the cue:
  "<name> (WEBHOOK) in #channel" / "<name> (BOT) in #channel"
  (`lobbyMain.chat.notificationTitleWebhook` / `…TitleBot`).
- Admin → Bots: per bot — permissions incl. the new ones, channel access
  (all eligible / chosen channels), registered commands (read-only list,
  enable/disable per command, channel restriction), event endpoint
  status (URL, last delivery, failures, re-enable).
- Admin → Channels: per text channel — incoming webhooks (create, copy
  URL once, rotate, disable, delete).
- Everything themed (Tailwind tokens), en + tr.

### 7.1 How the browser uses the routes
Every path and payload the UI reads is in one module,
`apps/web/lib/bots/client-api.ts` (parsed defensively; errors shown by
`code`, never the English `error`).
- The composer loads `GET /api/servers/{id}/commands?channelId=` the first
  time `/` is typed in a channel and caches it per channel for a minute; a
  refusal that means the list is stale (`command_not_found`,
  `command_disabled`, `command_not_available`, `bot_unavailable`,
  `missing_permission`) drops that cache. `invalid_options` marks the
  fields named in `issues` (`"<option>: …"`).
- The pending row lives in browser memory (`lib/bots/interaction-store.ts`)
  and turns into "<bot> did not respond" at the 202's `expiresAt`; no
  server event is needed for that. It resolves on a chat message whose
  `metadata.interaction.id` matches, or on `user:{uid}` data
  `{ type: 'interaction_response', interaction: { id, serverId, channelId,
  commandName, bot: { id, name } }, response: { content, ephemeral: true } }`.
  An optional `{ type: 'interaction_status', interaction: { id, status:
  'expired' | 'failed' } }` is honoured if the server ever sends one.
- The chat only draws the "↳" header on a BOT message and the WEBHOOK badge
  on a message with no user and no bot, whatever the metadata claims.
- Admin → Bots calls `GET|PUT …/bots/{botId}/channel-access` (PUT
  `{ channelIds: [...] | null }`), `GET …/bots/{botId}/commands` +
  `PATCH …/commands/{commandId}` (`{ enabled?, channelIds? }` — the
  managers' restriction), `GET|PATCH …/bots/{botId}/event-endpoint`
  (`{ enabled: true }` re-enables). Admin → Channels calls
  `GET|POST …/channels/{channelId}/webhooks`, `PATCH|DELETE
  …/webhooks/{webhookId}` and `POST …/webhooks/{webhookId}/token` (rotate).

## 8. Security checklist (must hold)
- Every bot-reachable path goes through `botCanAccessChannel`.
- Interaction ids are unguessable (uuid) AND bound to the bot: another
  bot's token gets 404.
- Option values are validated server-side; `user`/`channel` options are
  re-checked (member of the server / channel visible to the invoker).
- Webhook tokens and bot tokens are stored hashed; event-endpoint secrets
  are stored (needed to sign) and never returned after creation.
- Outgoing deliveries never reach private networks (save + delivery
  checks, no redirects).
- No event ever carries a message from a channel the bot cannot access.
- Commands and webhook posts obey timeouts, bans, slow paths and the
  Moderation Bot exactly like member posts.
