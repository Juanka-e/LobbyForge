# Vampire Village

A hidden-role social deduction game for a voice room (spec:
`projectdetails/13_VAMPIRE_VILLAGE_PLUGIN.md`, roadmap Aşama 7). Vampires hide
among the villagers; every night they bite someone, every day the village
talks and votes to hang a suspect. 5–12 players, played inside the lobby's
activities hub like Hushle.

| | |
|---|---|
| Plugin id | `vampire-village` (package `@lobbyforge/vampire-village`, `plugins/vampire-village`) |
| Players | 5–12; late joiners and the dead watch as spectators |
| Languages | English, Turkish (`locales/*.json`) |
| Where | Any voice or stage channel, once a server admin installs and enables the app (Admin → Apps) |

## How to start

1. A server admin installs **Vampire Village** in *Admin → Apps* (or
   `POST /api/servers/{id}/apps {"pluginId":"vampire-village","enabled":true}`).
2. In the lobby, someone with the *Start activity* permission opens the
   activities hub of a voice channel (*Play together*, or *Activities in this
   room* from the voice view) and starts **Vampire Village**. They are the host.
3. Everyone who wants to play opens the hub, creates a character (a name
   and a card colour) and presses **I’m ready**.
4. With at least 5 players, all ready, the host presses **Start the game**.

## A round

| Phase | What happens | Timer | Ends |
|---|---|---|---|
| Lobby | Characters, readiness, the host sets the timers | — | Host starts |
| Roles | Everyone sees their own role card; vampires meet their pack | 10 s | Timer or host |
| Night *n* | Night roles act in secret; vampires pick a victim together | 30 s (15–180) | Everyone with a choice has made it, the timer, or the host |
| Dawn | The village learns who died, how, and what role they had | 5 s | Timer or host |
| Day *n* · discussion | Talk (voice or the village chat) | 90 s (30–600) | Timer or host |
| Day *n* · vote | One vote per living player, changeable | 30 s (15–180) | Everyone living has voted, the timer, or the host |
| Verdict | Who was hanged (and their role), or nobody | 5 s | Timer or host |
| Game over | The winner, every role, the whole story | — | Host: *Play again* |

Timers are deadlines stored in the state (`phaseEndsAt`). Every panel counts
down to the same moment. **Only living vampires see the night clock** (spec
§13) — everyone else sees *Night…*; the night length is still a public
setting, so this is presentation, not a secret.

## Roles

The MVP roles (spec §23). Everyone starts with their own role card; no one
else's role is shown until that player dies.

| Role | Team | At night | Notes |
|---|---|---|---|
| Vampire | Vampires | Bites one player, together with the pack | A **majority of the living pack** must pick the same target (1 of 1, 2 of 2, 2 of 3). Cannot bite a vampire. Sees the pack and the pack chat. |
| Villager | Village | — | Voice and vote. |
| Seer | Village | Looks into one other player | Learns their exact role **at dawn**. |
| Doctor | Village | Protects one player (themself allowed) | Not the same player two nights in a row. Stops a bite or a shot. |
| Hunter | Village | From night 2, may shoot someone (2 bullets) | If the shot kills a **village-team** player, the hunter dies of remorse. Shooting a vampire or a neutral is free. |
| Survivor | Neutral | Raises a shield, or not (3 shields) | A raised shield is spent even on a quiet night; it stops any attack on the survivor. Wins by being alive at the end, whoever wins. |
| Jester | Neutral | — | Wins if the village **hangs** them (the game goes on). Dying any other way is a loss. |

### Who gets which role

Spec §8, limited to the MVP roles; seats the table gives to Phase 2 roles
(witch, detective, arsonist, gossip, Eros, mayor, fool) are plain villagers.

| Players | Vampires | Village team | Neutral |
|---|---|---|---|
| 5 | 1 | seer, doctor, 1 villager | survivor |
| 6 | 1 | seer, doctor, hunter, 1 villager | survivor |
| 7 | 1 | seer, doctor, hunter, 1 villager | survivor, jester |
| 8 | 2 | seer, doctor, hunter, 1 villager | survivor, jester |
| 9 | 2 | seer, doctor, hunter, 2 villagers | survivor, jester |
| 10 | 3 | seer, doctor, hunter, 2 villagers | survivor, jester |
| 11 | 3 | seer, doctor, hunter, 3 villagers | survivor, jester |
| 12 | 3 | seer, doctor, hunter, 4 villagers | survivor, jester |

Roles are shuffled on the server (`crypto.getRandomValues`) when the host
starts; the start action carries nothing a client could steer.

