# Bots

A bot is an identity that belongs to one community (server) and acts on its
behalf: it greets newcomers, keeps chat clean, or connects your own program to
a channel. A bot is never mistaken for a person — everything it posts carries
a **BOT** badge and a robot avatar, and it can only do what its permissions
allow.

- [Concepts](#concepts)
- [Permissions](#permissions)
- [Tokens](#tokens)
- [Bot API v1](#bot-api-v1)
- [Built-in bots](#built-in-bots)
- [Managing bots](#managing-bots)
- [How bots appear](#how-bots-appear)
- [Writing a bot with the SDK](#writing-a-bot-with-the-sdk)
- [Under the hood](#under-the-hood)

## Concepts

| Type | Runs | Credential | Trust badge |
|---|---|---|---|
| `welcome` | inside LobbyForge | none | Official |
| `moderation` | inside LobbyForge | none | Official |
| `custom` | your own program, anywhere | a bot token | Unverified |

- **One server.** A bot row belongs to exactly one server (`bots.server_id`,
  deleted with the server). It can never see or act in another server — a
  channel id from elsewhere is simply "not found".
- **Built-in bots** (Welcome, Moderation) run inside the web app — no extra
  process — but they go through the same permission checks as a custom bot
  and post as bot identities, not as "the system". A server has at most one
  of each.
- **Custom bots** are driven through the [Bot API](#bot-api-v1) with a token.
  A server can have up to 20.
- **Channels.** Bots use text and announcement channels that every member can
  see. A role-gated channel (a private channel) is never available to a bot:
  a bot holds no roles, so there is no way to let it in by accident.
- **No mass pings.** A bot can never mention `@everyone` or `@here`.

## Permissions

Bot permissions are their own list (`BotPermission` in `@lobbyforge/bot-sdk`),
separate from member permissions. No bot permission maps to *Administrator*,
and a bot never goes through the member permission system — a bot cannot
manage roles, members, channels, invites or other bots, whatever it holds.

| Permission | Allows | Honoured by |
|---|---|---|
| `read_messages` | list channels, read recent messages | Bot API v1 |
| `send_messages` | list channels, post messages | Bot API v1, built-in bots |
| `moderate_messages` | filter members' messages | Moderation Bot |
| `join_voice`, `publish_audio` | voice (reserved) | not yet |
| `read_presence` | who is online (reserved) | not yet |
| `manage_game_session`, `manage_music_queue` | activities, music (reserved) | not yet |
| `read_audit_log` | the audit log (reserved) | not yet |

Reserved permissions can be granted today but unlock nothing until the
matching API ships; the settings page marks them *(coming soon)*.

**No escalation.** A member who manages bots (the *Manage Community*
permission) can only give a bot permissions they hold themselves:
`read_messages` needs *Read Message History*, `send_messages` needs *Send
Messages*, `moderate_messages` needs *Manage Messages*, `read_audit_log` needs
*View Audit Log*, `join_voice` / `publish_audio` need *Join Voice Rooms* /
*Speak*, the activity and music permissions need *Start Activities*. The owner
and administrators may grant any of them. Removing a permission, or keeping
one a bot already had, is always allowed.

Built-in bots have a fixed set — Welcome: `send_messages`; Moderation:
`read_messages`, `moderate_messages`, `send_messages` — which the API
re-asserts on every save.

## Tokens

```
lfb_<bot id: 32 hex>_<secret: 43 base64url characters>
```

- **Shown once.** The token is in the response that creates the bot (or
  rotates its token) and nowhere else. The settings page shows it in a dialog
  with a copy button; once the dialog closes it is gone from the page.
- **Stored as a hash.** The database keeps `sha256$<hex>` of the whole token
  (domain-separated). The secret is 256 random bits, so a fast hash is right
  (password hashes are for guessable secrets); comparison is constant-time.
- **Recognisable.** The `lfb_` prefix lets secret scanners and log filters
  spot a leaked token; the embedded bot id lets the server check exactly one
  row.
- **Rotate** (*New token*) issues a new token and the old one stops working
  at once. **Revoke** removes the token; the bot stays but cannot call the
  API. **Deleting** a bot also ends its token. Every one of these is written
  to the audit log (without the token).

If a token leaks, rotate it.

## Bot API v1

Base path: `/api/bot/v1`. Every request authenticates with

```
Authorization: Bot lfb_…
```

— never a cookie, a query parameter or `Bearer`. Only custom bots have tokens.
The API is meant for server-side programs: it sends no CORS headers, needs no
`Origin`, and is not reachable with a member's session.

### Endpoints

| Method | Path | Permission | Returns |
|---|---|---|---|
| `GET` | `/me` | — | `{ bot: { id, name, type, serverId, permissions } }` |
| `GET` | `/channels` | `read_messages` or `send_messages` | `{ channels: [{ id, name, type, position, topic }] }` |
| `GET` | `/channels/{channelId}/messages?limit=50&before=<ISO>` | `read_messages` | `{ messages: [Message] }`, newest first |
| `POST` | `/channels/{channelId}/messages` | `send_messages` | `201 { message: Message }` |

```
Message = {
  id, channelId, content, createdAt, editedAt, replyToId,
  author: { type: 'user', id, name } | { type: 'bot', id, name } | { type: 'unknown', id: null, name: null }
}
```

`limit` is 1–100 (default 50). `before` returns messages older than that
instant, for paging back. A message body is `{ "content": "…" }`, 1–4000
characters, no other fields; leading and trailing whitespace is trimmed.

A bot's message is stored and delivered exactly like a member's — same
table, same realtime fan-out to every open lobby, same `message.create` audit
entry — and is marked as the bot's everywhere it is shown.

### Examples

```sh
TOKEN=lfb_…
BASE=https://chat.example.com/api/bot/v1

curl -s -H "Authorization: Bot $TOKEN" $BASE/me

curl -s -H "Authorization: Bot $TOKEN" $BASE/channels

curl -s -H "Authorization: Bot $TOKEN" "$BASE/channels/$CHANNEL/messages?limit=10"

curl -s -X POST -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"Server restarts in 5 minutes."}' \
  $BASE/channels/$CHANNEL/messages
```

### Errors

Every error is JSON: `{ "error": "<English sentence>", "code": "<code>", …details }`.
Branch on `code`, not on the sentence.

| Status | `code` | Meaning / details |
|---|---|---|
| 400 | `invalid_request` | bad body, `limit` or `before`; `issues: string[]` |
| 401 | `unauthorized` | missing, malformed, revoked or rotated token (`WWW-Authenticate: Bot`) |
| 403 | `bot_disabled` | an admin switched the bot off |
| 403 | `missing_permission` | `permission` names what is missing |
| 403 | `mass_mention_forbidden` | the content mentions `@everyone` / `@here` |
| 404 | `not_found` | channel not in the bot's server, role-gated, or not a text channel |
| 405 | `method_not_allowed` | `allowed` lists the methods |
| 413 | `payload_too_large` | body over 16 KiB |
| 429 | `rate_limited` | `retryAfter` (seconds), `resetAt`; `Retry-After` header |
| 503 | `maintenance` | the instance is in maintenance mode; `message` |
| 500 | `internal_error` | try again later |

### Rate limits

| What | Limit |
|---|---|
| `POST …/messages` | 30 per minute per bot |
| every other endpoint | 60 per minute per bot, each |
| requests presenting a token, per client address | 600 per minute |
| failed authentication, per client address | 30 per minute (then `429`) |

A bot's budget is keyed on the bot itself, so nobody can use it up without
the token. Client addresses are only as reliable as the instance's
`LOBBYFORGE_TRUSTED_PROXY` setting — behind nginx set it to
`x-forwarded-for`, as for the rest of the app.

## Built-in bots

Both are configured in **Community Settings → Bots**, can be renamed, switched
on and off, and post in the instance's language (`LOBBYFORGE_DEFAULT_LOCALE`,
else English) until an admin writes their own text — a bot talks to everyone
at once, so it cannot follow one reader's language.

### Welcome Bot

Greets every new member when they join — by invite, by registering, or by the
lobby's automatic join on an open instance. A returning member is not greeted
again.

| Setting | |
|---|---|
| Channel | any text channel every member can see; default: the first one |
| Greeting | up to 500 characters; `{user}` → the member's name, `{server}` → the server's name |

Names are inserted as plain text with `@` removed, so a member called
"@everyone" cannot turn the greeting into a server-wide ping; a greeting
containing `@everyone` / `@here` is refused when saved. During a raid at most
10 greetings a minute are posted per server. A failed greeting never fails the
join.

### Moderation Bot

Checks every new message — and every edit — before it is stored:

| Rule | |
|---|---|
| Blocked words | one word or phrase per line; whole words only (`ass` does not block `class`); `word*` also blocks longer forms (`salak*` → `salaksın`), `*word` endings, `*word*` anything containing it; a phrase matches consecutive words |
| Links | allow all · block all · allow only listed sites (and their subdomains) |
| Mentions | most `@` mentions in one message (0 = no limit; `@everyone`/`@here` count) |
| Flooding | more than *n* messages in *s* seconds from one member (default 6 in 10 s) |
| Repeats | the same message more than *n* times in *s* seconds (default 3 in 60 s) |

Matching ignores case and is Turkish-aware: every I-form (`I`, `İ`, `ı`,
`i`) counts as the same letter, so a blocked `sik` also catches `SIK`, `SİK`
and `sık`. Invisible characters (zero-width spaces, soft hyphens, bidi
controls) are removed and look-alike forms folded (fullwidth `ｓｐａｍ` →
`spam`) before matching. Other letters keep their marks (`ş` ≠ `s`), so a
blocked `göt` does not block `got`. Links are found with or without
`https://`, including `www.` and bare `name.tld` for common endings — but not
in file names, version numbers or e-mail addresses.

When a message is blocked:

- the member gets `422 { code: "blocked_by_moderation", rule }`; the lobby
  shows a translated reason ("Your message was not sent: it contains a word
  this community does not allow.");
- the audit log gets `bot.moderation.block` — the bot, the rule, what matched,
  the channel, a trimmed excerpt (120 characters) and a SHA-256 of the full
  message;
- optionally (*Post a notice in the channel*) the bot posts a short neutral
  line such as "A message from Alex was blocked by the moderation filter." —
  at most one per member per channel per minute.

The owner, administrators and moderators (*Manage Messages*, *Manage
Community* or *Timeout Members*) are exempt unless the exemption is switched
off. If the bot's settings cannot be loaded, messages are allowed — a filter
outage must not take chat down. Edits are checked by the content rules only;
flooding and repeats count new messages.

## Managing bots

**Community Settings → Bots** (`/admin/settings/bots`) lists the built-in bots
and the custom bots with their BOT badge, trust, and an on/off switch, and
lets the owner create a custom bot, copy its token once, rename it, change its
permissions, issue / rotate / revoke its token and delete it.

The same actions over HTTP (session cookie; the *Manage Community*
permission, except listing):

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/api/servers/{id}/bots` | | every member; settings only for managers; never a token or hash |
| `POST` | `/api/servers/{id}/bots` | `{ name, permissions }` | `201 { bot, token }` — the only time the token is returned |
| `PATCH` | `/api/servers/{id}/bots/{botId}` | `{ name?, enabled?, permissions? }` | built-in permissions cannot change |
| `DELETE` | `/api/servers/{id}/bots/{botId}` | | its messages stay, still marked as a bot's |
| `POST` | `/api/servers/{id}/bots/{botId}/token` | | issue or rotate: `{ bot, token }` |
| `DELETE` | `/api/servers/{id}/bots/{botId}/token` | | revoke |
| `PUT` | `/api/servers/{id}/bots/builtin/{welcome\|moderation}` | `{ enabled?, name?, settings? }` | sets the bot up on first call; settings are merged |

Audit log actions: `bot.create`, `bot.update` (with what changed — for
moderation settings, counts, never the word list), `bot.enable`,
`bot.disable`, `bot.delete`, `bot.token.issue`, `bot.token.rotate`,
`bot.token.revoke`, `bot.moderation.block`, and `message.create` for bot
messages (`metadata.botId`).

## How bots appear

- **Messages:** the robot avatar instead of a person's initial, the bot's name
  and a `BOT` badge ("This is a bot, not a person"). A deleted bot's messages
  keep its name and badge.
- **Members panel:** a *Bots* group lists the enabled bots with the badge;
  clicking one opens its profile — name, BOT, trust, built-in or connected
  through the Bot API, who installed it, and its permissions — with a
  shortcut to the bot settings for managers.
- **Voice:** LiveKit participants whose metadata says `kind: "bot"` (or
  `bot: true`, or whose identity starts with `bot:`) get the BOT badge in the
  room roster.

## Writing a bot with the SDK

`@lobbyforge/bot-sdk` ships a dependency-free client for the Bot API. It
validates input before anything is sent, never follows redirects (so the
token cannot leak to another host), and turns every failure into a typed
error — `BotAuthError`, `BotForbiddenError` (`.permission`),
`BotNotFoundError`, `BotRateLimitError` (`.retryAfter`), `BotValidationError`
(`.issues`), `BotServerError`, `BotNetworkError` — all subclasses of
`BotApiError` with `.status` and `.code`.

A bot that answers `!ping` in the first channel it can use:

```ts
import { BotRateLimitError, createBotClient } from '@lobbyforge/bot-sdk';

const bot = createBotClient({
  baseUrl: process.env.LOBBYFORGE_URL!, // e.g. https://chat.example.com
  token: process.env.LOBBYFORGE_BOT_TOKEN!,
});

const me = await bot.getMe();
const [channel] = await bot.listChannels();
if (!channel) throw new Error(`${me.name} has no channel it may use`);

// Remember what is already there, so old messages are not answered.
const seen = new Set((await bot.readMessages(channel.id, { limit: 50 })).map((m) => m.id));
await bot.sendMessage(channel.id, `${me.name} is online. Say !ping.`);

const poll = async (): Promise<void> => {
  try {
    const recent = await bot.readMessages(channel.id, { limit: 20 });
    for (const message of recent.reverse()) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (message.author.type === 'user' && message.content.trim() === '!ping') {
        await bot.sendMessage(channel.id, `pong, ${message.author.name ?? 'friend'}!`);
      }
    }
    setTimeout(poll, 5_000);
  } catch (error) {
    // Back off exactly as long as the server asks; log anything else.
    if (error instanceof BotRateLimitError) setTimeout(poll, error.retryAfter * 1000);
    else {
      console.error(error);
      setTimeout(poll, 30_000);
    }
  }
};
void poll();
```

Give the bot `read_messages` and `send_messages`. The SDK is part of this
monorepo (`packages/bot-sdk`); `src/client.ts` has no dependencies and can be
copied into a standalone project.

## Under the hood

- **Schema** (migration `0037_bots_runtime`, additive): `bots` gains
  `token_issued_at`, `settings`, `created_by`, `last_used_at`, `updated_at`
  and a partial unique index — one Welcome and one Moderation bot per server;
  `messages` gains `bot_id` (`ON DELETE SET NULL`). A bot message has
  `user_id` NULL, `bot_id` set and a `metadata.bot` snapshot
  `{ id, name, type }`. `metadata.bot` is a reserved key: the messages API
  refuses it from clients, so a member cannot forge a bot message.
- **Code:** `apps/web/lib/bots/` — `token.ts` (format, hash, verify),
  `permissions.ts` / `catalog.ts` (vocabulary, grant rule), `api.ts` (the Bot
  API pipeline on `withMachineApiSecurity`), `messages.ts` (the one path every
  bot uses to read and post), `welcome.ts`, `moderation.ts` +
  `moderation-rules.ts`, `settings.ts`, `cache.ts` (a 15-second per-process
  cache of the built-in bots — the Moderation Bot is consulted on every
  message; admin changes invalidate it at once in the process that made them,
  other processes within 15 seconds).
- **Last activity:** `last_used_at` is written at most once a minute per bot.
