# Hushle — Taboo-style voice game

Hushle is a Taboo/Tabu-style word game played in a live voice room. Each
turn one player explains the word on a card without saying any of the
forbidden words listed under it; their teammates guess out loud. The
other team sees the card too and presses **BUST** when a forbidden word
slips out. The host scores every card and moves the game from turn to
turn; the team with the highest score when the game ends wins.

This page covers the rules as the reducer implements them, who sees what,
the panel, and how the host app runs it. The SDK contract (manifest,
action policies, test harness, the UI kit) is in
[`docs/PLUGIN_SDK.md`](./PLUGIN_SDK.md); the HTTP routes are in
[`docs/ACTIVITIES.md`](./ACTIVITIES.md).

## Quick start

1. In the lobby, join a voice channel and open **Play together** (the
   Activities hub in the centre column). Click **Hushle** — you are the
   host.
2. **Lobby.** Pick a word pack (or, when the server lists no packs, the
   card language), the turn timer, cards per turn, players per team and
   the card difficulty mix. Click **Start Hushle**.
3. **Team setup.** Everyone in the voice room is listed by name. **Split
   into two teams** seats them at random (an odd one out becomes the
   floater), or the host adds teams and seats people one by one. Click
   **Start first turn** — the first team's first player explains.
4. **A turn.** One clock for the whole turn: the explaining team gets as
   many cards as they can before it runs out. The explainer and the other
   team see the card; the explainer's teammates do not. The host presses
   **Got it**, **Skip** or **Penalty** under the card; anyone on the other
   team presses **BUST**. The host's tools also offer **Next card** (swap
   without scoring), a different **Explainer**, **End turn** and **End
   game**.
5. The turn is over when its time is up (no more cards are scored) or
   its cards are used up. The host clicks **Start next turn**: the other
   team plays, and the next player in that team's rotation explains.
6. **End game** shows the winner, the final scores and a recap. The host
   can **Start new game** with the same pack and settings.

## State machine

```ts
type HushlePhase = 'lobby' | 'team_setup' | 'playing' | 'ended';
```

```
       start-game              start-turn
lobby ─────────────► team_setup ────────► playing ◄──► between turns
                          │                  │
                          └──── end-game ────┴─────► ended ── start-game ──► team_setup
```

- **lobby** — `createHushleInitialState()`. Only `start-game` means
  anything here.
- **team_setup** — `set-teams` replaces the whole roster (every edit
  sends every team); `start-turn` begins play.
- **playing** — a turn runs while `timer.startedAt` is set, until its
  deadline `timer.endsAt`; after the deadline its scoring is over. When
  the turn's `cardsPerTurn` are used up (or the deck runs out), the
  reducer clears the card and the timer but stays in `playing`: that is
  the **between turns** state. Either way, `end-turn` starts the next
  team's turn.
- **ended** — from any phase via `end-game`. Scores stay; `start-game`
  goes back to team setup with a fresh deck and no teams.

## State shape (version 3)

```ts
type HushleState = {
  version: 3;                          // HUSHLE_STATE_VERSION
  phase: HushlePhase;
  teams: Array<{
    id; name; playerIds: string[]; score; correctCount; passCount; penaltyCount;
    nextExplainerSlot: number;         // where this team's own explainer rotation stands
  }>;
  floaterPlayerId: string | null;      // one extra player for odd counts; in every team's rotation
  turnNumber: number;                  // the current turn, 1 for the first; 0 before play
  currentTeamId: string | null;
  currentExplainerId: string | null;
  currentCard: HushleCard | null;      // { id, language, word, forbiddenWords, difficulty, category? }
  deck: HushleCard[];                  // SERVER ONLY — never sent to a client
  deckIndex: number;                   // legacy, unused by the weighted draw
  usedCardIds: string[];               // SERVER ONLY — the last one is the current card
  settings: {
    turnDurationSeconds: number;       // ≤ 300, default 60
    cardsPerTurn: number;              // ≤ 100, default 15
    language: string;                  // any language tag
    packId: string | null;             // pack slug or UUID
    teamSize: number;                  // ≤ 16, default 2
    difficultyDistribution: { easy; medium; hard };  // weights, default 0.6 / 0.3 / 0.1
  };
  timer: {
    startedAt: string | null;          // when the running turn started; null between turns
    durationSeconds: number;
    paused: boolean;
    endsAt: string | null;             // the turn's deadline — every client counts down to it
  };
  cardsPlayedThisTurn: number;
  totalCardsPlayed: number;
  createdBy: string | null;
  createdAt: string | null;
};
```