## The night, resolved

When the night ends, the choices resolve in the spec §10 order:

1. **Information** — the seer's result.
2. **Protection** — the doctor's patient; the survivor's shield (if raised).
3. **Attacks** — the hunter's shot, then the pack's bite. A protected or
   shielded target survives; the first attack that lands names the cause.
4. **Results** — the hunter's remorse, the private notes, the public log.

Night 1 is quiet for the hunter (spec §9: the first night is for
information; the vampires still bite). Choices can be changed until the
night ends; the night ends early once every living vampire majority, seer,
doctor, hunter (with bullets, from night 2) and survivor (with shields) has
decided. "Skip tonight" / "Hold fire" / "Stay unguarded" count as decisions.

At dawn everyone reads who died, how (*bitten*, *shot*, *died of remorse*),
and their role. If an attack was stopped, the village hears that **an attack
was stopped** — not whom it was aimed at; the saved player and the doctor
learn it privately.

## The vote

- One vote per living player, for another living player or for **no one**;
  it can be changed until the vote closes.
- **A majority of the living hangs** (more than half: 3 of 5, 4 of 6). No
  majority — nobody is hanged. With a strict majority a tie cannot happen.
- The vote closes when everyone living has voted, when the timer runs out,
  or when the host closes it.
- Votes are public while they are cast (spec §14): each row shows who voted.

## Winning (spec §12)

- **Village**: every vampire is dead.
- **Vampires**: the living vampires are at least as many as the living
  **village team** (neutrals do not count).
- If the last vampire and the last village-team player fall together, no team
  wins.
- **Survivor**: alive when the game ends — wins alongside whoever won.
- **Jester**: hanged at any point — has already won.
- Everyone on the winning team wins, dead or alive.

The end screen shows the winner, every player's role and fate, a
night-by-night timeline (every seer look, protection, shot, shield and the
votes) and what the pack whispered.

## Talking

- **Village chat** — living players, by day (dawn, discussion, vote,
  verdict); read-only at night; everyone who played may talk after the game.
  10 messages per player per phase; the last 60 are kept.
- **Pack chat** — living vampires, during the role reveal and at night.
  12 whispers per vampire per phase; the last 40 are kept. Only vampires ever
  receive it (until the game ends).
- The voice room itself is not muted by the game in this MVP: the panel asks
  players to keep quiet at night and the dead to give no hints.

## What each seat sees

The server projects the state separately for every viewer
(`projectActivityState` in `packages/core/src/activity-projection.ts`, used by
the REST routes and the realtime gateway alike). Everything secret lives
under `state.secret` and is removed for everyone while the game runs; each
viewer gets only their own slice as `me`.

| Information | Living player | Living vampire | Dead player | Spectator | After the game |
|---|---|---|---|---|---|
| Own role, own notes, own resources | ✅ | ✅ | ✅ | — | ✅ |
| Own choice tonight | ✅ | ✅ | — | — | ✅ |
| Fellow vampires, the pack's votes, pack chat | — | ✅ | — | — | ✅ |
| Another player's night choice or private result | — | — | — | — | ✅ |
| Roles of the dead, causes of death | ✅ | ✅ | ✅ | ✅ | ✅ |
| Living players' roles | — | fellow vampires only | — | — | ✅ |
| Votes, the village chat, the event log | ✅ | ✅ | ✅ | ✅ | ✅ |

The host sees exactly what their own seat sees — host controls never reveal
a role (anti-cheat: the projection is applied to the host too).

## Host controls

In the lobby: the timers, removing a player, **Start the game**. During the
game: move on (*Start the night*, *End the night*, *Start the day*, *Start the
vote*, *Close the vote*, *Continue*), **Pause/Resume** (actions wait while
paused), **+30 s**, the timers for the next phases, **Remove from the game**,
and **End the game** (no winner; everything is revealed). After the game:
**Play again** (same village, fresh lobby, same timers).

## Leaving and joining

- Leaving the lobby frees the seat; the host can remove players.
- A living player who leaves mid-game (or is removed by the host) counts as
  dead — "left the village" — and their role is revealed. Their vote and any
  vote or night choice aimed at them are dropped; the win check runs.
- Anyone who joins after the roles are dealt (or when the lobby is full)
  watches as a spectator.

## Rule decisions

Where the spec was silent, offered options, or contradicted itself:

