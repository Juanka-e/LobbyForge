# Hushle — Aşama 4 / Taboo-style voice game

Hushle is the first fully-implemented game plugin in the LobbyForge
catalog. It is a Taboo/Tabu-style word guessing game played in a live
voice room: an explainer from the active team describes the current
word without using the forbidden words; their teammates guess; the
host scores correct / pass / penalty; the turn rotates to the next
team; the team with the highest score at the end wins.

This document covers the state machine, the reducer, the React panel,
and the voice-room host integration. The SDK-level contract (manifest,
action policies, registry adapter, test harness) is documented in
[`docs/PLUGIN_SDK.md`](./PLUGIN_SDK.md); the HTTP routes that drive
the panel are documented in [`docs/ACTIVITIES.md`](./ACTIVITIES.md).

## Quick start

1. Open the voice room for any voice channel you own or moderate.
2. Click the **Start activity** `<select>` and choose **Hushle**.
3. Pick a language (English or Turkish) and a turn duration (15–300 s,
   default 60). Click **Start game**.
4. Build at least one team by typing a name and a comma-separated list
   of user ids, then **Add team**. Repeat for as many teams as you want.
5. Click **Start turn** to begin — the first team's first explainer
   becomes the active player and the timer starts.
6. While the explainer describes the word, you (the host) tap
   **Correct**, **Pass**, **Penalty**, **Next card**, **End turn**, or
   **End game**.
7. When you click **End turn** the system rotates to the next team
   and the first player in that team's `playerIds` becomes the new
   explainer.
8. When you click **End game** the panel switches to the final-score
   view (sorted by `score` desc). The host gets a **New game** button
   that re-enters the team-setup phase.

## State machine

```ts
type HushlePhase = 'lobby' | 'team_setup' | 'playing' | 'ended';
```

```
       start-game              start-turn
lobby ─────────────► team_setup ────────► playing
                          │                  │
                          └──── end-game ────┴─────► ended
```

- **lobby** — created by `createHushleInitialState()`. Only
  `start-game` is meaningful here; everything else is a no-op.
- **team_setup** — entered via `start-game`. `set-teams` replaces the
  full team list (the host builds the teams up by repeated `set-teams`
  calls). `start-turn` moves into `playing`.
- **playing** — entered via `start-turn`. `correct-guess` / `pass` /
  `penalty` all draw the next card and bump `totalCardsPlayed`. `end-turn`
  rotates `currentTeamId` + `currentExplainerId` to the next team.
