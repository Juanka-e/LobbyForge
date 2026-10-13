# Plugin SDK

The `@lobbyforge/plugin-sdk` package is the contract between the web app
(plugin host) and the plugins in `plugins/*`. It exports:

- The `GamePlugin` / `RegisteredGamePlugin` / `GamePluginContext` /
  `PluginManifest` / `PluginPermission` types every plugin or host registry
  uses.
- The `registerGamePlugin` helper that erases a strongly typed plugin into the
  host-side registry shape without exposing `any` at every call site.
- The `createTestHarness` test helper (subpath export `@lobbyforge/plugin-sdk/testing`)
  that gives a plugin test a fully-mocked context so the plugin's
  reducer can be exercised in isolation — effects and timers included.
- Host effects: `withEffects` and the rules the host applies to what a
  reducer asks for — timers, storage, chat
  ([Effects](#effects-timers-storage-and-chat)).

This document covers the SDK's surface, the `GamePlugin` contract, and
how to author a new plugin. The HTTP host side (the routes that
dispatch actions to the plugin) is documented in [`docs/ACTIVITIES.md`](./ACTIVITIES.md).

## Exports

```ts
import {
  PluginPermission,
  type PluginManifest,
  type PlayersSubContext,
  type MessagesSubContext,
  type StateSubContext,
  type CacheSubContext,
  type PubSubSubContext,
  type TimerSubContext,
  type VotesSubContext,
  type ScoresSubContext,
  type VoiceSubContext,
  type GamePlugin,
  type RegisteredGamePlugin,
  type GamePluginContext,
  type GamePluginHostChange,
  registerGamePlugin,
  // Host effects (see "Effects: timers, storage and chat"):
  withEffects,
  EFFECT_PERMISSIONS,
  EFFECT_LIMITS,
  type PluginEffect,
  type ReducerResult,
  type StorageSnapshot,
  CATALOG_SUMMARY_KEY,
  CATALOG_NAME_KEY,
  // M19 shared locale helper (also exported from the
  // @lobbyforge/plugin-sdk/locale subpath for callers who want
  // the import path to scream "this is locale code"):
  tFor,
  loadPluginLocale,
  registerPluginLocale,
  replacePluginLocale, // the host, for a marketplace bundle's locales/
  listPluginLocales,
  detectLocale,
  pickBestLocale,
} from '@lobbyforge/plugin-sdk';

// Test helper (subpath export):
import { createTestHarness, type TestHarnessOptions } from '@lobbyforge/plugin-sdk/testing';

// Marketplace plugin UIs in the sandboxed iframe (subpath export, no React,
// no dependencies) — see "Marketplace plugin UI (sandboxed iframe)":
import { connect, type FrameInitMessage } from '@lobbyforge/plugin-sdk/frame';
```

The `PluginPermission` constant is an enum-like object whose values
are short lowercase strings. Four of them are enforced: `timers`,
`storage`, `chat` and `voice.mute` (reserved) are the permissions the host
checks before it applies an effect
([Effects](#effects-timers-storage-and-chat)). The others
(`read_room_participants`, `send_room_message`, `manage_game_session`, …)
describe what a plugin does and grant nothing.

## Manifest fields for app catalog

The SDK manifest is also the source for the official App Catalog.
`manifest.catalog` exposes enough product metadata for lobby and registry UI
without letting the registry read private instance state:

```ts
type PluginCatalogMetadata = {
  category?: "game" | "bot" | "integration" | "utility";
  summary?: string;
  publisher?: string;
  trustLevel?: "official" | "verified-community" | "unverified";
  playerConfig?: {
    minPlayers?: number;
    maxPlayers?: number;
    defaultMaxPlayers?: number;
    supportsSpectators?: boolean;
    supportsQueue?: boolean;
    overflowPolicy?: "spectator" | "queue" | "split" | "reject";
  };
  requiresVoiceRoom?: boolean;
  externalAccountRequired?: boolean;
  externalAccountProvider?: string;
  compatibleAppVersion?: string;
  tags?: string[];
};
```

`requiresVoiceRoom` is enforced, not just shown: a game that declares it is
played over voice, so the host refuses a `member` / `player` action from
anyone who is not in the activity's voice room (403, `code:
'voice_required'`) and hands hosting over when the host leaves the room —
see [Voice, hosting and play again](#voice-hosting-and-play-again). Poll and
Dice Bot declare `false`: anyone who can see the channel takes part.

`externalAccountRequired` means the app needs an explicit account-linking
flow for a third-party service. It must not silently replace instance auth.
The host still authorizes the user through the local instance session and
then lets the app request a scoped external connection when needed.

Official plugins should fill `publisher`, `trustLevel`, `playerConfig`,
`requiresVoiceRoom`, and `tags`. The `/api/plugins` listing returns this
catalog metadata alongside the stable `id`, `name`, `version`, and `type`.

## The `GamePlugin<TState, TAction, TProps>` contract

```ts
interface GamePlugin<TState = unknown, TAction = unknown, TProps = unknown, TReturn = TState> {
  manifest: PluginManifest;
  actionPolicies?: Record<string, GamePluginActionPolicy>;
  createInitialState: (ctx: GamePluginContext<TState>) => TReturn;
  handleAction: (ctx: GamePluginContext<TState>, state: TState, action: TAction) => TReturn;
  validateAction?: (action: unknown) => string | null;
  restartActions?: readonly string[];
  onHostChange?: (state: TState, change: GamePluginHostChange) => TState;
  migrateState?: (raw: unknown) => TState;
  renderClient: (props: TProps) => ReactNode;
}
```

- `manifest.id` is the stable string the registry, the database, and
  the audit log all key on. It must match `[a-z0-9-]{1,64}` and be
  unique across `PLUGINS`.
- `createInitialState(ctx)` is called by the host when an activity
  starts. The returned value is the row's initial `state` JSONB.
- `handleAction(ctx, state, action)` is a pure reducer. The host
  calls it from the `actions` route; the return value is what
  `setGameSessionState` writes. Most plugins (quiz included) treat
  this as a `switch (action.type)` and never touch `ctx` — the SDK
  shape is the same for HTTP and voice-room hosts.
- `TReturn` is what both reducers return: the state by default. A plugin
  that asks the host for effects declares `ReducerResult<TState>` and
  returns `withEffects(next, effects)` where it needs them
  ([Effects](#effects-timers-storage-and-chat)).
- `restartActions` lists a game's "play again" actions (Hushle
  `start-game`, Quiz `play-again`). Declaring it turns on the host's
  ended-phase guard: once `state.phase === 'ended'`, only these action
  types reach the reducer; every other one is refused with 409 (`code:
  'session_ended'`). Leave it undefined when the reducer should decide
  everything after the end (Vampire Village keeps its post-game chat and
  its own `play-again`). See [Voice, hosting and play again](#voice-hosting-and-play-again).
- `onHostChange(state, change)` is called when the host hands the session
  to someone else because its host left the voice room. Pure, like the
  reducer: return the state with the plugin's own notion of "host"
  updated, or the same object. Most plugins need nothing here — the
  panel's `hostUserId` and the `host` policy follow the session host on
  their own. Watch Party, which keeps a party host in its state, uses it.
- `migrateState(raw)` (M19+) is the migration seam. The host runs
  it on every read against `game_sessions.state`; whatever the
  function returns is what the reducer + `renderClient` see. The
  function must be **idempotent** — the same blob may be re-read
  many times. When the plugin's state shape evolves, the plugin
  author adds a new step to the migrator chain and bumps the
  internal `version` field; the next read automatically upgrades
  old sessions in the database. The Hushle reducer is the worked
  example — see `migrateHushleState` in `plugins/hushle/src/state.ts`.
- `renderClient(props)` is the React component for the activity
  panel. M17 wires this from the voice room's `ActivityPanel` — see
  [Per-plugin renderClient](#per-plugin-renderclient) below for the
  props contract and the worked example (`plugins/hushle/src/renderClient.tsx`).

## Registry adapter

Plugin packages should export a strongly typed `GamePlugin<TState, TAction,
TProps>`. A host catalog, however, stores many different plugins in one list.
Use `registerGamePlugin()` at the catalog boundary:

```ts
import { registerGamePlugin, type RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { quizPlugin } from '@lobbyforge/quiz';

export const PLUGINS: readonly RegisteredGamePlugin[] = [
  registerGamePlugin(quizPlugin),
] as const;
```

`RegisteredGamePlugin` keeps `manifest` and `actionPolicies` visible while its
runtime calls accept `unknown` state/action payloads. The host owns validation,
authorization, and persistence at that boundary; plugin authors still get their
specific reducer types inside their own package and tests.

## Action policies

The host authorizes every action before it calls `handleAction`.
Unknown action types default to `host`, so new actions are safe by default.

```ts
type GamePluginActionPolicy = {
  role: "host" | "member" | "player" | "system";
  actorFields?: string[];
  joinsRoster?: boolean;
  audit?: boolean;
  allowOutsideVoice?: boolean;
};
```

- `host`: only the session creator can perform the action. A user with
  `START_ACTIVITY` can also perform it for moderation/admin control.
- `member`: any server member can perform the action.
- `system`: no client may send it (403, `code: 'system_action'`); the host
  runs it when a timer the plugin set falls due
  ([System actions](#system-actions)).
- `player`: the user must be an active player in `game_session_players`.
  An action joins the actor to that roster when its policy says
  `joinsRoster: true` AND the action changes state (a refused join —
  the reducer returned the same state object — adds no one). Opt in for
  join/ready actions and for public actions whose author is shown anyway
  (a dice roll); never for an anonymous one — the roster is visible to
  every viewer, so a poll vote that joined it would name the voter.
  While a joining action runs, `ctx.players` already includes the actor.
  The roster fills `ctx.players` (named by character name, then display
  name) and the panel's `players` prop; in the lobby, the people in the
  voice channel are added to `players` as well, so a host can seat them
  by name.
- `actorFields`: fields overwritten by the host with `ctx.actorUserId`.
  Use this for `playerId`, `voterId`, `hostId`, and similar identity fields.
- `audit`: whether an action that changes state writes an
  `activity.action` row (actor, plugin id, action type) to the server's
  audit log. Defaults to `true` for `host` actions (configure, start,
  kick, reveal — running the table) and `false` for `member` / `player`
  actions (gameplay). Every `VIEW_AUDIT_LOG` holder reads that log, so
  "who sent which action type, when" is public to them: a night action
  would name a hidden role and a vote row lined up with the poll counts
  would name the voter. Set `audit: true` only on an action whose author
  and type are public anyway; set `audit: false` on a host action whose
  type alone gives a secret away. A refused action (the reducer returned
  the same state) is never audited. `shouldAuditAction(policy)` in the SDK
  is the rule the host applies.
- `allowOutsideVoice`: for a plugin with `catalog.requiresVoiceRoom`, the
  host refuses `member` / `player` actions from anyone who is not in the
  activity's voice room. Set this on an action that must work from outside
  the room — leaving the game is the usual one (Quiz, Vampire Village and
  Watch Party mark `leave`). `host` actions are never voice-checked.
  It also marks the one thing a member who is **timed out** in the
  community may still do: a timed-out member starts no activity and sends
  no other action, host actions included (`403`, `code: "timed_out"`,
  with `until`) — as they cannot chat, vote in a poll or run a slash
  command. Mark leaving, so they can always get out of a game.

Do not trust actor identity fields sent by the browser.

## Voice, hosting and play again

The host route (`apps/web/app/api/servers/[id]/activities/…`) applies three
rules on top of the action policies. Every refusal keeps its English
`error` and carries a machine `code` the lobby translates:
`{ "error": "…", "code": "…" }`.

| Code | Status | When |
|---|---|---|
| `session_ended` | 409 | an action on an ended session (its row), or on a finished game (`phase: 'ended'`) that is not one of its `restartActions` |
| `not_host` | 403 | a `host` action, or ending the activity, by someone who is neither the host nor holds Start Activities |
| `voice_required` | 403 | a `member` / `player` action (or ending an abandoned session) from outside the activity's voice room, for a plugin that requires voice |
| `not_player` | 403 | a `player` action from someone who is not on the roster |
| `wrong_phase` | 409 | the host's own phase table refuses the action (Hushle/Quiz: not started yet, answers closed) |
| `activity_exists` | 409 | starting an activity in a channel that already has one open (`sessionId` names it) — also when two starts race |
| `system_action` | 403 | a client sent a `role: "system"` action (only the host runs those, when a timer falls due) |
| `effect_refused` | 422 | the plugin's reducer asked for an effect that is invalid or that it has no permission for: nothing of the action (or the start) was applied |
| `rate_limited` | 429 | too many requests (every 429 of the app carries it) |

**Voice.** "In the voice room" means connected to the activity channel's
LiveKit room, as LiveKit reports it (`RoomServiceClient.listParticipants`,
cached for 2 s per web process; `apps/web/lib/activity-voice.ts`) — not the
browser's presence heartbeat, which lags a departure by up to 90 s. Reading
the state never needs voice, so spectators keep watching. When LiveKit
cannot be asked the check is skipped and logged (a game rule, not a
security boundary: an outage must not freeze every game). The plugin's
`ctx.voice.getParticipants()` returns the room's user ids, oldest first,
for the action being handled.

**Host transfer.** For a plugin that requires voice, the host is someone in
the voice room (`apps/web/lib/activity-host.ts`):

- after the host has been **out of the room for 60 s**, hosting
  (`game_sessions.created_by`, which the `host` policy and the panel's
  `hostUserId` read) moves to the **longest-present participant in the
  room** — players on the activity's roster first, then anyone else in the
  room, each by how long they have been connected. Watch Party's own
  hand-over when its host leaves uses the same order, and its party host
  follows the session host through `onHostChange`;
- after **3 minutes**, or past the 60 s when nobody in the room can take
  over, the session is **abandoned**: any voice participant may end it.

It is lazy and deterministic — no timer runs anywhere. The rule is applied
whenever someone touches the session: an action, a state read (`GET`) or an
end request. "Out of the room since" is a small Redis ledger: the LiveKit
webhook records `participant_left` (ignoring a second connection of the same
user) and clears it on `participant_joined`; a reader that finds the host
gone with no entry starts the clock then, so it never starts early. The
move itself is a compare-and-swap on the old host under the session's write
lock (two requests move it once), audited as `activity.host_transfer`
(actor: none, metadata: from, to, seconds away), and announced on the
activity bus as `rosterChanged` so open panels re-read the session. When
the host or a player (anyone on the session's roster) leaves the voice room
or comes back, the webhook sends `presenceChanged`, and panels re-read the
same way.

**Dropped connections.** The bus keeps no backlog: an event published while
a panel's socket was down is gone. The lobby therefore re-reads the session
whenever its realtime socket authenticates again, when the browser reports
the network back (`online`, which also replaces a socket that only looks
open), and when the tab is shown after at least 5 s in the background.
Becoming visible or coming online also lifts the realtime client's
20-attempt circuit breaker. An action whose answer is lost (no response at
all) or refused with a retryable `503` is sent again with the **same**
`actionId` for up to 8 s; if the first attempt had committed, the retry
comes back as a duplicate and the panel re-reads instead of applying it
twice. A plugin needs no code for any of this.

`GET …/activities/{sessionId}` adds, for these plugins, `host: { userId,
inVoice, awaySince, transferAt, abandonAt, abandoned }` (ISO times): a panel
shows "the host left — hosting moves at …" and reads again at `transferAt` /
`abandonAt`, which is what applies the rule if nobody acted in between. The
end route answers a participant who may not end it yet with `not_host` and
the same `host` object. Poll and Dice Bot do not require voice: their host
keeps the session wherever they are; Start Activities holders can always
end it.

**Play again.** A game that declares `restartActions` gets its "play again"
from the final screen through the normal actions route, with its policy
(both official ones are `host`): Hushle's "Start new game" sends
`start-game` (back to team setup with the same settings), Quiz's "Play
again" sends `play-again` (back to the lobby: the players who stayed keep
their seats with a clean score, the last game's deck, answers and reveal
are dropped, anyone may join before the host starts).

## Effects: timers, storage and chat

A reducer stays pure and synchronous: it cannot await a database, schedule
anything or post a message. What it wants the host to do beyond the next
state, it **returns** as effects, wrapped around the state:

```ts
import { withEffects, type GamePlugin, type ReducerResult } from '@lobbyforge/plugin-sdk';

export const buzzerPlugin: GamePlugin<State, Action, Props, ReducerResult<State>> = {
  manifest: { /* … */ permissions: ['timers', 'storage', 'chat'] },
  actionPolicies: { 'open-round': { role: 'host' }, 'auto-reveal': { role: 'system' } },
  handleAction(ctx, state, action) {
    if (action.type === 'open-round') {
      const next = { ...state, phase: 'open', round: state.round + 1, revealAt: ctx.now! + 30_000 };
      return withEffects(next, [
        { type: 'timer.set', id: 'reveal', afterMs: 30_000, action: { type: 'auto-reveal', round: next.round } },
      ]);
    }
    // …
    return state;
  },
};
```

`withEffects(state, effects)` returns `{ __lf: 1, state, effects }`; a
marketplace plugin's `server.js` has no imports and writes that object
itself. `__lf` is reserved: a plain state must not have it.
`createInitialState` may return effects too (a first timer, say).

**All or nothing.** The host unwraps the envelope wherever it consumes a
reducer result and checks every effect — its shape, its limits, and that
the plugin has the permission it needs. One invalid or unpermitted effect
refuses the whole call: an action answers `422` with `code:
'effect_refused'` and nothing of it is applied (no state, no timer, no
storage, no chat line); a start creates no activity; a timer's action is
dropped and logged. The reason goes to the server log, not to the client.
Returning the **same** state object with no effects (or
`withEffects(state, [])`) still means "no change" — nothing is audited and
no one joins the roster; the same state *with* effects counts as a change.

**Permissions.** A compiled-in plugin declares them in
`manifest.permissions` (`PluginPermission.TIMERS`, `.STORAGE`, `.CHAT`):
it is trusted code, so there is no approval dialog. A marketplace plugin
asks for them in manifest.json `permissions`, and gets only what it asks
for **and** the instance owner approved at install
([PLUGIN_PUBLISHING.md → Asking for more than the
sandbox](PLUGIN_PUBLISHING.md#asking-for-more-than-the-sandbox)). The older
`PluginPermission` names (`manage_timer`, `send_room_message`, …) describe a
plugin and grant nothing.

| Effect | Permission | Fields | Limits |
|---|---|---|---|
| `timer.set` | `timers` | `id`, `afterMs` **or** `at` (epoch ms), `action` | at most **8** pending per session; due **1 s – 24 h** after `ctx.now`; `id` is 1–64 of `A-Z a-z 0-9 . _ : -`, and the same id replaces the pending timer; `action` must be one of the plugin's `role: "system"` actions, at most 4 KiB of JSON |
| `timer.clear` | `timers` | `id` | clearing a timer that is not pending is fine |
| `storage.set` | `storage` | `key`, `value` | `key` is 1–128 of `a-z A-Z 0-9 . _ : -` (not `__proto__`); `value` any JSON; the plugin's storage in a community holds at most **64 KiB** (every key plus its value's JSON, in UTF-8) |
| `storage.delete` | `storage` | `key` | |
| `chat.post` | `chat` | `text` | 1–**500** characters after trimming, no control characters but tab and newline; at most **one per 5 s and 30 per hour** per session, and **60 per hour** per community and plugin; checked by the community's Moderation Bot |

At most 32 effects per call; an unknown key on an effect is refused (a
typo never silently does something else). `voice.mute` is a known
permission name a manifest may ask for, but the effect does not exist yet
(phase 3b of [PLUGIN_UNLOCK_PLAN.md](PLUGIN_UNLOCK_PLAN.md)): it is refused.

### System actions

An action policy may say `role: "system"`. **No client can send it** — not
the host, not an administrator: the actions route answers `403` with `code:
'system_action'`. Only the host runs it, when a timer that names it falls
due. The reducer then sees `ctx.actorUserId === ''` (a marketplace plugin's
`ctx.actorId` is `null`) and `ctx.now` = the timer's due time. A system
action takes no `actorFields`, never joins the roster and has no voice rule
(a sandbox manifest refuses those keys on it); `audit` defaults to `false`.
The host's phase checks and the ended-phase guard (`restartActions`) are for
clients: a system action always reaches the reducer, so make it check that
it still applies — the example's `auto-reveal` carries the round it was set
for and changes nothing in a later round.

### Timers fire lazily

Timers follow the design of the host hand-over
([ACTIVITY_INTEGRITY_AND_RESILIENCE.md §3.4](ACTIVITY_INTEGRITY_AND_RESILIENCE.md)):
nothing runs on a clock.

- The pending timers are stored with the session (`game_sessions.timers`)
  in the **same** compare-and-swap as the state that set them.
- Whenever somebody touches the session — a state read (`GET`), an action,
  an end request — every timer whose due time has passed fires under the
  session's write lock, **earliest first** (ties: the one set first), each
  as its system action through your reducer with `ctx.now` = its due time.
  Its effects apply too, so a timer may set the next one, and a chain that
  is already due keeps firing in the same touch.
- **Catch-up is bounded.** A session nobody touched for a while can have a
  backlog: a 1 s timer that re-arms itself and sat idle for an hour is
  3 600 firings behind. The host does not replay it:
  - **Missed occurrences collapse.** When a timer's firing sets a timer
    with the **same id** (it re-arms itself) at a time that is already due,
    the host moves that timer to the **latest** occurrence of the same
    period that is due. The idle 1 s ticker fires twice — for its first
    due time and for the last second that passed — and its next firing is
    in the future again. Do not count ticks to measure time; read
    `ctx.now` (the due time of the firing) and keep deadlines in your
    state. A timer set under a **new** id is never moved.
  - **A touch fires at most 8 timers**, and starts none after 500 ms of
    wall time (the first always runs). What is still due fires on the next
    touch: the session GET reports it in `timersDueAt`, so an open panel
    re-reads for it at once.
- Before an action, the timers due by then fire first and the action runs
  on the state they left — in one write. If the action is then refused,
  the timers still commit. If more timers were due than one touch fires,
  the action does **not** run ahead of them: what fired commits and the
  action answers `409` with `code: "timers_pending"` and `retryable: true`.
  The lobby retries it by itself (same `actionId`), each retry continuing
  the catch-up.
- **Exactly once**: the lock serializes touches and a fired timer is
  removed in the same write as the state it produced, so of two
  concurrent reads the second finds nothing due.
- A timer whose action throws or whose effects are refused is dropped and
  logged, and the next one runs. So is a timer whose action is no longer a
  system action (a new version of the plugin changed it).
- `GET …/activities/{sessionId}` returns `timersDueAt` — the pending due
  times, ISO, earliest first; **never** the actions — and `now`, the
  server's clock. An open panel re-reads the session once at the earliest
  due time, counted on the server's clock (`nextActivityCheck` in
  `apps/web/lib/activity-next-check.ts`, which also covers the host
  hand-over); setting, clearing or firing a timer tells every open panel
  to re-read (`publicSummary.timersChanged` on the activity bus), and an
  action's answer carries the new `timersDueAt`. A due time that is still
  pending after the panel re-read for it (the server could not fire it
  yet) is re-read for again after 2 s, then 4 s, 8 s … at most once a
  minute — never in a loop.
- Ending the activity fires what was already due (within the per-touch
  bound above), then drops every other pending timer.
- **Only while the app is installed.** If the community uninstalls or
  disables the app (Server settings → Apps), its open sessions end there
  and then (audited as `activity.end` with the reason `app_uninstalled` /
  `app_disabled`; nothing fires on the way out). A session that is still
  open by a race takes no more actions (`403`, `code:
  "app_not_installed"`), its due timers are dropped without running, and
  storage writes and chat lines asked for after the removal are dropped.

So a timer is **never early, and late only when nobody is looking** —
which is exactly when nobody would notice. Keep the deadline in your state
(`revealAt`) and let the UI count down to it.

### Storage

`ctx.storage` is a read-only snapshot of your plugin's storage in this
community, taken under the session's lock before the call:
`ctx.storage.get(key)` returns a copy of the value (or `undefined`),
`ctx.storage.keys()` the sorted keys. Without the `storage` permission it is
empty. A marketplace plugin gets the same two functions; the host sends the
snapshot with the call as JSON.

Writes are `storage.set` / `storage.delete` effects, and the order matters:

1. **Before the commit** the host applies them to the snapshot and checks
   the 64 KiB limit — over it, the call is refused like an invalid effect.
2. The state (and timers) commit.
3. **After the commit** the writes go to the database as one batch (the
   last effect on a key wins), re-measured under a lock on (community,
   plugin): another session may have written in between. A batch that no
   longer fits, or a write that fails, is **dropped and logged**; it is
   not retried and the state stays committed. Treat the state as the
   source of truth and storage as a side record.

Storage is shared by every session of the plugin in the community and
holds whole values: two sessions that read, change and write the same key
at the same moment can overwrite each other (last write wins). Merge with
what the snapshot holds when you write, as the example's leaderboard does,
and keep values small.

### Chat

An activity runs in a voice or stage channel, and those have no text chat
in the lobby. So a `chat.post` goes to the text or announcement channel
the community chose for the app — Server settings → Apps → **App messages
go to** (shown for apps with the `chat` permission). With no channel
chosen, the default, the post is dropped: a game never writes into a
channel nobody picked (which could also carry a private voice room's game
into a public channel). The choice is checked again on every post.
Choosing a **role-gated** (private) channel takes what granting a bot one
takes: Manage Channels (owners and administrators have it), and seeing
the channel — Manage Server alone is refused with `403`, `code:
"chat_channel_not_allowed"`. Saving other settings of the app keeps a
channel someone else chose.

- The message has **no author** (no user, no bot) and `metadata.app = {
  pluginId, name }`; the lobby shows it with the plugin's name, an app
  avatar and an **APP** badge ("UYGULAMA" in Turkish), and a desktop
  notification says "(APP)". Members cannot set `metadata.app`.
- Mentions are inert: every `@` that could start one gets a zero-width
  space after it, so `@everyone`, `@here` and `@<name>` ping nobody.
- Over the rate (one per 5 s and 30 per hour per session, and 60 per hour
  per community and plugin, so restarting the activity does not reset it)
  a post is **dropped** and logged; the action that asked for it still
  applies. Chat is a side channel, never part of your game's state.
- **Moderated like everyone's messages.** When the community runs the
  Moderation Bot, its blocked-word and link rules apply to the line as you
  wrote it (the mention rule does not: your mentions are inert anyway). A
  line the rules block is **dropped** and logged, and audited as
  `bot.moderation.block` naming your plugin (without the line's words when
  the channel is role-gated); the action still applies. No notice is
  posted and there is no exemption.
- It is posted after the commit (after the storage batch), published on
  the chat bus like any message and audited as `message.create` (actor:
  none, the plugin in the metadata).

Everyone in that channel reads the line: never post hidden information.
`ctx.locale` is the caller's language (for a system action, the language
of whoever's touch fired it), so prefer short, language-light lines —
names and numbers.

### Testing effects

`createTestHarness` applies effects with the same rules as the host
([below](#the-createtestharness-test-helper)): `performAction` throws an
`EffectRefusedError` where the host would answer `effect_refused` (and
applies nothing), refuses a system action from a client, and
`advanceTime(ms)` fires due timers in order with `ctx.now` = each due time
— every occurrence, as for a session somebody watches the whole time (the
host's idle catch-up collapse and per-touch bound above do not apply).
`getTimers()`, `getStorage()` and `getChatPosts()` show what the host
would have stored and posted; `permissions` and `storage` options set the
plugin's permissions and its storage before the game.

### Deprecated: `ctx.timer` and `ctx.messages`

`ctx.timer.start/stop` and `ctx.messages.sendGameMessage` never did
anything on the HTTP host (the latter only logged). They stay as no-op
stubs for compatibility; use `timer.set` / `timer.clear` and `chat.post`.
`ctx.storage` used to be an async `get/set/delete/list/clear` object that no
plugin used — a synchronous reducer cannot await it — and is now the
snapshot above.

## The `GamePluginContext` sub-contexts

The context has `actorUserId`, `now` and ten sub-contexts, all part of the SDK contract:

| Sub-context | Sync / async | Used for |
|---|---|---|
| `actorUserId` | sync | Local user id that triggered the current action (`''` for a system action) |
| `now` | sync | The server clock of the call, ms; a timer's due time for a system action. Prefer it to `Date.now()` |
| `players` | sync (M16) | `list()` returns active player ids, `get(id)` returns `{ id, name }` |
| `storage` | sync | `get(key)` / `keys()` — a read-only snapshot of the plugin's storage in the community; writes are effects ([Storage](#storage)) |
| `messages` | async | **deprecated**: `sendGameMessage(text)` only logs — return a `chat.post` effect |
| `state` | async | `save(state)` — the HTTP host treats this as a no-op (it persists state itself) |
| `cache` | async | `get` / `set` with TTL — HTTP host returns `undefined` / no-op |
| `pubsub` | async | `publish` / `subscribe` — HTTP host is a no-op |
| `timer` | async | **deprecated** no-op: return `timer.set` / `timer.clear` effects |
| `votes` | async | `create(question, options)` — HTTP host is a no-op |
| `scores` | async | `add(playerId, score)` — HTTP host is a no-op |
| `voice` | sync | `getParticipants()` — the user ids in the activity's voice room, oldest first, for plugins that require voice (`[]` otherwise) |

The HTTP host (`apps/web/lib/plugin-context.ts:buildHttpPluginContext`)
implements the contract with the sub-contexts a plugin would
expect, but most of them are intentionally inert. A plugin that
calls `state.save` doesn't get an error — it just doesn't get
persistence, because the host persists the post-`handleAction`
state itself. This keeps the plugin's `handleAction` honest (it
can call `state.save` if it wants) while the host stays in control
of the read-modify-write cycle.

## Authoring a new plugin

1. Create a package under `plugins/{id}/` with the standard layout:
   ```
   plugins/{id}/
   ├── package.json     # name: "@lobbyforge/{id}", workspace dep on @lobbyforge/plugin-sdk
   ├── src/
   │   ├── index.ts     # exports the GamePlugin + any action / state types
   │   └── __tests__/
   │       └── {id}.test.ts  # uses createTestHarness
   └── tsconfig.json
   ```
2. Define `TState` and `TAction` types in `src/index.ts`. Keep the action
   shape small and add `actionPolicies` for public action types. Any actor
   identity field must be listed in `actorFields`.
3. Implement `createInitialState` and `handleAction` as pure
   reducers. Use the `createTestHarness` from
   `@lobbyforge/plugin-sdk/testing` to test them in isolation.
4. Add the plugin to the registry in
   `apps/web/lib/plugin-registry.ts`:
   ```ts
   import { yourPlugin } from '@lobbyforge/your-id';
   import { registerGamePlugin } from '@lobbyforge/plugin-sdk';

   export const PLUGINS = [
     registerGamePlugin(quizPlugin),
     registerGamePlugin(yourPlugin),
   ] as const;
   ```
5. If the plugin needs a workspace dep in `apps/web` (it does, for
   the registry import to resolve), add it to `apps/web/package.json`'s
   `dependencies` and re-run `pnpm install`.

## The `createTestHarness` test helper

```ts
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import { quizPlugin, type QuizState, type QuizAction } from '@lobbyforge/quiz';

const harness = createTestHarness<QuizState, QuizAction>({
  plugin: quizPlugin,
  players: ['p1', 'p2'],
});

await harness.startGame();
const initial = harness.getState(); // { questions: [], currentIndex: 0, ... }

await harness.performAction('p1', { type: 'set-questions', questions: [] });
await harness.performAction('p1', { type: 'answer', index: 0 });
const after = harness.getState(); // { ..., totalAnswered: 1 }
```

The harness exposes:
- `context` — the full `GamePluginContext` if your reducer needs to
  assert on sub-context calls.
- `startGame()` — calls `plugin.createInitialState(ctx)`.
- `performAction(playerId, action)` — calls `plugin.handleAction(ctx, state, action)`
  and applies its effects the way the host does: an invalid or
  unpermitted effect throws `EffectRefusedError` and nothing is applied; a
  `role: "system"` action is refused (only a timer fires it).
- `getState()` — the current state. Throws until there is one.
- `advanceTime(ms)` — moves the harness clock and fires every timer that
  falls due on the way, in due order, each as its system action with
  `ctx.now` = its due time (and its effects). `advanceTimer(seconds)` is
  the old name.
- `now()`, `getTimers()`, `getStorage()`, `getChatPosts()` — the clock, the
  pending timers, the plugin's storage and the chat lines posted so far.

Options besides `plugin` and `players`: `now` (the clock's start),
`permissions` (default: the effect permissions in `manifest.permissions`)
and `storage` (the plugin's storage before the game, what `ctx.storage`
reads).

```ts
const h = createTestHarness({ plugin: buzzerPlugin, players: ['host'], now: 0, storage: { best: [] } });
await h.startGame();
await h.performAction('host', { type: 'open-round' });
expect(h.getTimers()).toEqual([{ id: 'reveal', at: 30_000, action: { type: 'auto-reveal', round: 1 } }]);
await h.advanceTime(30_000);
expect(h.getState().phase).toBe('revealed');
```

The mock sub-contexts are documented in
`packages/plugin-sdk/src/testing.ts`. The `cache.get` / `set` are
in-memory `Map`s, the `scores.add` updates an in-memory score
table, and the `pubsub.publish` / `subscribe` are no-ops. The
`players.list` returns whatever ids the test passed in.

## What M16 doesn't do

- **No community sandbox yet.** Official plugins now have host-side action
  policies, but community plugins still require package signing, capability
  review, sandboxing, install approval, and rollback before they can be enabled.
- **No plugin-specific UI.** The `ActivityPanel` in
  `apps/web/app/room/[roomName]/page.tsx` is generic; the plugin's
  `renderClient` is unused. M17+ will dynamic-import each plugin's
  `renderClient` based on the session's `pluginId`.
- **Limited plugin settings.** The host now reads `plugins_enabled` and exposes
  `/api/servers/{id}/apps` plus a basic Server Apps tab for install,
  enable/disable, `defaultMaxPlayers`, and `overflowPolicy`. Per-channel,
  per-role, and plugin-specific settings screens are still M17+.
- **No real-time updates.** The activity panel polls
  `GET /api/servers/{id}/activities/{sessionId}` every 2s.
  Server-Sent Events or WebSocket are M17+.

## Shared locale helper (M19)

Adding a new language to a plugin (or to a bot — the bot SDK has the
same helper) is intentionally a single-place change:

```ts
// plugins/{id}/src/renderClient.tsx
import { loadPluginLocale, pickBestLocale, detectLocale, tFor } from '@lobbyforge/plugin-sdk';
import en from '../locales/en.json';
import tr from '../locales/tr.json';

loadPluginLocale('hushle', { en, tr });

const locale = pickBestLocale('hushle', detectLocale('en'));
const text = tFor('hushle', locale, 'lobby.title', undefined, 'en');
```

The whole pattern is:

1. The plugin ships `locales/{lang}.json` bundles.
2. At module load, `loadPluginLocale(pluginId, { en, tr })` registers
   each table against the shared registry keyed by `pluginId`.
3. `tFor(pluginId, locale, key, params?, fallback?)` resolves a
   string for the active locale and fills its arguments — `{name}`, and
   plurals such as `{count, plural, one {# point} other {# points}}`.
   It is the same message format as the app's own catalogues
   (`formatMessage` in `src/message-format.ts`; see
   `docs/TRANSLATING.md` → "Plurals"), so pass counts as numbers and let
   each language write its own plural forms.
   Put your catalogue description under the key `catalog.summary`
   (`CATALOG_SUMMARY_KEY`) and your activity's name under `catalog.name`
   (`CATALOG_NAME_KEY`): the host shows both in the activity picker, the
   activity header, the admin and community app lists, the hub's landing
   and marketplace pages in the viewer's language
   (falling back to `manifest.name` when a language has no name), and the
   manifest can read its English from the same file —
   `summary: LOCALE_TABLES.en[CATALOG_SUMMARY_KEY]`. A plugin's locale test
   treats both keys as rendered (by the host).
   Marketplace (`sandbox-v1`) plugins use the same two keys: they ship
   the same tables as `locales/<code>.json` in their bundle, and the host
   validates them and registers them under the plugin's id when the
   plugin loads (`replacePluginLocale`, which also drops what an older
   version shipped). See
   [PLUGIN_PUBLISHING.md → `locales/`](PLUGIN_PUBLISHING.md#locales-optional-your-name-and-description-in-every-language).
4. `listPluginLocales(pluginId)` returns the locales the plugin
   actually supports in registration order (so the first registered
   is the primary fallback when the user's preference isn't shipped).
5. `pickBestLocale(pluginId, preferred, fallback)` matches a
   region-tagged preference against the plugin's set
   (`tr-TR` → `tr`), then falls back to `fallback`, then to the
   first registered.

The bot SDK ships the same surface (`@lobbyforge/bot-sdk/locale`):

```ts
import { loadBotLocale, tFor } from '@lobbyforge/bot-sdk';
import en from './locales/en.json';
loadBotLocale('music-bot', { en });
```

Why a per-plugin registry and not a single shared JSON bundle?

- The plugin is the source of truth for what strings it needs.
- Community plugins ship their own loaders without touching the SDK
  or the host.
- Adding a language to one plugin doesn't require touching every
  other plugin or every other bot.
- The host's UI language switcher (when it ships) reads
  `listPluginLocales(pluginId)` to discover what's available.

The plugin-sdk subpath `@lobbyforge/plugin-sdk/locale` exports the
same surface for callers who prefer the dedicated import path.

The registry is one per process: it lives on `globalThis`, not in the
module. Next evaluates the SDK once per server chunk (instrumentation,
route handlers, pages), and the host registers a marketplace plugin's
tables from whichever chunk loaded it; every copy of `tFor` sees them.
`replacePluginLocale(pluginId, tables)` swaps all of a plugin's tables at
once (`{}` forgets them); compiled-in plugins keep `loadPluginLocale`.

## Per-plugin renderClient

M17 wires the plugin's `renderClient` into the voice room's
`ActivityPanel`. The contract between the host and the plugin is:

```ts
interface HushlePanelClientProps {
  state: TState;                            // server-authoritative reducer output
  dispatch: (action: TAction) => void | Promise<void>;  // POSTs to /actions, no return value
  actorUserId: string;                      // current user (the panel reads actor/host for gating)
  hostUserId: string | null;                // session creator, may be null if creator left
  players: Array<{ userId: string; name?: string | null }>;  // for name lookups
}
```

Plugins should declare a typed props interface (e.g.
`HushlePanelClientProps`) and have the SDK-bound `renderClient` cast
on the way in:

```ts
export const hushlePlugin: GamePlugin<HushleState, HushleAction> = {
  // …
  renderClient: (props: unknown) => HushlePanel(props as HushlePanelClientProps),
};
```

The host's `ActivityPanel` resolves the plugin from the registry, then:

```tsx
const plugin = getPlugin(activity.pluginId);
const ui = plugin ? plugin.client.renderClient({
  state: activity.state,
  dispatch: (action) => fetch(`/api/servers/${serverId}/activities/${sessionId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  }),
  actorUserId,
  hostUserId,
  players: activity.players,
}) : null;
return ui ?? <JsonStatePanel state={activity.state} />;
```

A few conventions plugins should follow:

1. **Mark the file with `"use client"`.** The renderClient is React
   client code — it uses hooks, accesses `document.documentElement.lang`,
   etc. Without the directive the Next.js bundler refuses to import it
   from a server component route.
2. **Build the UI with the kit** (`@lobbyforge/plugin-sdk/ui`, below).
   The host doesn't ship a CSS framework to the plugin — Tailwind never
   sees plugin files — so the kit carries its own theme-aware styles.
   If you style something by hand, colour it with the host's theme
   variables and a fallback — `var(--lf-surface, #0e1218)`,
   `var(--lf-text-primary, #e6e8eb)` — never a bare dark hex.
3. **Bundle your own locales.** One `locales/<code>.json` per language,
   loaded with `loadPluginLocale` and read with `tFor`; the plugin stays
   self-contained. `pnpm i18n:add` scaffolds a new language for every
   plugin at once — see [TRANSLATING.md](TRANSLATING.md).
4. **Gate every action through `dispatch`.** No `fetch`, no DB calls,
   no side effects in the panel. Every state transition is a reducer
   call that the host persists.
5. **Return `null` if you have no UI.** The host falls back to the
   generic JSON panel. This is what `quizPlugin.renderClient` does
   today and is the right answer for plugins whose state is best
   inspected raw.

The full worked example is Hushle's panel (`plugins/hushle/src/renderClient.tsx`
and `src/ui/`). It demonstrates the four-phase machine pattern
(`lobby → team_setup → playing → ended`), per-seat views (host, explainer,
guessers, the opposing team, spectators) and the locale loader.

## The activity UI kit (`@lobbyforge/plugin-sdk/ui`)

Every official panel is built from the same pieces, so games feel like
one product and follow the viewer's theme (dark, dim, light) with no
work from the plugin. The design reference is the "Plugin UI" page of the
LobbyForge design canvas.

```tsx
'use client';
import {
  ActivityShell, ActivityHeader, PhasePill, TimerRing, Panel, Grid,
  Button, PlayerChip, Scoreboard, Callout, EmptyState, useSecondsLeft,
} from '@lobbyforge/plugin-sdk/ui';

export function QuizPanel({ state, dispatch }: QuizPanelProps) {
  const left = useSecondsLeft(state.deadline);          // counts down to a shared deadline
  return (
    <ActivityShell>                                      {/* required: theme variables + stylesheet */}
      <ActivityHeader glyph="Q" tone="accent" title="Quiz"
        status={<PhasePill tone="accent">{t('quiz.question', { n: 4, total: 10 })}</PhasePill>}
        timer={left == null ? null : <TimerRing seconds={left} total={20} label={t('quiz.secondsLeft', { count: left })} />} />
      <Panel>…</Panel>
    </ActivityShell>
  );
}
```

| Piece | Use |
|---|---|
| `ActivityShell` | The panel root. Defines the `--lfui-*` variables and brings the kit's stylesheet (hover, focus, motion, reduced motion). Required. |
| `ActivityHeader`, `PhasePill`, `Badge`, `TimerRing`, `ProgressBar` | Title row, phase, timers. Timers take a translated `label`. |
| `Button` | `primary`, `game`, `success`, `danger`, `secondary`, `ghost`; `sm`/`md`/`lg`. |
| `SegmentedControl` | Mutually exclusive settings (mode, difficulty). |
| `Panel`, `Stack`, `Row`, `Grid`, `SectionLabel`, `Stat` | Surfaces and layout. `Grid min={…}` wraps responsively — panels run from narrow to full width. |
| `Avatar`, `PlayerChip`, `Scoreboard` | People and scores. |
| `Callout`, `EmptyState` | Messages and "waiting for players". |
| `useNow`, `useSecondsLeft`, `secondsUntil`, `formatClock` | Countdowns. Store DEADLINES in state, not "seconds left". |
| `tone(name)`, `lf` | Raw colour tokens for anything custom. |

Tones: `accent` (the user's accent — primary actions), `game` (amber —
games and live state), `success`, `danger`, `info`, `neutral`. Colour is
never the only signal: pair it with text, an icon or a count.

## Marketplace plugin UI (sandboxed iframe)

Official plugins are trusted code and render React panels in the app.
A **marketplace** plugin (`sdk: "sandbox-v1"`, ADR-007) is not trusted, so
it brings its own UI as plain web files and the lobby runs them in a
sandbox — or, with the instance owner's approval, its UI is the author's
own site, framed by the lobby
([Your own site as the UI](#your-own-site-as-the-ui-ui--url-)):

```
my-plugin/
├── manifest.json        # … "sdk": "sandbox-v1", "ui": true
├── server.js            # globalThis.plugin = { createInitialState, handleAction, projectState?, … }
├── locales/             # optional: en.json, tr.json … — catalog.name / catalog.summary for the host's screens
└── ui/
    ├── index.html       # the entry; everything under ui/ is served
    ├── app.js
    ├── style.css
    └── lobbyforge-frame.js   # the frame client, copied in (no CDN in the sandbox)
```

`locales/` is read by the host, not served to the frame: it names and
describes the plugin in each viewer's language in the lobby, the app lists
and the marketplace. The frame translates its own UI from strings it ships
under `ui/`, in the language `init.locale` gives it (the example's
`ui/app.js` does). See
[PLUGIN_PUBLISHING.md → `locales/`](PLUGIN_PUBLISHING.md#locales-optional-your-name-and-description-in-every-language).

### What the sandbox is

The lobby renders `<iframe sandbox="allow-scripts">` — no `allow-same-origin`,
forms, popups, modals, top navigation or downloads — from
`/api/plugin-ui/{pluginId}/{version}/index.html`. The frame therefore has an
**opaque origin** (`self.origin === "null"`): it cannot read the app's
cookies, storage or DOM, the session cookie is not sent with its requests,
and `localStorage`/`document.cookie` throw.

The route serves only the **active** version of an installed plugin that
declares `ui: true`, only files under `ui/`, and only these extensions, each
with a fixed type:

| Kind | Extensions |
|---|---|
| Page, code, styles, data | `html js mjs css json` |
| Images | `png jpg jpeg gif webp svg` |
| Fonts | `woff woff2` |
| Sound and video | `mp3 ogg oga opus wav m4a flac webm mp4` |
| WebAssembly and engine data | `wasm bin data pck` |

Every file carries this CSP, where `<own>` is your version's own folder,
`https://<instance>/api/plugin-ui/<your-id>/<version>/`:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; media-src <own> data: blob:; connect-src <own>;
frame-ancestors 'self'; base-uri 'none'; form-action 'none'; webrtc 'block'; sandbox allow-scripts
```

So by default: **no fetch, XHR, WebSocket, image or media requests beyond
your own files.** `fetch()` and XHR can read your own files (level data, a
`.wasm`, sound for the Web Audio API) and nothing else — not the app, not
another plugin, not the web; WebSockets and remote images are blocked.

That is what CSP guarantees, and it is less than "no network":

- **WebRTC is not covered by CSP.** `connect-src` does not govern an
  `RTCPeerConnection`'s STUN/TURN traffic. The policy adds `webrtc 'block'`,
  which refuses it only in browsers that implement that directive; the
  others ignore it.
- **The frame can navigate itself** (`location.href = …`) to any origin the
  lobby page may frame: that is the embedding page's `frame-src`, not your
  page's policy.

So write your UI as if its author — you — could read everything the frame
is shown, because it can: the viewer's projected state, names and language.
Keep secrets out of what a viewer receives with `projectState`, not with
the frame.

**Outside origins the owner approved.** A manifest may ask for outside
origins under `network` ([PLUGIN_PUBLISHING.md → Asking for more than the
sandbox](PLUGIN_PUBLISHING.md#asking-for-more-than-the-sandbox)). Once the
instance owner approves them at install, the policy of your **HTML
document** adds them — and only the origins your manifest asks for AND the
owner approved:

| `network` key | Added to | What it unlocks |
|---|---|---|
| `connect` | `connect-src` | `fetch()`, XHR, WebSockets (`https://api.example.com` also admits `wss://api.example.com`), EventSource |
| `img` | `img-src` | images from that origin |
| `media` | `media-src` | `<audio>` / `<video>` from that origin |
| `frame` | `frame-src` | `<iframe>` of a page on that origin (without one there is no `frame-src`, so no frames at all) |

A page you frame this way **inherits your frame's sandbox**: it runs in an
opaque origin too, without its own cookies or storage, so an embed that
needs to sign in or remember something does not work here (use
[your own site as the UI](#your-own-site-as-the-ui-ui--url-) instead). The
server you reach sees requests with `Origin: null` and no cookies: answer
with `Access-Control-Allow-Origin: *` (or `null`) for `fetch()` to read the
response. Because an approval can change for the same version (approved
again, or taken back by uninstalling), the HTML is served `no-cache`; every
other file keeps the base policy (only the document's policy governs the
frame) and its year-long cache.
`<audio>` and `<video>` play your own files (and `blob:`/`data:` URLs you
make); the route answers `Range` requests, so they can seek. WebAssembly
compiles (`WebAssembly.instantiate`, `instantiateStreaming`), so an engine
build without threads runs — a single-threaded Godot web export, or an
Emscripten build. There are still no workers, no `eval`, and no
SharedArrayBuffer (the frame is not cross-origin isolated). A browser plays
sound only after the viewer has pressed something in the frame: start
sounds from a click, as the example's buzzer does. Each file may be at most
16 MiB, and the whole bundle 10 MB packed (50 MB unpacked). No inline
`<script>` (put code in files; inline `style` is fine), only the app may
frame it, and the page stays sandboxed even if someone opens it directly.

The instance names `<own>` from its configured public origin
(`LOBBYFORGE_APP_ORIGIN`, else `NEXT_PUBLIC_BASE_URL`), never from the
request. Without either (a dev setup) it is `'self'`: the app's origin,
reached without cookies, where every mutating route refuses a cross-site
request. Where the frame can navigate itself is bounded by the app page's
own `frame-src` — the app's origin, YouTube's privacy-enhanced player, the
CAPTCHA provider's frames when one is configured, and the approved sites of
plugins whose UI is their own page — not by your page's policy. Assets other than
the HTML are public and cached for a year by browsers (`immutable`, the
version is in the path): ship a new version to change them. Shared caches
never store them (`CDN-Cache-Control: no-store`, see
[DEPLOY_CLOUDFLARE.md](DEPLOY_CLOUDFLARE.md)). The HTML loads only as an iframe document, and the
app's own pages can never load your scripts (Fetch Metadata), so do not
link to your files from anywhere else. Files are streamed (a `Range` reads
only that range), and the route allows each address a burst of 1000
requests, refilled at 50 per second, then answers 429 with `Retry-After`:
plenty for a game's first load, but do not poll your own files in a loop.

Everything the frame knows arrives in a message; everything it can do is an
action the lobby sends **as the viewer**, through the normal actions route,
under your manifest's `actionPolicies`. It can do nothing the viewer could
not do by sending actions.

### Your own site as the UI (`ui: { url }`)

Instead of `ui/` files, a manifest may name a page on your own site:
`"ui": { "url": "https://game.example.com/play" }` (an https URL on a public
host, no credentials or fragment). The lobby frames that page directly —
the Discord Activities model — once the instance owner has approved that
exact URL at install. Until then the plugin has no screen.

- **The frame:** `<iframe src="https://game.example.com/play"
  sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
  referrerpolicy="no-referrer">`. Your page keeps **its own origin**: its
  own cookies and storage (partitioned under the instance by most
  browsers — do not rely on them, the state comes from the lobby), forms
  and pointer lock for games. It can never navigate the lobby away, open
  windows or show `alert()` / `confirm()` dialogs (no
  `allow-top-navigation`, `allow-popups` or `allow-modals`), and the lobby
  sends no `Referer`.
- **Never the instance's own address.** `allow-same-origin` is safe only
  because your origin is not the app's: a same-origin frame could reach into
  the lobby and lift its own sandbox. The installer refuses a `ui.url` on
  the instance's host (any port) or a subdomain of it, and the lobby checks
  again before framing it.
- **What your site receives:** the same as a files frame — the viewer's id
  and display name, the players, the language, the theme and the state
  **projected for this viewer**. The difference is that it now reaches your
  server; the owner's approval dialog says so. Treat it as display data, not
  as proof of who the viewer is (sign-in with LobbyForge is a later phase).
  What the site can do is still only `dispatch` actions, which the lobby
  sends as the viewer under your `actionPolicies`.
- **Messages:** protocol v1 is unchanged. The lobby accepts a message only
  when it comes from your iframe's window **and** from the approved URL's
  origin (the window stays the same object when the frame navigates, so the
  window alone proves nothing), and posts to that origin only — never to
  `'*'` — so a frame that has navigated to another site hears nothing. Your
  page may move between its own pages; each new document says `ready` and
  gets a fresh `init`.
- **The address badge:** above the frame the lobby shows "Runs on
  game.example.com" and a reminder that this screen is not LobbyForge, so a
  "sign in" box inside it is visibly yours.
- **The app's own policy:** the instance's pages add the approved sites to
  their `frame-src` (cached for 30 seconds, refreshed on install). That only
  allows framing; nothing from your site runs in the app.
- **Your server** must let instances frame the page: no
  `X-Frame-Options: DENY` or `frame-ancestors 'none'`. Anyone can frame a
  public page, so to choose who may, send
  `Content-Security-Policy: frame-ancestors https://chat.example.org …`.
  Nothing else about your site changes: your own CSP, your own network.
- **The frame client** works unchanged ([below](#the-frame-client)): on your
  site it says `ready` to whoever frames the page, learns the lobby's origin
  from the first `init` sent by its parent window, and from then on talks to
  that origin only (`lf.parentOrigin`).
- **Local development:** with `LOBBYFORGE_PLUGIN_ALLOW_LOCAL_ORIGINS=true`
  (never in production) a `ui.url` may be `http:` on a local host. It still
  must not share the instance's host: an instance on `localhost` can frame a
  page on `127.0.0.1`, not on another `localhost` port.

### Protocol v1

Every message is a plain JSON object with `lf: 1` and a `type`.

| Direction | Message | Fields |
|---|---|---|
| parent → frame | `init` | `viewer { userId, isHost }`, `players [{ userId, name, isHost }]`, `locale`, `theme { scheme: 'dark'\|'dim'\|'light', vars: { '--lf-surface': '#111722', … } }`, `state`, `revision` |
| parent → frame | `state` | `state`, `revision` (rises with every change) |
| frame → parent | `ready` | — |
| frame → parent | `action` | `action { type, … }` |
| frame → parent | `resize` | `height` (CSS px) |

- The frame says `ready`; the parent answers with `init`. `init` comes again
  whenever players, language or theme change — handle it idempotently.
- `state` is the state **projected for this viewer** by your `projectState`
  — never the full state. Without `projectState` every viewer gets the full
  state, and the lobby shows players "This app doesn't hide information".
- The parent accepts messages only from your iframe's window **and** the
  expected origin — `"null"` for your `ui/` files, the approved URL's origin
  for your own site — checks their shape, drops anything over **64 KiB**,
  forwards at most **10 actions per second** (the rest are dropped and
  logged), clamps heights to **200–1200 px**, and replaces any `actionId`
  you send with its own idempotency key. It posts to your own site's origin
  only; to `ui/` files it has to post to `'*'` (an opaque origin cannot be
  named), which is why it never posts anything but the above.

The types and limits live in `@lobbyforge/plugin-sdk/frame`
(`FrameInitMessage`, `FrameToHostMessage`, `FRAME_MAX_MESSAGE_BYTES`, …); the
lobby validates against the same definitions.

### The frame client

```js
import { connect } from './lobbyforge-frame.js'; // or '@lobbyforge/plugin-sdk/frame' with a bundler

const lf = connect({
  onInit({ viewer, players, locale, theme }) { /* who is looking, names, language */ },
  onState(state, revision) { render(state); },   // also called right after every init
});
button.onclick = () => lf.dispatch({ type: 'buzz' });
```

`connect()` does the handshake (and repeats `ready` every 250 ms until the
parent answers), listens only to its parent window and the parent's origin
(for `ui/` files the frame URL's host; on your own site the origin of the
first `init`, readable as `lf.parentOrigin` — before it, only `ready` leaves
the frame), applies the theme —
every `--lf-*` variable on `:root`, plus `data-lf-theme`, `color-scheme` and
`lang` — and reports the content height with a ResizeObserver (measure
another element with `autoResize: el`, or pass `false` and call
`lf.resize(px)`). Style with the variables and a fallback, exactly like an
official panel: `background: var(--lf-surface, #111722)`.

The client is dependency-free and has no imports, so a plugin without a
bundler copies it in:

```sh
node packages/plugin-sdk/scripts/vendor-frame-client.mjs path/to/ui/lobbyforge-frame.js
```

A `<script type="module">` works (the route sends
`Access-Control-Allow-Origin: *`, which an opaque origin needs for modules
and fonts; the files are public anyway).

### The worked example

`examples/plugins/sandbox-buzzer/ui/` is a complete frame: the host opens a
round, everyone buzzes, the host reveals who was first — or the round
reveals itself 30 s after it opened (a `timer.set` effect firing the
`auto-reveal` system action), and a record reaction time joins the
community's leaderboard (`storage.set`, read back from `ctx.storage`). Its
manifest asks for `"permissions": ["timers", "storage"]`. It shows the
handshake, host-only controls (the server's `host` policy is what actually
enforces them), its own English and Turkish strings chosen from
`init.locale`, theme variables, and a state where the buzz order stays hidden
until the reveal because `projectState` hides it. Its `manifest.json`
declares `"requiresVoiceRoom": true` — a buzzer is played over voice — so
only people in the activity's voice room can buzz; a marketplace manifest
can mark actions `"allowOutsideVoice": true` the same way an official one
does ([PLUGIN_PUBLISHING.md](PLUGIN_PUBLISHING.md)). `apps/web/e2e-sandbox/`
runs it, and a probe that attacks the sandbox from inside, in a real browser.

## State versioning + migrators (M19)

`GamePlugin.migrateState?: (raw: unknown) => TState` is the
migration seam. The host runs it on every read against
`game_sessions.state`:

```ts
// Activity read route
const plugin = getPlugin(row.pluginId);
const state = plugin?.migrateState ? plugin.migrateState(row.state) : row.state;
```

The migrator must be **idempotent** — the same blob may be re-read
many times. The recommended shape is:

```ts
// plugins/hushle/src/state.ts
export const HUSHLE_STATE_VERSION = 1;

export function migrateHushleState(raw: unknown): HushleState {
  if (!raw || typeof raw !== 'object') return createHushleInitialState();
  const version = typeof (raw as any).version === 'number' ? (raw as any).version : 0;
  if (version === HUSHLE_STATE_VERSION) return raw as HushleState;
  let state: unknown = raw;
  if (version < 1) state = migrateV0ToV1(state);
  // if (version < 2) state = migrateV1ToV2(state);   ← add when v2 lands
  return state as HushleState;
}
```

When the plugin evolves its state shape:

1. Bump `HUSHLE_STATE_VERSION` (or your equivalent).
2. Add a step `migrateV1ToV2(state)` that takes v1 and returns v2.
3. Wire it into the chain: `if (version < 2) state = migrateV1ToV2(state)`.
4. Update the reducer to produce v2.

The next time the host reads a row persisted by the older build, the
migrator runs and the reducer sees v2 — no migration script, no
downtime, no `UPDATE` over the table. This is the right pattern for
state that lives in a JSONB column: the schema doesn't change, only
the contents.

The migrator is also called in the `actions` route before the
reducer runs, so a fresh action on an old session also upgrades the
state in the same write — the next read sees v_current without any
extra work.

## Server-only subpath exports (M18)

Plugins that ship server-only helpers (seeders, scheduled jobs,
websocket handlers, anything that pulls in `postgres` or other
Node.js modules via `@lobbyforge/db`) **must not** re-export those
helpers from the main entry point. The main entry is loaded by
the client bundle for any page that calls `getPlugin()` (the room
page, the activity picker, etc.), and pulling `postgres` into the
client bundle breaks the Next.js build with "Can't resolve 'fs'".

The fix is a **subpath export**:

```jsonc
// plugins/hushle/package.json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    },
    "./builtInPacks": {
      "types": "./src/builtInPacks.ts",
      "import": "./src/builtInPacks.ts"
    }
  }
}
```

```ts
// plugins/hushle/src/index.ts (client-safe — no @lobbyforge/db import)
export { HUSHLE_BUILTIN_PACKS, getDefaultPackSlugForLanguage, getLanguageForPackSlug } from './decks';
// Do NOT re-export the seeder from here.
```

```ts
// apps/web/lib/plugin-content-seeder.ts (server-side only)
import { seedBuiltinHushlePacks } from '@lobbyforge/hushle/builtInPacks';
```

The rule: if a plugin helper imports `@lobbyforge/db` (or anything
that transitively imports `postgres`), it goes in a separate file
behind a subpath export. The Hushle `builtInPacks` seeder is the
worked example; every new plugin that adds server-only helpers
should follow the same shape.

## Versioned component data migrations

Official plugins can ship built-in content (card decks, scenario packs,
sound clips) as trusted, versioned data migrations. Hushle's server-only
seeder remains isolated behind its subpath export:

```ts
// plugins/hushle/src/builtInPacks.ts
import { seedBuiltInPacks, type DbClient } from '@lobbyforge/db';
import { HUSHLE_BUILTIN_PACKS } from './decks';

export const HUSHLE_PLUGIN_ID = 'hushle';

export async function seedBuiltinHushlePacks(db: DbClient) {
  return seedBuiltInPacks(db, HUSHLE_PLUGIN_ID, HUSHLE_BUILTIN_PACKS);
}
```

The host registers immutable migrations in
`apps/web/lib/component-migrations.ts`:

```ts
{
  componentType: 'game',
  componentId: 'hushle',
  migrations: [{ version: 1, checksum: 'sha256:<64 hex>', run }],
}
```

The first server-side feature that needs official component content runs these
plans. PostgreSQL transaction advisory locks prevent concurrent instances from
applying the same step twice. Versions must start at 1 and remain contiguous;
checksums are immutable. Schema changes still belong to the host's committed
Drizzle SQL and run before web startup. Next instrumentation must not import the
DB because its development webpack target is Edge-compatible. Untrusted
community plugins do not get raw DB migration callbacks.

## The official plugins

Every official plugin is complete and built on the UI kit:

| Plugin | What it is | Guide |
|---|---|---|
| `hushle` | Taboo-style team word game with card packs and difficulty tiers | [HUSHLE.md](HUSHLE.md) |
| `quiz` | Timed trivia with built-in question packs, speed scoring and a leaderboard | [QUIZ.md](QUIZ.md) |
| `vampire-village` | Social deduction: hidden roles, night actions, day votes | [VAMPIRE_VILLAGE.md](VAMPIRE_VILLAGE.md) |
| `watch-party` | YouTube playback kept in sync for everyone in the room | [WATCH_PARTY.md](WATCH_PARTY.md) |
| `poll` | Anonymous one-vote-per-player polls | `plugins/poll` |
| `dice-bot` | Dice rolls with per-player stats | `plugins/dice-bot` |

They are the best reference for a new plugin: `hushle` for teams, turns
and hidden cards; `vampire-village` for per-role secrets in the
projection; `watch-party` for time sync and an embedded player; `poll`
and `dice-bot` for small, complete panels.

## Reference

- `packages/plugin-sdk/src/index.ts` — the `GamePlugin` type.
- `packages/plugin-sdk/src/locale.ts` — the shared locale helper.
- `packages/plugin-sdk/src/testing.ts` — the `createTestHarness` helper.
- `packages/plugin-sdk/src/frame/` — frame protocol v1 and the frame client;
  `apps/web/app/lobby/PluginFrame.tsx` (the lobby's side) and
  `apps/web/lib/plugin-ui-assets.ts` (the asset route and its headers).
- `plugins/hushle/src/index.ts` + `renderClient.tsx` — first fully-UI'd plugin; see
  [`docs/HUSHLE.md`](./HUSHLE.md) for the full Hushle walkthrough.
- `apps/web/lib/plugin-registry.ts` — the host's compiled-in plugin list.
- `apps/web/lib/plugin-context.ts` — the HTTP host's `buildHttpPluginContext`.
- `apps/web/lib/activity-bus.ts` — Redis pub/sub for activity state changes (M19);
  the WebSocket gateway (`apps/ws-gateway`) delivers them to open panels. The
  M19 SSE route (`…/activities/{sessionId}/stream`) was removed: nothing used it.
