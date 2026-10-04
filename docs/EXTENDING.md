# Extending LobbyForge: bots, plugins and what you can build

For people who run their own LobbyForge instance and want to add bots,
games or tools to it. This guide was checked against the code on
2026-10-03 (`main` at `b8ec691`, branch `fix/security-followups`). Where
another document says something different, the code wins; the
differences are listed in [Appendix A](#appendix-a-docs-that-disagree-with-the-code).

- [1. Quick answers](#1-quick-answers)
- [2. Adding bots](#2-adding-bots)
- [3. Building and installing your own plugin](#3-building-and-installing-your-own-plugin)
- [4. What you can build: capabilities and ceilings](#4-what-you-can-build-capabilities-and-ceilings)
- [5. How LobbyForge differs](#5-how-lobbyforge-differs)
- [6. What's next](#6-whats-next)
- [Appendix A: docs that disagree with the code](#appendix-a-docs-that-disagree-with-the-code)

## 1. Quick answers

**How do I add a bot?** Open **Community Settings → Bots**
(`/admin/settings/bots`). The Welcome and Moderation bots are built in, so
you only switch them on and configure them. For your own bot, create a
*custom bot* on the same page and copy its token (it is shown once). Then
run your program anywhere that can reach your instance over HTTPS. The
program calls `/api/bot/v1` with `Authorization: Bot lfb_…`. See
[§2](#2-adding-bots).

**How do I install my own plugin (game or activity)?** There are two
ways:

- **A: compile it in.** This is the dependable way today. You add
  `plugins/<your-id>/` to your fork, register it in
  `apps/web/lib/plugin-registry.ts`, and rebuild the Docker image. You get
  the full feature set: your own React panel, action policies, and hidden
  state per viewer.
- **B: the marketplace.** This path is off by default and experimental.
  Since ADR-007 the plugin runs sandboxed: its `server.js` in a QuickJS
  WebAssembly VM in the plugin worker, its UI in a sandboxed iframe. It
  gets action policies, `validateAction` and per-viewer hidden state
  (`projectState`), but no Node APIs, imports, storage or timers, and it
  is not listed in the Apps page or the picker
  ([§3.5](#35-path-b-marketplace-dynamic-plugin), [PLUGIN_PUBLISHING.md](PLUGIN_PUBLISHING.md)).

**What is the most I can build?** Server-authoritative activities that run
inside a voice channel. They can be turn-based, or "real-time" at the pace
of a few actions per second for a whole room. Every viewer gets only the
part of the state they are allowed to see. That covers social deduction
games, Taboo-style word games, trivia with server-held answers, synced
YouTube watch parties, polls, buzzers and scoreboards. Bots can read and
post in text channels that every member can see. They cannot use voice,
slash commands, webhooks or events yet. See [§4](#4-what-you-can-build-capabilities-and-ceilings).

**How is this different from Discord?** You run all of it yourself
(AGPL-3.0), and the data never leaves your server. Games and their secrets
are held by your own server, not by a third-party app backend that
Discord proxies to. The trade-off: the bot platform is much thinner than
Discord's (no gateway events, slash commands, webhooks or voice bots).
See [§5](#5-how-lobbyforge-differs).

## 2. Adding bots

### 2.1 The three kinds of bot

| Type | Runs | Credential | Badge |
|---|---|---|---|
| `welcome` | inside the web app | none | Official |
| `moderation` | inside the web app | none | Official |
| `custom` | your program, anywhere | a bot token | Unverified |

Every bot belongs to exactly one community (`bots.server_id`). A channel
id from another community is simply "not found". If you want the same
program in three communities, create three bots with three tokens.
Everything a bot posts carries a **BOT** badge and a robot avatar.

### 2.2 Turning on the built-in bots

1. Open **Community Settings → Bots** (`/admin/settings/bots`). Managing
   bots needs *Manage Community* (`MANAGE_SERVER`, `requireBotManager` in
   `apps/web/lib/bots/admin.ts`).
   Switching the Moderation Bot on also needs *Manage Messages*, unless
   you are the owner (`apps/web/app/api/servers/[id]/bots/builtin/[type]/route.ts:64`).
2. **Welcome Bot:** pick a text channel and a greeting of up to 500
   characters. `{user}` and `{server}` are filled in. It posts at most 10
   greetings a minute per community, so raids do not flood the channel
   (`apps/web/lib/bots/welcome.ts:21`).
3. **Moderation Bot:** blocked words (Turkish-aware matching), a link
   policy, a mention cap, flood rules and repeat rules. It checks every
   member message and every edit before the message is stored.
4. Both bots post in `LOBBYFORGE_DEFAULT_LOCALE` (English if unset) until
   you write your own text.

The full rules are in [BOTS.md → Built-in bots](BOTS.md#built-in-bots).

### 2.3 Connecting your own bot, step by step

**1. Create it.** On the Bots page, create a custom bot with a name of up
to 32 characters and choose its permissions. Only two permissions do
anything today: `read_messages` and `send_messages`
(`BOT_API_PERMISSIONS`, `apps/web/lib/bots/catalog.ts:31`). You can only
grant a permission you hold yourself. For example, `send_messages` needs
*Send Messages* and `read_messages` needs *Read Message History*
(`apps/web/lib/bots/permissions.ts:22`). A community can have up to 20
custom bots (`catalog.ts:47`).

**2. Copy the token.** It looks like `lfb_<bot id, 32 hex>_<43 base64url chars>`.
It is shown once and stored only as a SHA-256 hash. If you lose it, use
*New token* (the old token stops working at once). *Revoke* keeps the bot
but disables its token. Every one of these actions is written to the
audit log.

**3. Test it with curl.**

```sh
TOKEN=lfb_...
BASE=https://chat.example.com/api/bot/v1

curl -s -H "Authorization: Bot $TOKEN" $BASE/me
curl -s -H "Authorization: Bot $TOKEN" $BASE/channels            # pick a channel id
curl -s -H "Authorization: Bot $TOKEN" "$BASE/channels/$CHANNEL/messages?limit=10"
curl -s -X POST -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"Hello from my bot"}' $BASE/channels/$CHANNEL/messages
```

**4. Write the program.** The API is plain HTTPS and JSON, so you can use
any language. Here is a complete Node 22 relay with no dependencies. It
posts to a channel whenever an external status changes, for example your
game server's status:

```js
// status-relay.mjs: node status-relay.mjs
const BASE = `${process.env.LOBBYFORGE_URL}/api/bot/v1`;
const HEADERS = { Authorization: `Bot ${process.env.LOBBYFORGE_BOT_TOKEN}`, 'Content-Type': 'application/json' };
const CHANNEL = process.env.LOBBYFORGE_CHANNEL_ID; // from GET /channels
const STATUS_URL = process.env.STATUS_URL;          // adapt to whatever you watch

async function post(content) {
  const res = await fetch(`${BASE}/channels/${CHANNEL}/messages`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ content }),
    redirect: 'error', // never let the token follow a redirect to another host
  });
  if (res.status === 429) {
    const { retryAfter } = await res.json();
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return post(content);
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.json()).code}`);
}

let last = null;
setInterval(async () => {
  try {
    const status = await (await fetch(STATUS_URL)).json();
    const line = status.online ? `Server is up (${status.players} players)` : 'Server is down';
    if (line !== last) { await post(line); last = line; }
  } catch (err) { console.error(err); }
}, 60_000);
```

With TypeScript, use the SDK client instead ([§2.5](#25-the-bot-sdk)).

**5. Run it.** Run it where it can reach your instance's public URL: a
systemd unit, a cron job, or a container next to the stack. Keep the token
in an environment variable or a secret store. The API sends no CORS
headers and needs no `Origin`. It is meant for server-side programs, so
never put a token in a web page.

**Managing bots over HTTP** (the Bots page calls these):
`POST /api/servers/{id}/bots` `{ name, permissions }` returns
`201 { bot, token }`. You can also send `PATCH` / `DELETE`
`/api/servers/{id}/bots/{botId}`, `POST` / `DELETE` `…/{botId}/token`
(rotate or revoke) and `PUT …/bots/builtin/{welcome|moderation}`.
These routes use a signed-in session cookie (`lf_guest`). The cookie
stops working at most 30 days after sign-in, however often it is
refreshed (`LOBBYFORGE_SESSION_MAX_AGE_DAYS`, `apps/web/lib/session-lifetime.ts`),
so a script that holds one must sign in again. In production these
routes also need an `Origin` header that matches your instance; the CSRF
guard is `originGuard` in `apps/web/lib/security-headers.ts`. There is
no API key for community administration.

### 2.4 Bot API v1 at a glance

Base path `/api/bot/v1`, header `Authorization: Bot <token>` (no
`Bearer`, no cookie, no query parameter; `apps/web/lib/bots/token.ts:65`).

| Method | Path | Needs | Returns |
|---|---|---|---|
| GET | `/me` | none | `{ bot: { id, name, type, serverId, permissions } }` |
| GET | `/channels` | `read_messages` or `send_messages` | text and announcement channels with no role gate |
| GET | `/channels/{id}/messages?limit=1..100&before=<ISO>` | `read_messages` | newest first |
| POST | `/channels/{id}/messages` `{ "content": "…" }` | `send_messages` | `201 { message }`; 1–4000 chars, no other fields |

| Limit | Value | Source |
|---|---|---|
| Posts | 30 / min per bot | `channels/[channelId]/messages/route.ts:96` |
| Every other endpoint | 60 / min per bot, per endpoint | `me`, `channels`, messages GET |
| Requests carrying a token, per client address | 600 / min | `apps/web/lib/bots/api.ts:46` |
| Failed authentication, per client address | 30 / min | `api.ts:48` |
| POST body | 16 KiB | `messages/route.ts:96` |

Every error is `{ error, code, … }`. Branch on `code`, not on the
message: `unauthorized`, `bot_disabled`, `missing_permission`,
`mass_mention_forbidden`, `not_found`, `rate_limited` (with `retryAfter`),
`maintenance` and so on. The full table is in [BOTS.md → Errors](BOTS.md#errors).
Per-address limits are only as accurate as `LOBBYFORGE_TRUSTED_PROXY`.
Behind nginx, set it to `x-forwarded-for`.

**Polling budget.** No events exist yet, so a bot polls. The read limit
applies to the bot across all channels. A bot that watches three
channels can read each one about every 3 seconds.

### 2.5 The bot SDK

`@lobbyforge/bot-sdk` (`packages/bot-sdk`) is `"private": true` and is
**not on npm**. You can use it in two ways:

- Inside your fork of the monorepo, as a workspace dependency.
- Anywhere else, by copying `packages/bot-sdk/src/client.ts` into your
  project. The file has no imports.

```ts
import { BotRateLimitError, createBotClient } from '@lobbyforge/bot-sdk'; // or './client'

const bot = createBotClient({ baseUrl: process.env.LOBBYFORGE_URL!, token: process.env.LOBBYFORGE_BOT_TOKEN! });
const me = await bot.getMe();
const [channel] = await bot.listChannels();
const recent = await bot.readMessages(channel!.id, { limit: 20 }); // newest first
await bot.sendMessage(channel!.id, `${me.name} is online.`);
```

The client checks its input before sending anything, refuses redirects,
times out after 15 s by default, and throws typed errors:
`BotAuthError`, `BotForbiddenError` (`.permission`), `BotNotFoundError`,
`BotRateLimitError` (`.retryAfter`), `BotValidationError`,
`BotServerError` and `BotNetworkError`. A complete `!ping` command bot
is in [BOTS.md → Writing a bot with the SDK](BOTS.md#writing-a-bot-with-the-sdk).

Do not build on `Bot`, `BotEvents`, `onMessage`, `onVoiceJoin` or
`connect()` in `packages/bot-sdk/src/index.ts:37-55`. They are leftover
types with no runtime behind them.

### 2.6 What a bot cannot do today

- **Receive events.** There is no gateway or event stream, so bots poll.
- **Slash commands, buttons, embeds, attachments, reactions, replies,
  editing or deleting its own messages.** `POST …/messages` accepts only
  `content` (`messages/route.ts:16`). `replyToId` can be read but not set.
- **DMs, role-gated channels, voice/stage channels.** A bot holds no
  roles, so role-gated channels stay closed to it. To keep a channel away
  from bots, gate it by role (`packages/db/src/queries/bots.ts:315`).
- **Moderate.** It cannot delete messages, time out, kick or ban.
  `moderate_messages` is honoured only by the built-in Moderation Bot.
- **Mention `@everyone` or `@here`.** These are refused with
  `403 mass_mention_forbidden`.
- **Webhooks or OAuth.** There is no incoming or outgoing webhook and no
  OAuth "add to server" flow.
- **Use the reserved permissions.** `join_voice`, `publish_audio`,
  `read_presence`, `manage_game_session`, `manage_music_queue` and
  `read_audit_log` can be granted but unlock nothing yet.

Note also that bot messages **bypass the Moderation Bot**: only the
mass-mention rule applies to them (`apps/web/lib/bots/messages.ts:164`).
What your bot posts is your responsibility.

### 2.7 Security notes

- A token is a password for the bot. Rotate it on any doubt; the old one
  dies immediately.
- Grant the least you can. The grant rule stops managers from giving a bot
  more than they hold themselves, and no bot permission maps to
  Administrator.
- Members see custom bots as **Unverified**, which is intentional.
- If you write your own client, disable redirects as the SDK does, so
  the `Authorization` header never reaches another host.

## 3. Building and installing your own plugin

### 3.1 How an activity runs

1. A member with *Start Activities* starts an app in a **voice or stage
   channel**. Only one activity can run per channel: the start route
   answers `409` when `getActiveGameSessionForChannel` finds one
   (`apps/web/app/api/servers/[id]/channels/[channelId]/activities/route.ts:152-157`).
   The host calls `createInitialState` and stores the result in
   `game_sessions.state`. The creator becomes the host.
2. The panel (`renderClient`) calls `dispatch(action)`, which sends
   `POST …/activities/{sessionId}/actions`
   (`apps/web/app/api/servers/[id]/activities/[sessionId]/actions/route.ts`).
3. The host then processes the action:
   - It checks membership and channel visibility.
   - It applies the **action policy**: `host`, `member` or `player`.
     Unlisted action types are host-only (`actionPolicyFor`).
   - It overwrites `actorFields` with the caller's id.
   - It runs `validateAction`, then `migrateState`, then your pure
     `handleAction`.
4. Actions on one session run one at a time: the reducer runs and the new
   state is written while the host holds the session's write lock (a
   transaction-scoped Postgres advisory lock, `withGameSessionWriteLock`
   in `packages/db/src/queries/gameSessions.ts`), on the state as it
   stands, so concurrent actions all apply in turn. The write is still a
   compare-and-swap on `revision`, which refuses an ended session. If the
   lock is not granted within 10 s, the answer is a retryable `409`. If
   the reducer returned the *same object*, the action counts as refused:
   the state is still written back, but nothing joins the roster and no
   audit row is written.
5. A change notice goes out on Redis. It carries no state. The SSE route
   and the WebSocket gateway then load the row and **project it per
   viewer** with `projectActivityState`
   (`packages/core/src/activity-projection.ts`) — or, for a marketplace
   plugin, with its own `projectState` in the plugin worker
   (`apps/web/lib/plugin-projection.ts`; the gateway asks the web app).
   Every viewer, host included, gets only what they may see.

### 3.2 The contract (`packages/plugin-sdk/src/index.ts`)

| Field | Required | What it does |
|---|---|---|
| `manifest` | yes | `id` (permanent; see *Choosing an id* below), `name`, `version`, `type` (`game`/`activity`/`utility`), `minAppVersion`, `permissions`, `locales`, `entryClient`, optional `catalog` (picker metadata, player config). `permissions` is declarative only: nothing enforces it today. |
| `actionPolicies` | no | Per action type: `role`, `actorFields`, `joinsRoster`, `audit`. |
| `createInitialState(ctx)` | yes | The initial state. |
| `handleAction(ctx, state, action)` | yes | A synchronous reducer. Return the same object to refuse an action. Randomness and time belong here, on the server. |
| `validateAction(action)` | no | Return an error string (the caller gets a 400) or `null`. The host itself only validates `{ type: string }`. |
| `migrateState(raw)` | no | Runs on every read. It must be idempotent. Version your state. The host awaits it, so a Promise is allowed (marketplace plugins always return one). |
| `renderClient(props)` | yes | Returns a React **element** for the panel. |

**Choosing an id.** The SDK does not check the id, and the routes that
check it disagree:

- Enabling an app and starting an activity (`POST /api/servers/{id}/apps`,
  `POST …/channels/{channelId}/activities`) accept any string of 1–64
  characters.
- Marketplace submit and install accept `[a-z0-9][a-z0-9_-]*`, 2–128
  characters, ignoring case. The installer, the install layout and the
  worker allow the same characters, up to 128 (`PLUGIN_ID_RE` in
  `apps/web/lib/plugin-install-layout.ts` and
  `apps/plugin-worker/src/bundle.ts`), and the plugin-storage proxy wants
  2–128 characters.
- Ids are compared exactly, so `Buzzer` and `buzzer` are two plugins.

Use lowercase letters, digits and hyphens, starting with a letter or
digit, 2–64 characters (`buzzer`, `team-trivia`). That passes every
check. An id longer than 64 characters passes the marketplace and
installs, but it can never be enabled or started.

The **action policy** fields:

- `joinsRoster: true` adds the actor to the visible player list when the
  action changes state. Use it for join or ready actions and for public
  actions, never for anonymous votes.
- `audit` writes an `activity.action` audit row. It defaults to `true`
  for `host` actions and `false` for gameplay. Set it to `false` on any
  host action whose *type* alone gives a secret away (`shouldAuditAction`,
  `index.ts:167`).

**Panel props.** The panel receives `state` (already projected for this
viewer), `dispatch`, `actorUserId`, `hostUserId` and `players`
(`{ userId, name }`, including people in the voice channel). In the lobby
it also receives `cardPacks` (the `PluginSurface` props in
`apps/web/app/lobby/LobbyActivityView.tsx`, lines 299-310 today).

**What `ctx` really provides.** On the HTTP host,
`ctx.players.list()` / `get()` work, and `ctx.storage` is a Postgres
key-value store scoped to one community and one plugin. It is async,
while `handleAction` is sync, so it is good for fire-and-forget writes
only. No official plugin uses it. Several other parts of `ctx` do
nothing (`apps/web/lib/plugin-context.ts:98-160`):

- `ctx.messages.sendGameMessage` only writes to the server log; it does
  not post to chat.
- `ctx.timer`, `cache`, `pubsub`, `votes` and `scores` are empty stubs.
- `ctx.voice.getParticipants()` returns `[]`.

**Timers.** There is no server tick. Store a *deadline* in state, and
let a client send a `time-up` action that the reducer accepts only after
the server clock passes the deadline. Quiz shows the pattern (the
*Timing* note at the top of `plugins/quiz/src/actions.ts`).

### 3.3 Path A: compile your plugin into your image (recommended)

You need Node 22, pnpm 10 (`corepack enable`) and Docker. The steps
assume a fork of `https://github.com/Juanka-e/LobbyForge`.

**Step 1: create the package.** Copy the shape of `plugins/dice-bot`.
Below is a complete minimal plugin called **Buzzer**: the host opens a
round, the first member to buzz wins, and the host resets. This exact
code was type-checked and its tests run against the real
`@lobbyforge/plugin-sdk` sources.

```
plugins/buzzer/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── locales/en.json
└── src/
    ├── constants.ts
    ├── index.ts
    ├── renderClient.tsx
    ├── locales.generated.ts    # written by `pnpm i18n:sync`
    └── __tests__/buzzer.test.ts
```

`package.json`:

```json
{
  "name": "@lobbyforge/buzzer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint \"src/**/*.{ts,tsx}\""
  },
  "dependencies": { "@lobbyforge/plugin-sdk": "workspace:*" },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "@types/react": "^19.2.17",
    "react": "^19.2.7",
    "typescript": "^5.4.5",
    "vitest": "^4.1.11"
  }
}
```

`tsconfig.json` and `vitest.config.ts` (the same as dice-bot's):

```json
{
  "extends": "@lobbyforge/config/tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src", "jsx": "react-jsx", "module": "ESNext", "moduleResolution": "Bundler" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'] },
});
```

`locales/en.json` (put `catalog.summary` here; the activity picker shows
it in the viewer's language):

```json
{
  "catalog.summary": "First to buzz wins the round.",
  "buzzer.title": "Buzzer",
  "buzzer.round": "Round {round}",
  "buzzer.idle": "Waiting for the host to open a round.",
  "buzzer.open": "Open round",
  "buzzer.buzz": "Buzz!",
  "buzzer.reset": "Reset",
  "buzzer.winner": "{name} buzzed first."
}
```

`src/constants.ts` is a separate module so the panel can import the id
without importing `./index`. A cycle would leave the constant
uninitialised.

```ts
export const BUZZER_PLUGIN_ID = 'buzzer';
```

`src/index.ts`:

```ts
import { createElement } from 'react';
import { CATALOG_SUMMARY_KEY, PluginPermission, loadPluginLocale, type GamePlugin } from '@lobbyforge/plugin-sdk';
import { BUZZER_PLUGIN_ID } from './constants';
import { LOCALE_TABLES, SHIPPED_LOCALES } from './locales.generated';
import { BuzzerPanel, type BuzzerPanelProps } from './renderClient';

// The host reads `catalog.summary` on the server, where the 'use client' panel never runs.
loadPluginLocale(BUZZER_PLUGIN_ID, LOCALE_TABLES);

export { BUZZER_PLUGIN_ID } from './constants';
export const BUZZER_STATE_VERSION = 1;

export interface BuzzerState {
  version: number;
  phase: 'idle' | 'open' | 'locked';
  round: number;
  winnerId: string | null;
}

export type BuzzerAction =
  | { type: 'open-round'; hostId: string }
  | { type: 'buzz'; playerId: string }
  | { type: 'reset'; hostId: string };

function initialState(): BuzzerState {
  return { version: BUZZER_STATE_VERSION, phase: 'idle', round: 0, winnerId: null };
}

/** Runs before the reducer: the host itself only checks `{ type: string }`. */
export function buzzerValidateAction(action: unknown): string | null {
  if (typeof action !== 'object' || action === null) return 'Action must be an object.';
  const a = action as Record<string, unknown>;
  switch (a.type) {
    case 'open-round':
    case 'reset':
      return typeof a.hostId === 'string' && a.hostId !== '' ? null : `${a.type} needs hostId`;
    case 'buzz':
      return typeof a.playerId === 'string' && a.playerId !== '' ? null : 'buzz needs playerId';
    default:
      return `Unknown action type: ${String(a.type)}`;
  }
}

export const buzzerPlugin: GamePlugin<BuzzerState, BuzzerAction> = {
  manifest: {
    id: BUZZER_PLUGIN_ID,
    name: 'Buzzer',
    version: '0.1.0',
    type: 'game',
    minAppVersion: '0.2.0',
    permissions: [PluginPermission.MANAGE_GAME_SESSION],
    locales: SHIPPED_LOCALES,
    entryClient: './renderClient.js',
    catalog: {
      category: 'game',
      summary: LOCALE_TABLES.en[CATALOG_SUMMARY_KEY],
      publisher: 'My Community',
      trustLevel: 'unverified',
      playerConfig: { minPlayers: 2, maxPlayers: 50, defaultMaxPlayers: 20, supportsSpectators: true },
      requiresVoiceRoom: true,
      tags: ['party'],
    },
  },
  // Unlisted action types are host-only. The host overwrites actorFields with the caller's id.
  actionPolicies: {
    'open-round': { role: 'host', actorFields: ['hostId'] },
    buzz: { role: 'member', actorFields: ['playerId'], joinsRoster: true }, // public anyway
    reset: { role: 'host', actorFields: ['hostId'] },
  },
  createInitialState: () => initialState(),
  validateAction: buzzerValidateAction,
  migrateState: (raw) => {
    if (!raw || typeof raw !== 'object') return initialState();
    const s = raw as Partial<BuzzerState>;
    if (s.version === BUZZER_STATE_VERSION) return s as BuzzerState;
    return { ...initialState(), ...s, version: BUZZER_STATE_VERSION }; // v0 -> v1
  },
  // Returning the SAME object means "refused": no roster join, no audit row.
  handleAction: (_ctx, state, action) => {
    if (buzzerValidateAction(action) !== null) return state;
    switch (action.type) {
      case 'open-round':
        return { ...state, phase: 'open', round: state.round + 1, winnerId: null };
      case 'buzz':
        if (state.phase !== 'open') return state;
        return { ...state, phase: 'locked', winnerId: action.playerId };
      case 'reset':
        return initialState();
      default:
        return state;
    }
  },
  // Return an ELEMENT. Calling BuzzerPanel(props) directly runs its hooks inside the host (React #310).
  renderClient: (props: unknown) => createElement(BuzzerPanel, props as BuzzerPanelProps),
};
```

`src/renderClient.tsx` is built with the UI kit. Plugin files sit outside
the web app's Tailwind build, so class names would produce no CSS:

```tsx
'use client';

import { detectLocale, loadPluginLocale, pickBestLocale, tFor } from '@lobbyforge/plugin-sdk';
import { ActivityHeader, ActivityShell, Button, Callout, Panel, PhasePill, Row } from '@lobbyforge/plugin-sdk/ui';
import { BUZZER_PLUGIN_ID } from './constants';
import { LOCALE_TABLES } from './locales.generated';
import type { BuzzerAction, BuzzerState } from './index';

loadPluginLocale(BUZZER_PLUGIN_ID, LOCALE_TABLES);

export interface BuzzerPanelProps {
  state: BuzzerState; // already projected for THIS viewer
  dispatch: (action: BuzzerAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  players: Array<{ userId: string; name?: string | null }>;
}

export function BuzzerPanel({ state, dispatch, actorUserId, hostUserId, players }: BuzzerPanelProps) {
  const locale = pickBestLocale(BUZZER_PLUGIN_ID, detectLocale('en'));
  const t = (key: string, params?: Record<string, string | number>) => tFor(BUZZER_PLUGIN_ID, locale, key, params, 'en');
  const isHost = actorUserId === hostUserId;
  const winner = players.find((p) => p.userId === state.winnerId);

  return (
    <ActivityShell>
      <ActivityHeader
        glyph="B"
        title={t('buzzer.title')}
        status={<PhasePill live={state.phase === 'open'}>{t('buzzer.round', { round: state.round })}</PhasePill>}
      />
      <Panel>
        {state.phase === 'idle' ? <Callout>{t('buzzer.idle')}</Callout> : null}
        {state.phase === 'locked' ? (
          <Callout tone="success" role="status">{t('buzzer.winner', { name: winner?.name ?? '?' })}</Callout>
        ) : null}
        <Row wrap style={{ marginTop: 12 }}>
          <Button variant="game" size="lg" disabled={state.phase !== 'open'}
            onClick={() => void dispatch({ type: 'buzz', playerId: actorUserId })}>
            {t('buzzer.buzz')}
          </Button>
          {isHost ? (
            <>
              <Button variant="secondary" onClick={() => void dispatch({ type: 'open-round', hostId: actorUserId })}>
                {t('buzzer.open')}
              </Button>
              <Button variant="ghost" onClick={() => void dispatch({ type: 'reset', hostId: actorUserId })}>
                {t('buzzer.reset')}
              </Button>
            </>
          ) : null}
        </Row>
      </Panel>
    </ActivityShell>
  );
}
```

`src/__tests__/buzzer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import { buzzerPlugin, type BuzzerAction, type BuzzerState } from '../index';

describe('buzzer', () => {
  it('lets the first buzz win and refuses the second', async () => {
    const h = createTestHarness<BuzzerState, BuzzerAction>({ plugin: buzzerPlugin, players: ['host', 'p1', 'p2'] });
    await h.startGame();
    // The harness does not apply actionPolicies: pass the ids the host would inject.
    await h.performAction('host', { type: 'open-round', hostId: 'host' });
    await h.performAction('p1', { type: 'buzz', playerId: 'p1' });
    const afterFirst = h.getState();
    await h.performAction('p2', { type: 'buzz', playerId: 'p2' });
    expect(h.getState()).toBe(afterFirst); // same object = refused
    expect(afterFirst.winnerId).toBe('p1');
  });
});
```

**Step 2: wire it in and test locally.**

```sh
pnpm i18n:sync          # writes plugins/buzzer/src/locales.generated.ts (re-run after editing locales)
# apps/web/package.json -> "dependencies": { "@lobbyforge/buzzer": "workspace:*", ... }
# apps/web/lib/plugin-registry.ts:
#   import { buzzerPlugin } from '@lobbyforge/buzzer';
#   ... registerGamePlugin(buzzerPlugin),            // inside PLUGINS
pnpm install            # links the package AND updates pnpm-lock.yaml: commit it
pnpm build:packages     # @lobbyforge/plugin-sdk resolves from its dist/
pnpm --filter @lobbyforge/buzzer typecheck
pnpm --filter @lobbyforge/buzzer test
pnpm --filter @lobbyforge/web typecheck
docker compose -f infra/docker/docker-compose.dev.yml up -d   # postgres, redis, livekit
pnpm dev                # http://localhost:19520
```

Commit `pnpm-lock.yaml`. The Docker build runs
`pnpm install --frozen-lockfile` (`Dockerfile:8`) and fails if the lock
file is stale. More languages: `pnpm i18n:add <code>` scaffolds a
locale for every plugin ([TRANSLATING.md](TRANSLATING.md)).

**Step 3: add what only core code can do, if you need it.** These hooks
are per plugin id in host code, not in the SDK:

| You need | Edit |
|---|---|
| Hidden information (roles, hands, answers): strip or rewrite it per viewer | add an `if (pluginId === 'buzzer')` branch to `packages/core/src/activity-projection.ts` (used by REST, SSE and the WS gateway). Without it, **every viewer receives the whole state**. |
| Secret content loaded on the server (answers, decks) | `apps/web/lib/prepare-plugin-action.ts` (as Quiz and Hushle do) and a server-only subpath export ([PLUGIN_SDK.md → Server-only subpath exports](PLUGIN_SDK.md#server-only-subpath-exports-m18)) |
| Phase checks before the reducer | `validateActionPhase` in the actions route |
| Built-in content (packs, decks) | `apps/web/lib/component-migrations.ts` |
| An embed other than YouTube | `frame-src` in `apps/web/middleware.ts:66` allows only `https://www.youtube-nocookie.com` |

The WebSocket gateway projects the stored state **without**
`migrateState` (`forwardProjectedActivity` in
`apps/ws-gateway/src/server.ts`). Render older shapes defensively.

**Step 4: build and deploy your image.** On the server, in the checkout
that `install.sh` used:

```sh
# 1. back up first (docs/BACKUP_DRILL.md shows the lfctl backup command)
# 2. get your code
git pull https://github.com/<you>/LobbyForge.git <your-branch>
# 3. use a LOCAL image tag. `lfctl update apply` writes the signed upstream digest into
#    LOBBYFORGE_IMAGE, and compose cannot build onto a digest
grep -q '^LOBBYFORGE_IMAGE=' .env.prod \
  && sed -i 's|^LOBBYFORGE_IMAGE=.*|LOBBYFORGE_IMAGE=lobbyforge-web:custom|' .env.prod \
  || echo 'LOBBYFORGE_IMAGE=lobbyforge-web:custom' >> .env.prod
# 4. build and restart web, ws-gateway, plugin-worker and migrate (they share one image)
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod up -d --build
```

**Step 5: enable it for a community.** Open **Admin → Apps**
(`/admin/apps`), or send `POST /api/servers/{id}/apps`
`{"pluginId":"buzzer","enabled":true}`; this needs *Manage Community*.
Then open **Activities** in a voice channel and pick Buzzer.

**Staying up to date.** Merge upstream into your branch and rebuild with
step 4. Do **not** run `lfctl update apply` against the official
manifest: it deploys the signed upstream image, which does not contain
your plugin. Running sessions of your plugin would then answer
`409 Plugin not registered`. If you want signed updates for your own
build, publish your own manifest and key and use them
(`lfctl update … --manifest <url> --public-key <pem>`, or
`LOBBYFORGE_RELEASE_MANIFEST`).

**Trust.** Compiled-in code runs inside the web process with full
access. The 5 s guard in `plugin-context.ts:218` cannot interrupt
synchronous code, so a looping reducer blocks the server. Review
anything you compile in the way you review your own code.

### 3.4 Choosing a path

| | A: compiled in | B: marketplace (sandbox-v1) |
|---|---|---|
| Language and APIs | TypeScript, React, the whole SDK | plain JavaScript in `server.js`, no imports, no Node APIs |
| Your own UI | a React panel in the app | `ui/` in a sandboxed iframe (no network), postMessage protocol v1 |
| `actionPolicies`, `validateAction` | yes | yes: policies from `manifest.json`, `validateAction` in the sandbox |
| Hidden state per viewer | yes, with a core projection branch | yes, with the plugin's own `projectState` |
| Listed in the Apps page and the activity picker | yes | no: compiled-in lists only (enable and start through the API) |
| Isolation | none (in-process, trusted code) | QuickJS WebAssembly VM per call, inside a hardened container on a network only web joins ([ADR-007](ARCHITECTURE_DECISIONS.md#adr-007-marketplace-plugins-run-sandboxed-supersedes-the-trust-limits-of-adr-001-and-the-target-of-adr-002)) |
| Storage, timers, chat messages | `ctx.storage` (async, unused so far); the rest are stubs | none: the state is the plugin's only memory |
| Install | rebuild the image | owner approves and installs at runtime |
| Status | used by all six official plugins | experimental: unit, route and sandbox tests, no end-to-end test on a running stack |

### 3.5 Path B: marketplace (dynamic) plugin

Since ADR-007 a marketplace plugin runs **sandboxed**, so an instance owner
no longer has to trust its author with the server
([ADR-007](ARCHITECTURE_DECISIONS.md#adr-007-marketplace-plugins-run-sandboxed-supersedes-the-trust-limits-of-adr-001-and-the-target-of-adr-002)).
The full author's guide — bundle format, contract, limits, packing,
migration from the old Node bundles — is
[PLUGIN_PUBLISHING.md](PLUGIN_PUBLISHING.md). This section is the
operator's view.

What exists: a **per-instance** catalog. Users submit an entry, the
instance owner reviews it, and approval downloads the bundle and pins its
SHA-256 and size. Install verifies those bytes, refuses anything but a
`sdk: "sandbox-v1"` bundle (`manifest.json` + `server.js`, optional `ui/`)
whose id and version match the entry, extracts it, and has the
`plugin-worker` load that exact version before recording it as active.

How it runs:

- **Server code** (`server.js`) runs in a QuickJS WebAssembly VM in the
  `plugin-worker` container: plain JavaScript, no `require`/`import`, no
  `process`, file system, network, timers or shared memory, and no host
  functions. Each call gets a fresh WebAssembly instance, 32 MB of VM
  memory, a 256 KiB stack and the call budget (`PLUGIN_CALL_BUDGET_MS`,
  default 2 s). The VM's interrupt can be outrun by one long native
  operation, so calls run in a small pool of executor threads
  (`PLUGIN_SANDBOX_THREADS`, default 2) and a thread that overruns is
  terminated. A runaway plugin fails its call, never the worker.
- **The host's features apply**, as for official plugins: the manifest's
  `actionPolicies` (roles, `actorFields`, `joinsRoster`, `audit`) on the
  actions route — read by the web app from its own copy of the files, so
  plugin code cannot widen them; `validateAction`; a reducer that returns
  its input is a refused action; and `projectState` gives per-viewer
  hidden state on every read path (GET, SSE, the action response, and the
  WebSocket gateway, which asks web through the signed internal
  `POST /api/internal/activity-projection`). Without `projectState` the
  state is public and the lobby says so.
- **UI** (`ui/`) is served from `/api/plugin-ui/{pluginId}/{version}/…`
  into `<iframe sandbox="allow-scripts">` with no network; see
  "Marketplace plugin UI (sandboxed iframe)" in [PLUGIN_SDK.md](PLUGIN_SDK.md).
- **The container** is the outer layer: read-only file system and plugin
  mount, no capabilities, no-new-privileges, 256 MB and 64 pids, no
  secrets except its RPC token (`PLUGIN_WORKER_TOKEN`), and its own
  internal network, `plugin-sandbox`, that only `web` joins — no route to
  Postgres, Redis, LiveKit or the gateway. The worker makes no outbound
  calls.

There is no shared catalog across instances. An entry approved on another
instance (including the official one) does not appear on yours.

Steps:

1. **Turn it on.** Add `LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true` to
   `.env.prod`. `install.sh` already generated
   `LOBBYFORGE_PLUGIN_WORKER_TOKEN`, and compose sets the worker URL and
   the install directory (`LOBBYFORGE_PLUGIN_INSTALL_DIR=/app/plugins/installed`,
   the same value on web and plugin-worker, inside the `plugins-data`
   volume: web writes, the worker mounts it read-only). Then run
   `docker compose … up -d`. Without the worker nothing loads; this fails
   closed (`warmInstalledPlugins` in `apps/web/lib/plugin-loader.ts`).
2. **Build the bundle** (PLUGIN_PUBLISHING.md): `manifest.json`,
   `server.js`, optional `ui/`, packed with
   `examples/plugins/sandbox-buzzer/pack.mjs`, which prints the SHA-256.
   The installer enforces:
   - `./manifest.json` and `./server.js` at the archive root (it extracts
     with `--strip-components=1`); a legacy `index.js` bundle is refused
     with a migration hint;
   - a valid manifest: `sdk: "sandbox-v1"`, id and version equal to the
     catalog entry's, well-formed `actionPolicies` (unknown keys refused),
     `ui/index.html` when `ui: true`;
   - `server.js` at most 2 MiB; regular files only, at most 500 entries,
     10 MB compressed and 50 MB unpacked.
3. **Host the `.tgz`** at a public HTTPS URL. Private, loopback and
   `.local` / `.internal` hosts are refused.
4. **Submit** to your own instance as any signed-in user. There is no
   submit form, only the API:

   ```sh
   curl -X POST https://chat.example.com/api/marketplace/submit \
     -H "Origin: https://chat.example.com" -H "Cookie: lf_guest=…" -H "Content-Type: application/json" \
     -d '{"pluginId":"sandbox-buzzer","name":"Sandbox Buzzer","version":"0.1.0","type":"game","publisher":"Me",
          "manifestUrl":"https://example.org/sandbox-buzzer-0.1.0.tgz"}'
   ```

5. **Approve** as the instance owner: use **Admin → Moderation**
   (`/admin/moderation`), or send `POST /api/marketplace/review`
   `{"pluginId":"sandbox-buzzer","decision":"approved"}` with
   `x-lobbyforge-admin-token: $LOBBYFORGE_ADMIN_TOKEN` plus the `Origin`
   header. Approval downloads the bundle and pins its digest.
6. **Install:** use the **Install** button on `/marketplace`, or
   `POST /api/marketplace/install` `{"pluginId":"sandbox-buzzer"}`.
7. **Enable and start through the API.** The Apps page and picker list
   only compiled-in plugins. Enable with `POST /api/servers/{id}/apps`
   `{"pluginId":"sandbox-buzzer","enabled":true}`, then start with
   `POST /api/servers/{id}/channels/{channelId}/activities`
   `{"pluginId":"sandbox-buzzer"}`.

**Versions and upgrades.** The install directory holds one folder per
version plus a record of the active one
(`apps/web/lib/plugin-install-layout.ts`):

```
<LOBBYFORGE_PLUGIN_INSTALL_DIR>/sandbox-buzzer/0.2.0/manifest.json, server.js, ui/…
<LOBBYFORGE_PLUGIN_INSTALL_DIR>/sandbox-buzzer/active.json   {"version":"0.2.0","digest":"<sha256>",...}
```

- The web app is the only writer. `active.json` names the active version
  and a SHA-256 digest of its files. The loader reads it at boot and
  sends that exact version and digest with every worker call. The worker
  recomputes the digest, keeps the verified `server.js` and manifest in
  memory, and refuses a missing version (404), a mismatch (409) or a
  legacy bundle (422). Nothing picks "the newest folder".
- An upgrade extracts the new version next to the old one. The worker
  loads the new one first; only then is `active.json` rewritten. The old
  folder is deleted right after. If the new bundle is refused, the old
  version stays active and the new folder is removed.
- The record is a file on the volume, not a database row. That way it
  always travels with the files it describes.
- A legacy install (an `index.js` bundle recorded before ADR-007) stays on
  disk but no longer loads; the loader logs why. Install a sandbox-v1
  version of it.

**Still open:**

- No end-to-end test runs this path on a real stack (unit, route,
  gateway and sandbox tests cover it).
- The web app loads the active list once, at boot. If the worker is not
  reachable then, marketplace plugins stay unloaded until web restarts or
  the plugin is reinstalled; while unloaded, their activities' state is
  withheld from viewers rather than sent unfiltered.
- The Apps page and the activity picker do not list marketplace plugins.
- No plugin storage, timers or chat messages in the sandbox;
  `/api/internal/plugin-storage` remains for a future host-mediated
  storage effect.
- A busy plugin can occupy the executor threads for one budget per call
  and slow other marketplace plugins (never official ones).

## 4. What you can build: capabilities and ceilings

### 4.1 Capability matrix

| You want | Today | How |
|---|---|---|
| Turn-based party, board or card games with secret information (werewolf, hidden hands, Taboo) | yes | Path A plus a projection branch (Vampire Village keeps all secrets under `state.secret`), or path B with the plugin's own `projectState` (the sandbox-buzzer example). |
| Trivia with answers that never reach browsers | yes | Path A plus `prepare-plugin-action.ts` (the Quiz pattern) |
| Polls, buzzers, dice, scoreboards, initiative trackers, brackets | yes | Path A |
| Synced playback for the room | YouTube only | The Watch Party pattern (server-stamped timeline). Other players need a CSP change. |
| Rounds with countdowns | yes | Deadline in state plus a `time-up` action. There is no server tick. |
| Fast real-time games (sub-second input) | no | One HTTPS round trip per action, CAS writes, 30 actions/min per IP |
| Games that control voice (mute the eliminated, private night rooms) | no | `ctx.voice` is a stub; see [§6](#6-whats-next) |
| A plugin posting results to chat | no | `ctx.messages` only logs; use a bot that posts instead |
| Data that outlives a session (season leaderboards) | partly | `ctx.storage` (Postgres, per community and plugin); async, unused so far |
| Chat bots: commands, announcements, relays from game servers, RSS, CI | yes | Bot API v1, polling |
| Welcome flows and automod | built in | Welcome and Moderation bots |
| Custom moderation bots (delete, timeout, ban) | no | Bots cannot moderate |
| Music or voice bots, slash commands, buttons, webhooks in or out, OAuth apps | no | Not in the API |
| Mobile apps, federation, E2EE | no | Platform gaps ([SECURITY_REVIEW_2026-10.md](SECURITY_REVIEW_2026-10.md) §8) |

**The unsupported voice escape hatch.** You own the LiveKit API key and
secret, so a program of yours *can* mint a LiveKit token and join a
voice room as a participant, for example a music player built on
LiveKit's server SDK. **This path is unsupported.** It bypasses
LobbyForge's permissions, nothing in the test suite covers it, and you
are on your own. Rooms are named
`s_<serverId without dashes>_c_<channelId without dashes>`
(`liveKitRoomName`, `apps/web/lib/livekit-room.ts:1`). An identity
starting with `bot:` gets a BOT badge in the room view
(`isBotParticipant`, `apps/web/app/room/[roomName]/page.tsx:96`).
LobbyForge's own LiveKit tokens last 10 minutes
(`LIVEKIT_TOKEN_TTL_SECONDS`, `apps/web/lib/livekit.ts`); keep yours
short too.

Get the track source right, or your program locks itself out of voice.
The LiveKit webhook (`apps/web/app/api/livekit/webhook/route.ts`) checks
every published track against the kind/source rule in
`apps/web/lib/voice-track-policy.ts`: audio must use the `microphone` or
`screen_share_audio` source, video `camera` or `screen_share`. LiveKit's
server SDKs publish with source `UNKNOWN` unless you set one, and
`UNKNOWN` fails the rule. When a track fails, the webhook:

- removes the identity from that room and from every other voice room
  of the same community, and writes a `voice.track_rejected` audit row;
- **blocks the identity from that community's voice** for 10 minutes,
  then 30, then 120 for every later offence. The count starts over an
  hour after the last block ends (`apps/web/lib/voice-block.ts`);
- while the block lasts, removes the identity again each time it joins,
  even with a token you minted yourself.

So always publish audio with source microphone, and video with source
camera or screen share.

### 4.2 Ceilings (constants in the code)

| What | Limit | Where |
|---|---|---|
| Activity actions | 30 / min **per client IP**: a LAN party behind one NAT shares it | `activity-action` limit in `actions/route.ts`; IP key from `rateLimitKey` in `security-headers.ts` |
| Concurrent actions | applied one at a time per session; a `409` (clients retry) only when the session's write lock is not granted within 10 s | `GAME_SESSION_LOCK_TIMEOUT_MS` in `packages/db/src/queries/gameSessions.ts` |
| Activity starts | 10 / min per IP; **one running activity per voice/stage channel** | `activities-create` limit and `getActiveGameSessionForChannel` check in `channels/[channelId]/activities/route.ts` |
| Activity reads | GET 60 / min, SSE opens 30 / min per IP; SSE poll fallback 5 s | `activity-get` in `[sessionId]/route.ts`, `activity-stream` in `stream/route.ts`, `POLL_FALLBACK_MS` in `activity-bus.ts:196` |
| Action body | 1 MiB | `DEFAULT_MAX_BODY_BYTES` in `security-headers.ts` |
| State size | no explicit cap. Every action rewrites the whole JSONB and every subscriber reloads and projects it, so keep state in kilobytes. | inferred |
| Players per app | `defaultMaxPlayers` 1–500 | `apps/route.ts:27` |
| In-process reducer | "5 s" guard; ineffective for synchronous loops | `plugin-context.ts:218` |
| Sandbox call (marketplace) | a fresh QuickJS VM per call: 32 MB memory, 256 KiB stack, 2 s budget (`PLUGIN_CALL_BUDGET_MS`) then the executor thread is killed, result ≤ 4 MiB, request ≤ 8 MiB, 1024 random values; 2 executor threads (`PLUGIN_SANDBOX_THREADS`); host RPC timeout 10 s | `SANDBOX_MEMORY_BYTES`, `SANDBOX_STACK_BYTES`, `MAX_RESULT_BYTES`, `callBudgetMs` in `plugin-worker/src/index.ts`; `sandbox-pool.ts`; `RPC_TIMEOUT_MS` in `plugin-worker-client.ts` |
| Bundle | 10 MB download, 50 MB unpacked, 500 entries; `server.js` ≤ 2 MiB, `manifest.json` ≤ 64 KiB | `MAX_BUNDLE_BYTES`, `MAX_TOTAL_BYTES`, `MAX_ENTRIES` in `plugin-installer.ts`; `MAX_SERVER_JS_BYTES` in `plugin-install-layout.ts` |
| Plugin id | 1–64 characters to enable or start; 2–128, `[a-z0-9][a-z0-9_-]*`, for the marketplace | `apps/route.ts:32,38`, marketplace `submit` / `install` routes; see [§3.2](#32-the-contract-packagesplugin-sdksrcindexts) |
| Plugin storage | keys `[a-zA-Z0-9._:-]{1,128}`; worker proxy body 256 KiB, 600 ops/min | `app/api/internal/plugin-storage/route.ts:28,98-99` |
| WebSocket gateway | 10 connections/IP, 64 topics/connection, 256/user, 30 subscribes/min, 64 KB frames | `MAX_CONNECTIONS_PER_IP`, `SUBSCRIBE_RATE_LIMIT_MAX` and `maxPayload` in `ws-gateway/src/server.ts`; `subscriptions.ts:27-28` |
| Bots | 20 custom per community; 30 posts/min/bot; 60/min/bot per other endpoint; 4000 chars; 100 messages per read | §2.4 |

In short, the ceiling is any game or tool a few dozen people play
**together in one voice channel**, where the server alone knows the
truth and each person sees their own slice. It updates at human speed
(seconds), not twitch speed. Bots sit on top as polling integrations
for text channels.

## 5. How LobbyForge differs

Competitor details are as of October 2026, from
[SECURITY_REVIEW_2026-10.md](SECURITY_REVIEW_2026-10.md) §8 and the
platforms' public developer docs. Re-check them before quoting.

| | LobbyForge | Discord | Matrix / Element | Mumble | TeamSpeak | Stoat (Revolt) |
|---|---|---|---|---|---|---|
| Bots | HTTP Bot API v1: read and post in open text channels, polling, one token per bot per community | Gateway event stream plus REST, slash commands, buttons, webhooks, voice bots | Any account can be a bot (sync stream); application services and bridges | Bots connect as clients; the server has an RPC interface | ServerQuery-style automation; client-side bots | Bot accounts with REST plus an event socket |
| In-app games or apps | Plugins run **inside your server**; per-viewer projection hides secrets | Activities: web apps on the Embedded App SDK inside Discord's client; you host the backend, Discord proxies it | Widgets (iframes) in rooms | Client plugins (native, per user) | Client plugins (native, per user) | none |
| Who holds game state | your instance | the app developer's servers | the widget's own backend | n/a | n/a | n/a |
| Self-host | yes | no | yes | yes | server only, closed source | yes |
| License | AGPL-3.0 | proprietary | AGPL-3.0 (+ commercial) | BSD-3 | proprietary | AGPL-3.0 |

- **Ownership.** Accounts are local to the instance; the hub never
  becomes a login for your server ([ADR-006](ARCHITECTURE_DECISIONS.md)).
  Messages, game state and the audit log stay in your Postgres. Nothing
  phones home: no telemetry, and SEO is off by default.
- **The game model.** On Discord, an Activity is someone else's web app
  rendered in Discord's client. Discord itself cannot be self-hosted, and
  hiding secrets is up to each app's backend. In LobbyForge the reducer
  and the per-viewer projection run in *your* server, and the same code
  path serves REST, SSE and WebSocket. A player reading the network tab
  sees only their own slice.
- **Extension ceiling.** Discord's bot platform is far ahead: events,
  commands, components, webhooks, voice and OAuth. Matrix's protocol
  makes every client a potential bot or bridge. LobbyForge's advantage is
  the in-voice game runtime plus easy self-hosting (signed updates,
  backups, Doctor). Its weakest point is the bot platform.

## 6. What's next

These items would raise the ceiling, roughly from most to least impact.
Each points to where it is tracked.

1. **Bot API v2**: an event stream (bot auth on the WebSocket gateway),
   incoming webhooks (game servers, Twitch, GitHub) and slash commands.
   Tracked in [SECURITY_REVIEW_2026-10.md](SECURITY_REVIEW_2026-10.md) §9
   gap #7 (effort M–L).
2. **The reserved bot permissions get APIs**: voice and music (`join_voice`,
   `publish_audio`, `manage_music_queue`; "music bot research" in
   `projectdetails/21_ROADMAP.md` stage 10), `read_presence`,
   `manage_game_session` and `read_audit_log`. Bot ideas such as
   translation, summaries, game host and reminders are in
   `projectdetails/22_BACKLOG_IDEAS.md` §3.
3. **Finishing the marketplace path** ([§3.5](#35-path-b-marketplace-dynamic-plugin)):
   list marketplace plugins in the Apps page and the picker, and add an
   end-to-end test. (Done with ADR-007, 2026-10-03: sandboxed execution,
   `actionPolicies` and `validateAction` from the bundle, per-viewer
   `projectState`.)
4. **A host-mediated storage effect for sandboxed plugins**: data that
   outlives a session (season leaderboards) without giving plugin code
   any I/O. (The sandboxed iframe UI shipped with ADR-007.)
5. **Moving the official plugins' projection and server-hydration hooks
   into the plugins.** Today they are per-id branches in
   `packages/core/src/activity-projection.ts` and
   `apps/web/lib/prepare-plugin-action.ts`; marketplace plugins already
   own theirs (`projectState`). This is a proposal, not yet a tracked item.
6. **Per-plugin workers** (separate containers or UIDs) so one busy
   marketplace plugin cannot slow the others; ADR-007 already removed the
   need for them as a security boundary.
7. **Games that control voice**: a private night room for vampires,
   team voice, listen-only for the eliminated
   ([SECURITY_REVIEW_2026-10.md](SECURITY_REVIEW_2026-10.md) §9
   "Öne çıkaracak fikirler" #1). Server mute already flips LiveKit
   permissions live.
8. **Server-side timers**: `ctx.timer` exists in the SDK but does
   nothing on the host.
9. **Developer tooling**: plugin and bot templates, a local playground
   with mock LiveKit, a CLI generator (`22_BACKLOG_IDEAS.md` §9), and
   publishing through the hub account (ADR-006, amended).

## Appendix A: docs that disagree with the code

| Document | Says | Code |
|---|---|---|
| [PLUGIN_PUBLISHING.md](PLUGIN_PUBLISHING.md) | Plugins run in the host process with no sandbox | They run only in the `plugin-worker` container (`warmInstalledPlugins` in `plugin-loader.ts`). **Fixed 2026-10-03:** doc updated |
| PLUGIN_PUBLISHING.md | The React panel runs client-side | Marketplace plugins have `renderClient: () => null` (ADR-002). **Fixed 2026-10-03:** doc updated |
| PLUGIN_PUBLISHING.md | Approved on the official instance means installable on any instance | The catalog is per instance (`plugin_catalog` in its own DB). **Fixed 2026-10-03:** doc updated |
| PLUGIN_PUBLISHING.md | Externalize `react` and `@lobbyforge/plugin-sdk` | Unresolvable in the worker (no `node_modules` on the install path); bundle everything ([§3.5](#35-path-b-marketplace-dynamic-plugin)). **Fixed 2026-10-03:** doc updated, and the worker's error now says to bundle every dependency |
| PLUGIN_PUBLISHING.md | Submit via `/marketplace` → "Submit a plugin"; enable via the Apps panel | No submit UI exists; the Apps panel lists compiled-in plugins only. **Fixed 2026-10-03:** doc updated |
| [PLUGIN_SDK.md](PLUGIN_SDK.md) | `renderClient: (props) => HushlePanel(props)` | Must return `createElement(Panel, props)` (React #310, see `plugins/dice-bot/src/index.ts`) |
| PLUGIN_SDK.md | `messages.sendGameMessage` posts to the channel | It only writes to the server log (`plugin-context.ts:99-104`) |
| PLUGIN_SDK.md | "What M16 doesn't do": no plugin UI, the panel polls every 2 s | Panels render, and updates arrive over SSE/WebSocket |
| [ACTIVITIES.md](ACTIVITIES.md) | The panel polls every 2 s | SSE/WebSocket push, 5 s poll fallback |
| README | Vampire Village and Watch Party are "planned"; bot-sdk "runtime planned" | Both games ship; the bot SDK has a working HTTP client |
| `POST /api/marketplace/install` error text | "plugins run in-process without isolation" | The worker is mandatory. **Fixed 2026-10-03:** the message now says plugins run only in the plugin-worker, sandboxed in a QuickJS VM (ADR-007) |
| [BOTS.md](BOTS.md) | (accurate) | Add: switching the Moderation Bot on needs *Manage Messages* unless you are the owner |