- **ended** — entered via `end-game` from any non-terminal phase.
  `start-game` (the EndedView's "New game" button) re-enters
  `team_setup` and keeps the existing scores wiped.

## State shape

```ts
type HushleState = {
  version: number;                   // HUSHLE_STATE_VERSION (currently 1)
  phase: HushlePhase;
  settings: {
    language: 'en' | 'tr';
    turnDurationSeconds: number;     // 15..300, default 60
    cardsPerTurn: number;            // current: unused (M18 will cap the turn)
  };
  teams: HushleTeam[];               // may be empty in lobby / team_setup
  deck: HushleCard[];                // created on start-game from getDefaultDeck
  deckIndex: number;                 // next card to draw
  currentCard: HushleCard | null;    // active card (null in lobby / ended)
  currentTeamId: string | null;      // active team
  currentExplainerId: string | null; // active explainer
  timer: {
    startedAt: string | null;        // ISO timestamp; null = not started
    durationSeconds: number;         // mirrors settings.turnDurationSeconds
    paused: boolean;
  };
  totalCardsPlayed: number;          // correct + pass + penalty counter
  startedBy: string | null;          // user id who ran start-game
};

type HushleTeam = {
  id: string;
  name: string;
  playerIds: string[];
  score: number;            // correct - penalty
  correctCount: number;
  passCount: number;
  penaltyCount: number;
};

type HushleCard = {
  id: string;
  language: 'en' | 'tr';
  word: string;
  forbiddenWords: string[]; // explainer may not say these
};
```

## Reducer

`plugins/hushle/src/actions.ts` exports `hushleReducer(state, action)`.
Every action is a tagged union member:

| Action type | Effect |
|---|---|
| `start-game` | set `phase='team_setup'`, build deck via `getDefaultDeck(language)`, reset `startedBy` / `totalCardsPlayed` |
| `set-teams` | replace `teams` with the supplied `{ name, playerIds }[]`, regenerate `id`s for each row |
| `start-turn` | set `phase='playing'`, draw the first card, start the timer (`startedAt = new Date().toISOString()`) |
| `set-explainer` | change `currentExplainerId` for the active team (host-only control) |
| `next-card` | draw the next deck card without scoring |
| `correct-guess` | +1 `correctCount`, +1 `score`, draw next card, `totalCardsPlayed++` |
| `pass` | +1 `passCount`, draw next card, `totalCardsPlayed++` |
| `penalty` | +1 `penaltyCount`, -1 `score`, draw next card, `totalCardsPlayed++` |
| `end-turn` | rotate `currentTeamId` to the next team (cyclical), assign `currentExplainerId` to that team's first player |
| `end-game` | set `phase='ended'`, clear `currentCard`, stop the timer |

The reducer is **pure**: it never calls `dispatch`, never touches the
DB, never logs. The host persists the post-reducer state via
`setGameSessionState` in the `actions` route.

## Action policies

All 10 actions are host-only:

```ts
actionPolicies: {
  'start-game':    { role: 'host' },
  'set-teams':     { role: 'host' },
  'start-turn':    { role: 'host' },
  'set-explainer': { role: 'host' },
  'next-card':     { role: 'host' },
  'correct-guess': { role: 'host' },
  'pass':          { role: 'host' },
  'penalty':       { role: 'host' },
  'end-turn':      { role: 'host' },
  'end-game':      { role: 'host' },
},
```

The rationale: the host is the only person who can reliably hear whether
the team guessed the word correctly. M18 will add a member-visible
"Request skip" affordance that the host confirms.

## Manifest

```ts
manifest: {
  id: 'hushle',
  name: 'Hushle',
  version: '0.2.0',
  type: 'game',
  minAppVersion: '0.1.0',
  permissions: [
    PluginPermission.MANAGE_GAME_SESSION,
    PluginPermission.MANAGE_SCORES,
    PluginPermission.SEND_ROOM_MESSAGE,
    PluginPermission.MANAGE_TIMER,
  ],
  locales: ['en', 'tr'],
  entryClient: './renderClient.js',
  catalog: {
    category: 'game',
    summary: 'Taboo-style word guessing built for live voice rooms.',
    publisher: 'LobbyForge',
    trustLevel: 'official',
    playerConfig: {
      minPlayers: 4,
      maxPlayers: 12,
      defaultMaxPlayers: 8,
      supportsSpectators: true,
      supportsQueue: true,
      overflowPolicy: 'spectator',
    },
    requiresVoiceRoom: true,
    externalAccountRequired: false,
    compatibleAppVersion: '>=0.2.0',
    tags: ['word-game', 'party', 'voice'],
  },
},
```

## Card decks

`plugins/hushle/src/decks.ts` ships two MVP decks of 24 cards each
(`getDefaultDeck(language)`). The deck counter is module-local and
resets at the start of each call so every fresh game gets a stable,
monotonically-ordered set of card ids.

### DB-backed packs (M18)

M18 moved the card packs from in-code bundles to a DB-backed
`card_packs` + `cards` schema. The structured seeds are exposed as
`HUSHLE_BUILTIN_PACKS: BuiltInPackSeed[]`:

```ts
import { HUSHLE_BUILTIN_PACKS } from '@lobbyforge/hushle';
// → [
//     { slug: 'hushle-en-basic', name: 'Hushle — English (Basic)', language: 'en', ... 24 cards },
//     { slug: 'hushle-tr-basic', name: 'Hushle — Türkçe (Temel)', language: 'tr', ... 24 cards },
//   ]
```

The host's `apps/web/lib/plugin-content-seeder.ts` runs the seeder
(`seedBuiltinHushlePacks(db)`) on the first card-packs GET request
after a fresh install. The seeder is idempotent and module-cached
so a long-running server only does the work once.

`plugins/hushle/src/builtInPacks.ts` is re-exported through a
**subpath** (`@lobbyforge/hushle/builtInPacks`) so the seeder
imports don't pull `postgres` (Node.js-only) into the client
bundle. The main `@lobbyforge/hushle` entry point stays
client-safe.

The `HushleAction.start-game` action now takes `packId: string`
(required) plus an optional `language` fallback. The reducer
resolves the language from the slug via `getLanguageForPackSlug`;
for custom/community packs the M19 work will add a real DB lookup.

The Hushle panel's lobby view accepts a `cardPacks` prop. When
the host's `ActivityPanel` fetches `/api/servers/{id}/card-packs`
and forwards the result, the lobby renders a pack dropdown
(`Hushle — English (Basic) (24)`). When the fetch fails or the
list is empty, the panel falls back to the legacy language
dropdown.

### Future card pack work

- **Community packs** (M19) — a `POST /api/servers/{id}/card-packs`
  route for trusted users to upload a JSON pack; the
  `cardPackInstalls` join table for per-server enablement.
- **Per-pack categories / difficulty** — the schema already
  supports a freeform `payload` JSONB so card shape can grow
  without a migration. v0.3.0 will add typed `category` +
  `difficulty` fields.
- **Pack versioning** — M20+ work; the `slug` is currently the
  stable identifier. If packs ever need to evolve, add
  `version` to the schema and treat `(slug, version)` as the
  unique key.

## React panel

`plugins/hushle/src/renderClient.tsx` exports `HushlePanel(props)`.
The file is marked `"use client"` (Next.js requires this for any
component using hooks) and uses inline styles so it renders correctly
without the host's CSS.

Four phase views:

| Phase | View | Purpose |
|---|---|---|
| `lobby` | `LobbyView` | language + turn-duration form, host-only Start button |
| `team_setup` | `TeamSetupView` | team list (with delete), add-team form, host-only Start turn button |
| `playing` | `PlayingView` | current team chip, timer chip, explainer label, card word (explainer + host only) or hidden-card placeholder, scores list, host-only action buttons |
| `ended` | `EndedView` | final scores sorted desc, host-only "New game" button |

### Locale loader

The panel bundles `locales/en.json` and `locales/tr.json`. The active
locale is detected from `document.documentElement.lang` (the host's
`<html lang>` attribute). A small `t(key, params)` helper does
`{name}` interpolation. The panel does not depend on
`@lobbyforge/i18n` so the plugin stays self-contained.

### Timer countdown

A `useNow(500ms)` hook ticks the clock; the panel computes the
remaining seconds from `state.timer.startedAt`. The chip turns red
when the remaining time is ≤ 10 seconds. The reducer is responsible
for the canonical timer state; the panel is a pure renderer.

### Explainer vs. guesser UI

```tsx
const isExplainer = state.currentExplainerId === actorUserId;
const isHost = hostUserId !== null && actorUserId === hostUserId;

{card ? (
  isExplainer || isHost ? (
    <CardWord card={card} />
  ) : (
    <CardHiddenPlaceholder />
  )
) : (
  <NoCardPlaceholder />
)}
```

The reducer never branches on `actorUserId`; visibility is a
panel concern. The audit log still records who dispatched what.

## Voice-room integration

The plugin renders through the existing `ActivityPanel` in
`apps/web/app/room/[roomName]/page.tsx`:

```tsx
const plugin = getPlugin(activity.pluginId);
const ui = plugin
  ? plugin.client.renderClient({
      state: activity.state,
      dispatch: (action) =>
        fetch(`/api/servers/${serverId}/activities/${sessionId}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action),
        }).then(() => revalidate()),
      actorUserId,
      hostUserId,
      players: activity.players,
    })
  : null;