`migrateHushleState` upgrades older rows on every read (see
[State versioning](#state-versioning)).

## Reducer

`plugins/hushle/src/actions.ts` — `hushleReducer(state, action)`, pure and
defensive: an action that does not fit the phase returns the state
unchanged.

| Action | Effect |
|---|---|
| `start-game` | → `team_setup`. Deck: the pack's cards, injected by the host from `card_packs` (`apps/web/lib/prepare-plugin-action.ts`; client input is overwritten), else the bundled deck for the language. Settings are clamped; the difficulty weights are renormalised. |
| `set-teams` | Replaces the roster. Empty names are dropped, names cut to 40 characters, each team trimmed to `teamSize`. The floater is kept only if they are on no team. Every team's rotation starts at its first player. |
| `start-turn` | → `playing`: the given team, the given explainer (or the next in the team's rotation), a card drawn by difficulty weight, the turn's clock started. |
| `set-explainer` | Hands the turn to someone else; the team's rotation then continues after them. |
| `next-card` | A new card without scoring; counts toward the turn's cards. Refused once the time is up or between turns. |
| `correct-guess` / `pass` / `penalty` | +1 / 0 / −1 for the explaining team, then the next card on the same clock — or, at the turn's card budget or an empty deck, the end of the turn. Refused once the time is up or between turns. |
| `bust-forbidden` | The other team's buzzer: the same as `penalty`, accepted only when `bustedBy` (injected by the server from the session) sits on a team other than the explaining one, AND `cardId` names the card on screen. Two opponents pressing at once (or a double tap) send the same `cardId`: the first costs the penalty and draws the next card, the second names a card that is gone and is ignored — one penalty, no burnt card. `validateAction` answers 400 for a BUST without a `cardId`. |
| `end-turn` | The next team in order; the next player in its own rotation explains, and its turn starts at once on a fresh clock. |
| `end-game` | → `ended`: the card and the timer are cleared, scores kept. |

Card draw: the reducer picks a difficulty tier by the weights, then an
unused card of that tier, falling back to any unused card. A card is never
drawn twice in a game.

### Turns and the explainer rotation

Teams play in seat order. Each team has its **own** rotation — its players
in seat order — and each time the team plays, the next player in it
explains. With two teams of two, four turns give all four players one turn
each: A1, B1, A2, B2, A1, …

An odd player count leaves one player as the **floater**. The floater sits
on no team; instead they have a slot in **every** team's rotation, so in a
full round they explain once for each team while everyone else explains
once. Their slot is staggered from team to team — after the first player in
the first team's rotation, half a round later in the second's — so their two
turns fall apart, not back to back. With A = (a1, a2), B = (b1, b2) and a
floater f, the round is a1, b1, f, b2, a2, f. A team with no players of its
own is explained for by the floater every time.

When the host names the explainer (`start-turn` with an `explainerId`, or
`set-explainer` mid-turn), that team's rotation continues after whoever
actually explained, so nobody is skipped. `src/rotation.ts` holds the
rotation; the reducer, the state migration and the panel's "Next up" all
read it.

### The turn timer

A turn has **one** clock. It starts with the turn — `timer.startedAt`, and
the deadline `timer.endsAt` — and scoring a card does not restart it: the
explaining team has the whole duration for as many cards as they manage.
Every client counts down to the same `endsAt`. Once the deadline has passed
(plus a 2 s grace, `HUSHLE_TIME_UP_GRACE_MS`, for a last-second tap already
on its way), the turn's scoring is over: the reducer refuses Got it, Skip,
Penalty, BUST and Next card until the host starts the next turn.

## Action policies

```ts
actionPolicies: {
  'start-game': { role: 'host' }, 'set-teams': { role: 'host' }, 'start-turn': { role: 'host' },
  'set-explainer': { role: 'host' }, 'next-card': { role: 'host' },
  'correct-guess': { role: 'host' }, pass: { role: 'host' }, penalty: { role: 'host' },
  'bust-forbidden': { role: 'member', actorFields: ['bustedBy'] },
  'end-turn': { role: 'host' }, 'end-game': { role: 'host' },
},
```

The host moderates: only they can hear whether a guess was right. BUST is
the one player action — any server member in the voice room may send it
(Hushle declares `requiresVoiceRoom`, so the host refuses it from outside
the room with `voice_required`), the server fills `bustedBy` with the
caller, and the reducer checks the team and the card.

`restartActions: ['start-game']`: on the final screen the host's **Start
new game** sends `start-game` with the last game's pack and settings, which
the host route accepts from the `ended` phase (back to team setup, the
pack's deck injected again); every other action on a finished game is
refused with 409 `session_ended`. If the host leaves the voice room, hosting
moves after 60 s to the longest-present participant there
([PLUGIN_SDK.md → Voice, hosting and play again](PLUGIN_SDK.md#voice-hosting-and-play-again)).

## Who sees what

The server projects the state for each viewer before it leaves
(`packages/core/src/activity-projection.ts`, used by the web routes and
the realtime gateway alike):

- `deck` and `usedCardIds` never reach any client; they become
  `deckSize`, `cardsRemaining` and `usedCardCount`.
- `currentCard` reaches only the **explainer** and the players of the
  **other teams**. The explainer's teammates, the floater, spectators and
  a host who does not play get `null`.

The panel never decides visibility; it shows what it was sent and words
each viewer's job to match.

## Manifest

`id: 'hushle'`, `version: '0.3.0'`, `type: 'game'`, the four permissions
(`MANAGE_GAME_SESSION`, `MANAGE_SCORES`, `SEND_ROOM_MESSAGE`,
`MANAGE_TIMER`), `locales` from the files in `locales/`, and a catalogue
entry for 4–12 players (default 8) with spectators, a queue and
`requiresVoiceRoom`. The catalogue summary is `catalog.summary` in the
locale files.

## Custom words & server-local cards (status)

Where words come from, and what is NOT wired yet (honest status, V4-009):

- **Packs** live in `card_packs`/`cards` and are managed from
  **Admin → Plugins & Word Packs** (any BCP-47 language; built-in packs are
  immutable, Duplicate-to-custom to edit them).
- **`server_local_cards`** (per-server extra words unioned into the deck)
  is **infrastructure only** today: the table, the language scope
  (migration 0026 — `NULL` = shared across all languages) and the loader
  filter exist, but there is **no creation API/UI** and **no backfill** for
  pre-0026 rows (they stay `NULL`/language-less, i.e. shared with every
  deck). Adding the "server-specific words" editor is future work; until
  then the feature is effectively dormant.

## Card decks

`plugins/hushle/src/decks.ts` ships two decks of 24 cards (English and
Turkish), each card with a difficulty (14 easy, 7 medium, 3 hard) and a
category slug (`food-drink`, `places`, `nature`, …). The panel translates
the built-in category slugs and shows any other category as written.

### DB-backed packs (M18)

The structured seeds are exposed as `HUSHLE_BUILTIN_PACKS`:

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

`start-game` takes `packId` (a slug or a UUID); the host resolves the pack
and injects its cards and language.

The panel's lobby receives the server's packs as `cardPacks` (the host
fetches `/api/servers/{id}/card-packs` while the session is in its lobby
phase) and shows one tile per pack. Without packs — the fetch failed or
the list is empty — it offers the two built-in languages instead and
starts `hushle-en-basic` or `hushle-tr-basic`.

### Future card pack work

- **Community packs** — a `POST /api/servers/{id}/card-packs` route for
  trusted users to upload a JSON pack; per-server enablement.
- **Pack versioning** — the `slug` is currently the stable identifier. If
  packs ever need to evolve, add `version` to the schema and treat
  `(slug, version)` as the unique key.

## The panel

`plugins/hushle/src/renderClient.tsx` exports `HushlePanel`, built from
the activity UI kit (`@lobbyforge/plugin-sdk/ui`) to the "Calm Future"
design (the Hushle and Plugin UI artboards). The phase views live in
`src/ui/`:

| File | What it holds |
|---|---|
| `renderClient.tsx` | The root: locale, `ActivityShell`, Hushle's stylesheet, the phase switch, the "this turn" log. |
| `ui/lobby.tsx` | Host settings, the no-packs language fallback, how to play, the waiting screen. |
| `ui/setup.tsx` | The room's people to seat by name, the two-team split, teams and open seats, the add-team form, the floater. |
| `ui/playing.tsx` | A running turn (card column, host scoring, BUST), the pause between turns, who-sees-the-card, this turn, host tools. |
| `ui/ended.tsx` | Winner (or tie), final scores, recap, new game. |
| `ui/card.tsx` | The card face and the hidden-card state. |
| `ui/scoreboard.tsx` | The team board: scores, players and their job this turn, the floater. |
| `ui/shared.tsx` | The header, the view props, the host tap lock, "(you)". |
| `ui/model.ts` | Pure view logic: roles, timer, next-up preview, standings, settings, action builders, the turn log. |
| `ui/labels.ts`, `ui/i18n.tsx` | Values to translated words; the translator context and `Intl` helpers. |
| `ui/theme.ts`, `ui/parts.tsx` | Difficulty colours and team tones; small generic pieces the kit does not ship (text field, choice tile, empty seat, visually hidden text, icons). |

### What each seat sees

| Phase | Host | Explainer | Teammates | Other team | Floater | Spectator |
|---|---|---|---|---|---|---|
| Lobby | Settings, **Start Hushle** | — | — | — | — | Waiting, how to play |
| Team setup | The room by name, **Split into two teams**, seat / unseat / floater, add a team, **Start first turn** | — | — | — | — | Teams, settings, who is not seated yet, waiting |
| Turn | **Got it / Skip / Penalty** under the card (the card if the host is the explainer or on the other team), host tools, **End turn / End game** | The card; "the host scores each card" | "Listen to …" — no card | The card and **BUST** | "… is explaining" — no card | "… is explaining" — no card |
| Time's up, or between turns | "Next up" and who explains, **Start next turn / End game** | Waiting | Waiting | Waiting | Waiting | Waiting |
| Ended | Winner, scores, recap, **Start new game** | Winner, scores, recap | ← | ← | ← | ← |

A host who plays also has that seat's view. A host on the other team gets
**BUST** instead of **Penalty** — both cost the explaining team a point
and draw the next card, and two red buttons doing the same thing would
only make them hesitate.

### Layout

- **Header** (every phase): the Hushle tile, who hosts and the deck count,
  the phase ("Turn 3", "Turn over", …), the timer while a turn runs, and —
  always in this spot — the host's controls for moving on: Start Hushle,
  Start first turn, End turn / Start next turn, End game, Start new game.
- **Body**: a two-column grid (`Grid min={340}`) that stacks when the
  centre column is narrow — the card column (role line, card, the viewer's
  buttons) and the information column (team board, who sees the card,
  this turn, host tools).

### The card

A coloured top bar and border by difficulty — easy blue, medium purple,
hard red — with the difficulty's name and one, two or three pips in the
top-right, so colour is never the only cue. A category chip, the word in
large type, and the forbidden words struck through in red under "Don't
say". The word and the forbidden list carry `lang={card.language}`: the
pack's language may not be the panel's (an English pack in a Turkish app),
and the tag is what makes uppercasing ("şişe" → "ŞİŞE") and screen-reader
pronunciation right. Viewers without the card get a card-shaped
placeholder that says what to do instead ("Listen to Mira").

### Guards against double taps

- **BUST** stays disabled after a press until a different card arrives
  (a bust always rotates the card), keyed on the card id.
- The host's **Got it / Skip / Penalty / Next card** lock after a press
  until the next state arrives (keyed on a fingerprint of the card in
  play), and unlock by themselves after 4 s if the move never landed.
- The server also de-duplicates retries by `actionId`.

### "This turn"

The reducer keeps totals, not a history, so the panel keeps a short log by
comparing each state with the one before: a counter of the explaining
team moved (got it, skipped, bust — a host penalty and a bust are the same
event), or a card was swapped without scoring. Words appear only for
viewers who saw the card. The log lives in the viewer's browser; a reload
starts it afresh and the scores stay the source of truth.

### Settings the lobby offers

Only options `start-game` already takes: the pack, `turnDurationSeconds`
(30, 45, 60, 90, 120 s — the whole turn's clock), `cardsPerTurn` (5, 10,
15, 20), `teamSize` (2–6)
and `difficultyDistribution` through three presets — **Easier** (80 / 20 /
0), **Mixed** (60 / 30 / 10, the reducer's default) and **Harder** (20 /
40 / 40) — with the mix spelled out under the choice. **Start new game**
on the end screen sends the finished game's settings again.

### Accessibility and theming

Real buttons with visible labels; the icon-only one (removing a player)
has an `aria-label`, and a button whose spoken name says more than its
text ("Add Sam to Ice") still contains that text; `aria-pressed` on
choices; the BUST button is described by its hint; the timer is a
`role="timer"` with a spoken label; scores have spoken text ("7 points");
a polite live region announces each card's outcome. Every colour comes
from the kit's `--lfui-*` variables or Hushle's own `--hushle-*`
variables, with lighter-background text shades under `.lf-theme-light`.

## Voice-room integration

The lobby's Activities hub (`apps/web/app/lobby/LobbyActivityView.tsx`)
and the room page mount the panel through `PluginSurface`, which gives it
its own component instance and tags it with the plugin's language:

```tsx
<PluginSurface
  pluginId="hushle"
  render={plugin.renderClient}
  props={{
    state,                 // projected for this viewer
    dispatch,              // POSTs to the actions route; the host's own move applies the response at once
    actorUserId,
    hostUserId,            // the session's creator
    players,               // the people in the room: the voice channel and anyone who has acted
    cardPacks,             // the server's packs, while in the lobby phase
  }}
/>
```

Other players receive each new state over the realtime gateway, or by
polling every 5 s when it is unavailable.

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
lobby's **End** control (outside the panel) calls the `end` route when
the activity is truly over.

## Tests

`plugins/hushle/src/__tests__/`:

- `hushle.test.ts` (36) — the reducer: every action, teams and floater,
  the per-team rotation (four turns for four players, the floater once
  for each team, an explainer picked by hand), the turn clock and time's
  up, weighted draw, BUST rules, migrations up to v3.
- `panel-model.test.ts` (25) — the panel's pure logic: each viewer's role
  against the projection, the deadline, the next-up preview checked
  against what `end-turn` really does over a full round, standings,
  settings round-tripped through the reducer, the two-team split,
  `set-teams` payloads, the "this turn" log over real reducer transitions.
- `panel.test.tsx` (40) — the panel mounted in a DOM: every phase and
  seat, seating by name and splitting the room, time's up, the exact
  action each button dispatches, the double-tap guards, Turkish rendering
  and "no raw key anywhere". `harness.tsx` holds the
  fixtures, a restatement of the server projection, and the DOM: the
  package does not depend on react-dom or a DOM library, so the harness
  borrows react-dom from `@lobbyforge/plugin-sdk` and happy-dom from
  `apps/web` (adding both as devDependencies would let it use plain
  imports).
- `locales.test.ts` (8) — every key the panel uses exists, no key goes
  unused, Turkish matches English's placeholders.
- `render-client.test.tsx` (2) — `renderClient` returns an element.

`apps/web/e2e/activity-hushle.spec.ts` plays a short game through the
real lobby UI with four browser contexts (see the file for how to run
it); `compose-stack.spec.ts` covers the same rules through the API.

## State versioning

`HUSHLE_STATE_VERSION` is `3`. `migrateHushleState(raw)` is wired as the
plugin's `migrateState`, so the host upgrades any persisted row on read:
version 0 rows gain `version`; version 1 rows gain the floater,
`usedCardIds`, `teamSize`, the difficulty weights and a difficulty on
every card; version 2 rows trade the single `currentExplainerIndex` for a
rotation cursor on every team and a `turnNumber`, and a running turn gets
its deadline (`endsAt` = start + duration). A game in progress keeps its
explaining team's rotation going after whoever explains now; the other
teams start theirs afresh. Garbage falls back to the initial state. To
change the shape: bump the constant, add a `migrateV3ToV4` step, and make
the reducer produce the new version.

## Locales

`plugins/hushle/locales/<code>.json` — flat keys prefixed `hushle.`, plus
`catalog.summary`. English and Turkish are complete. `pnpm i18n:sync`
regenerates `src/locales.generated.ts`; `pnpm i18n:add <code>` scaffolds a
new language. Keys are written out in full in the panel's files
(`t('hushle.lobby.packLabel')`), because the locales test finds them by
reading those files. Counts use plurals. See
[TRANSLATING.md](TRANSLATING.md).

## Known gaps

- **No pause.** `timer.paused` exists but no action sets it, so the panel
  has no pause/resume control.
- **No "ready".** Players have no ready state; the lobby and team setup
  show who is seated instead.
- **Seating mid-game.** `set-teams` works only before play, so someone who
  joins the voice room during a game watches until the next one.

Fixed in state version 3: every player now explains in turn (each team
has its own rotation), the floater explains for both teams, and the turn
timer runs once per turn instead of restarting on every card.

## Reference

- `plugins/hushle/src/state.ts` — types, `createHushleInitialState`, `migrateHushleState`.
- `plugins/hushle/src/decks.ts` — the bundled English and Turkish decks.
- `plugins/hushle/src/actions.ts` — the reducer, `hushleExplainerQueue` and `hushleNextExplainerForTeam`.
- `plugins/hushle/src/rotation.ts` — the explainer rotation.
- `plugins/hushle/src/renderClient.tsx` and `src/ui/` — the panel.
- `plugins/hushle/src/index.ts` — the `hushlePlugin` registry entry.
- `plugins/hushle/locales/{en,tr}.json` — UI strings.
- `packages/core/src/activity-projection.ts` — who sees the card.
- `apps/web/lib/prepare-plugin-action.ts` — the pack → deck injection.
- `apps/web/app/lobby/LobbyActivityView.tsx`, `apps/web/app/room/PluginSurface.tsx` — where the panel mounts.
- `projectdetails/12_HUSHLE_PLUGIN.md` — the product spec.
