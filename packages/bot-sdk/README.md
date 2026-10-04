# @lobbyforge/bot-sdk

The bot contract for LobbyForge:

- `new LobbyForgeBot({ baseUrl, token })` — the **Bot API v2** client:
  slash commands, interaction answers, member lookups, the outgoing event
  endpoint, and the realtime event stream with auto-reconnect (below);
- `verifySignature(…)` / `postToWebhook(…)` — signed HTTPS event
  deliveries and incoming channel webhooks;
- `createBotClient({ baseUrl, token })` — a dependency-free client for the
  Bot API v1 (`getMe`, `listChannels`, `readMessages`, `sendMessage`) with
  typed errors (`BotAuthError`, `BotForbiddenError`, `BotNotFoundError`,
  `BotRateLimitError`, `BotValidationError`, `BotServerError`,
  `BotNetworkError`, all `BotApiError`s);
- `BotPermission` / `BOT_PERMISSIONS` — every permission a bot can hold;
- the shared locale helpers (`tFor`, `loadBotLocale`, `formatMessage`, …),
  also at `@lobbyforge/bot-sdk/locale`.

How bots, tokens, permissions and the Bot API work — with curl examples and a
complete example bot — is in [`docs/BOTS.md`](../../docs/BOTS.md); the v2
contract (routes, events, close codes, signatures) is
[`docs/BOT_API_V2.md`](../../docs/BOT_API_V2.md).

## Bot API v2

Zero runtime dependencies: the global `fetch` and `WebSocket` (browsers,
Node ≥ 22, Deno, Bun) or implementations you pass in
(`new LobbyForgeBot({ fetch, WebSocket })`, e.g. the `ws` package).

### A /roll bot over the event stream

```js
import { LobbyForgeBot } from '@lobbyforge/bot-sdk';

const bot = new LobbyForgeBot({
  baseUrl: process.env.LOBBYFORGE_URL,      // https://chat.example.com
  token: process.env.LOBBYFORGE_BOT_TOKEN,  // lfb_…, shown once in Community Settings → Bots
});

// A bulk overwrite: this list IS the bot's command set.
await bot.commands.set([
  { name: 'roll', description: 'Roll a die',
    options: [{ name: 'sides', description: 'Sides', type: 'integer', min: 2, max: 1000 }] },
]);

bot.on('interaction', async (i) => {
  const sides = i.options.sides ?? 6;
  await i.reply(`${i.user.displayName} rolled ${1 + Math.floor(Math.random() * sides)}`, { ephemeral: false });
});
bot.on('message', (m) => console.info(`#${m.channelId} ${m.author.displayName}: ${m.content}`));
bot.on('disconnect', ({ code, willReconnect, delayMs }) => console.warn(code, willReconnect, delayMs));

await bot.connect(); // resolves on the first `ready`
```

Permissions the bot needs: `receive_events` (the stream), `slash_commands`
(commands and answers), `send_messages` (public answers), `read_messages`
(message events), `read_members` (member events and `members.get`).

**Events** — `on(name, listener)` returns an unsubscribe function:

| event | payload |
|---|---|
| `ready` | `{ bot: { id, name, serverId, permissions }, channels: [{ id, name }] }` (also in `bot.ready`) |
| `message` / `message_update` | `{ id, channelId, content, author: { id, displayName, bot?, webhook? }, createdAt, editedAt, replyToId }` — never the bot's own |
| `message_delete` | `{ id, channelId }` |
| `member_join` / `member_leave` | `{ id, displayName }` (+ `reason` on leave) |
| `interaction` | `{ id, commandName, options, channelId, user, expiresAt, reply(content, { ephemeral }), followup(…) }` |
| `channel_access_changed` | the new `[{ id, name }]` |
| `raw` | every event payload as received |
| `disconnect` | `{ code, reason, willReconnect, delayMs }` |
| `error` | an `Error` — also what a throwing / rejecting listener becomes |

**Reconnects** use exponential backoff with jitter (1 s → 30 s; at least
10 s after `4029`), and a watchdog reconnects a stream that has been silent
for 75 s (the gateway sends a heartbeat every 30 s). These close codes stop
the bot for good and reject `connect()`: `4001` → `BotAuthError` (bad,
rotated or revoked token), `4003` → `BotForbiddenError` (disabled bot or no
`receive_events`; `.permission`), `4009` → `BotApiError` with
`code: 'replaced'` (another connection for this bot took over).
`close()` stops it. Events are at-most-once: after a reconnect, backfill
with `bot.readMessages(channelId, { before })`.

**REST helpers** (all on `/api/bot/v2`): `getMe`, `listChannels`,
`readMessages`, `sendMessage`, `commands.get / set / delete`,
`interactions.respond / followup`, `members.get(userId)`,
`eventEndpoint.get / set(url, { events }) / remove`, `getGatewayUrl`.

### HTTP mode (no socket)

Set an HTTPS endpoint once — the result's `secret` is shown only now:

```js
const { secret } = await bot.eventEndpoint.set('https://bot.example.com/lobbyforge', {
  events: ['interaction_create', 'member_join'],
});
```

Then verify every delivery against the RAW body before trusting it:

```js
import { verifySignature } from '@lobbyforge/bot-sdk';

const ok = verifySignature({
  secret,
  timestamp: req.headers['x-lobbyforge-timestamp'],
  signature: req.headers['x-lobbyforge-signature'],
  body: rawBody,            // the bytes received — not re-serialized JSON
  // toleranceSeconds: 300  // the default replay window (clamped to 1–3600)
});
```

`verifySignature` is synchronous, compares in constant time, rejects
timestamps more than 5 minutes away (`toleranceSeconds` is clamped to 1–3600
seconds; `Infinity` or `NaN` fall back to 300, so a bad value never turns the
replay check off), and never throws. An
`interaction_create` delivery may be answered synchronously with a 200 and
`{ "type": "respond", "content": "…", "ephemeral": false }` within 3 s.

### Incoming webhooks

```js
import { postToWebhook } from '@lobbyforge/bot-sdk';

await postToWebhook(process.env.LOBBYFORGE_WEBHOOK_URL, { content: 'Deploy finished', username: 'CI' });
const message = await postToWebhook(url, { content: 'with the stored message back' }, { wait: true });
```

The webhook URL is the credential — keep it out of logs.

### Examples

```sh
pnpm --filter @lobbyforge/bot-sdk build
LOBBYFORGE_URL=https://chat.example.com LOBBYFORGE_BOT_TOKEN=lfb_… node packages/bot-sdk/examples/roll-bot.mjs
LOBBYFORGE_ENDPOINT_SECRET=whsec_… PORT=8787 node packages/bot-sdk/examples/http-bot.mjs
```

- [`examples/roll-bot.mjs`](./examples/roll-bot.mjs) — `/roll` (public or
  private) and `!roll` over the event stream.
- [`examples/http-bot.mjs`](./examples/http-bot.mjs) — a `node:http`
  endpoint that verifies signatures and answers `/roll` synchronously.