return ui ?? <JsonStatePanel state={activity.state} />;
```

The fallback `<JsonStatePanel>` (a free-form action input + raw JSON
dump) is what users see when the plugin returns `null` (quiz) or when
the registry can't resolve the plugin (plugin removed in a future
release).

## Activity-route flow

`POST /api/servers/{id}/channels/{channelId}/activities` starts the
session; the route creates a row in `game_sessions` with
`pluginId = 'hushle'`, `status = 'lobby'`, and `state = createHushleInitialState()`.

`POST /api/servers/{id}/activities/{sessionId}/actions` resolves the
plugin via `getPlugin`, calls `plugin.handleAction(ctx, state, action)`,
persists the new state via `setGameSessionState`, and writes an
`activity.action` audit row with `metadata.actionType` carrying the
reducer's action type.

`POST /api/servers/{id}/activities/{sessionId}/end` ends the session
(host or `START_ACTIVITY` only); Hushle's `end-game` action does not
call this route — the reducer transitions to `ended` itself and the
session stays open so the panel can show the final-score view. The
host clicks **End** in the room (the panel's outer chrome) to call the
`end` route when the game is truly over.

## Tests

`plugins/hushle/src/__tests__/hushle.test.ts` — 12 vitest cases:

1. **Full game flow** — start, set teams, play a turn (correct-guess,
   pass, penalty), end. Asserts phase, score, counters, deck, and
   `totalCardsPlayed` after each step.
2. **Host-only enforcement** — verifies that all Hushle actions go
   through the host; the reducer itself is permissive but the route
   layer's `authorizePluginAction` against `actionPolicies` rejects
   non-host actors. The test asserts the state machine remains
   intact for an arbitrary action.
3. **end-turn rotation** — sets up two teams, starts team A's turn,
   ends the turn, and asserts `currentTeamId` + `currentExplainerId`
   rotated to team B.
4. **end-game preserves scores** — plays one correct-guess, ends the
   game, asserts `phase = 'ended'` and the team's `score` is still 1.
5. **`start-game` resolves language from the `packId` slug.**
6. **`start-game` honors `language` override when the slug is unknown.**
7. **Built-in packs include both en + tr decks (24 cards each).**
8. **Initial state carries the current `HUSHLE_STATE_VERSION`.**
9. **Migrator upgrades a pre-versioned v0 row to the current shape.**
10. **Migrator is idempotent on already-current state.**
11. **Migrator falls back to the initial state on garbage.**
12. **Registry adapter preserves the plugin's `migrateState` function.**

## State versioning (M19)

`HushleState` carries a `version: number` field. The constant
`HUSHLE_STATE_VERSION` is the current schema version (currently `1`).
`createHushleInitialState()` sets it; the reducer only ever produces
the current version.

`migrateHushleState(raw: unknown): HushleState` is the public
migrator. It's exported from the plugin and wired through the SDK's
`migrateState` field, so the host runs it on every read against
`game_sessions.state`. The chain walks a pre-versioned row forward
to the current shape; an invalid blob falls back to
`createHushleInitialState()` so the host never crashes on a bad row.

When the plugin's state shape changes in a backwards-incompatible
way, the author:

1. Bumps `HUSHLE_STATE_VERSION`.
2. Adds `migrateV1ToV2(state)` etc. to the chain in
   `migrateHushleState`.
3. Updates the reducer to produce the new version.

The next read of any row persisted by an older build upgrades it
automatically — no migration script, no `UPDATE` over the table.

## Locales (M19)

The Hushle panel calls `loadPluginLocale(HUSHLE_PLUGIN_ID, { en, tr })`
at module load, then resolves strings through the shared
`@lobbyforge/plugin-sdk` locale helper (`tFor`, `pickBestLocale`,
`detectLocale`). Adding a new language is:

1. Drop `plugins/hushle/locales/{lang}.json`.
2. Add it to the `loadPluginLocale` map in
   `plugins/hushle/src/renderClient.tsx`.

The shared helper handles the rest (region tags, fallback, insertion
order). The bot SDK has the same surface so future bots pick up the
pattern for free.

## What's next for Hushle

- **Custom + community card packs.** DB-backed `card_packs` /
  `cards` tables so the host can pick a pack on game-start instead
  of being locked to the bundled en/tr decks.
- **Member-side "request skip" affordance.** The reducer stays
  host-only but the panel shows a "request skip" button the host
  can confirm.
- **Per-turn card budget.** Use `settings.cardsPerTurn` to enforce
  end-of-turn rotation automatically.
- **Spectator view.** `supportsSpectators: true` is in the manifest
  but the panel doesn't differentiate spectators from guessers yet.
- **End-of-game chat announcement.** A `SEND_ROOM_MESSAGE` permission
  is already declared; the host can wire the `messages.sendGameMessage`
  sub-context in `M18` to post a winner announcement when `end-game`
  fires.

## Reference

- `plugins/hushle/src/state.ts` — types + `createHushleInitialState`.
- `plugins/hushle/src/decks.ts` — bundled en + tr card packs.
- `plugins/hushle/src/actions.ts` — pure reducer.
- `plugins/hushle/src/renderClient.tsx` — React panel.
- `plugins/hushle/src/index.ts` — `hushlePlugin` registry entry.
- `plugins/hushle/locales/{en,tr}.json` — UI strings.
- `plugins/hushle/src/__tests__/hushle.test.ts` — 4 vitest cases.
- `apps/web/lib/plugin-registry.ts` — `registerGamePlugin(hushlePlugin)`.
- `apps/web/app/room/[roomName]/page.tsx` — `ActivityPanel` calls `renderClient`.
- `apps/web/app/api/servers/[id]/activities/[sessionId]/route.ts` — read route joins player display names.
- `projectdetails/12_HUSHLE_PLUGIN.md` — original product spec.