- **Vote rule: majority of the living** (the design's rule: "A majority of the
  living is needed. Ties mean no one leaves today."), instead of the spec §11
  plurality with a run-off on a tie. A strict majority makes the run-off
  unnecessary; plurality + run-off is a possible follow-up setting.
- **Roles are revealed on death**, night deaths included — spec §13 (the dead
  card shows the role) and the design, over the §14 table that hides a night
  victim's role from the living.
- **Saved players are not named publicly** at dawn (the spec says the dawn
  shows "who was saved"): naming them would tell the vampires where the doctor
  was, and the doctor cannot protect them again the next night.
- **The vote closes early** once every living player has voted.
- **Doctor**: may protect themself (the spec only forbids the same target on
  consecutive nights).
- **Survivor**: raising a shield spends it, attacked or not.
- **Hunter**: remorse applies when the shot lands on a village-team player,
  even if the vampires bit the same player.
- **Jester**: the win is recorded when hanged; the game continues.
- **Night 1**: only the hunter sits out (killing roles other than the pack
  wait for night 2); the doctor and the survivor act.
- **Text mode only** (the spec's MVP): no server-side voice muting yet.
- **No lobby chat**: the voice room and the channel chat cover the lobby.
- **Character**: a name (unique in the village, 24 characters) and one of 8
  card colours; no custom icon or bio.
- **Fixed short phases**: role reveal 10 s, dawn 5 s, verdict 5 s (spec §9);
  night, discussion and vote are the host's to set.

## Not in the MVP (spec Phase 2)

Voice + text mode with server-side muting, the witch, detective, gossip,
arsonist, Eros, mayor and fool, last words, the jester's revenge, ambient
sound, role-use effects, statistics/MVP on the end screen, manual role
assignment, a dead-only chat, reconnect timers and pause-on-disconnect
(today a leaver simply counts as dead).

## For developers

```
plugins/vampire-village/
  src/state.ts        types, limits, initial state, migrateVillageState (v1)
  src/rules.ts        role deal, teams, majority, fixed timers
  src/reducer.ts      the reducer (server clock + CSPRNG injected)
  src/validate.ts     validateAction — shape checks before dispatch
  src/view.ts         the projected VillageView + the panel's pure helpers
  src/renderClient.tsx  the panel root ('use client')
  src/ui/             phase views, pieces, palette, key maps
  locales/en.json, tr.json
```

- **State**: public fields at the top level, every secret under
  `state.secret` (roles, tonight's choices, private notes, resources, pack
  chat, night history). A new secret goes under `secret` and is hidden by
  default. `version: 1`; anything else migrates to a fresh lobby.
- **No side doors**: a secret write never touches a public field — the pack
  chat numbers its messages with `secret.packSeq`, not the public `seq`, so
  public log/chat ids have no gaps to count whispers by. One host-level
  channel remains: the realtime bus announces every committed action, so a
  watcher can tell *that* something happened at night (never who or what).
  Closing it would take the host publishing only when a viewer's projection
  changes.
- **Actions**: player actions are `member` with `actorFields: ['playerId']` —
  the reducer keeps its own roster and checks seat, life, role and phase;
  table controls are `host`. Every refused action returns the same state
  object.

  | Action | Who | |
  |---|---|---|
  | `join` `{ name, color? }` | member | Take a seat (lobby) or watch (running) |
  | `leave`, `set-ready {ready}` | member | |
  | `night-target {targetId \| null}` | member | Bite / look / protect / shoot; `null` = skip or take back |
  | `night-shield {raise}` | member | Survivor |
  | `vote {targetId \| null}` | member | `null` = no one |
  | `chat {text}`, `pack-chat {text}` | member | |
  | `timeout {phaseId}` | member | Accepted once the server clock passes the deadline (1 s grace) |
  | `configure {settings}`, `start`, `kick {targetId}`, `advance {phaseId}`, `pause`, `resume`, `extend {seconds}`, `play-again`, `end-game` | host | |

- **Timers**: the server has no scheduler, so clients report a deadline. The
  host's panel reports 0.4 s after it; seat *n* waits 2.5 s + 0.9 s·*n*;
  spectators 15 s — so normally one request moves the game on, and a closed
  host tab never stalls it.
- **Rate limit**: the activity action route allows 30 actions a minute per
  client address (all players behind one address share it, so configure
  `LOBBYFORGE_TRUSTED_PROXY` behind a proxy). A full 6-player round is about
  25 actions.
- **Tests**: `pnpm --filter @lobbyforge/vampire-village test` (reducer, rules,
  validation, view helpers, locales, a server render of every phase);
  hidden-information rules in
  `packages/core/src/__tests__/activity-projection.vampire.test.ts`; a
  six-browser game in `apps/web/e2e/activity-vampire-village.spec.ts`
  (compose stack).
