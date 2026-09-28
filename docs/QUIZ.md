# Quiz

Trivia rounds for a voice room: everyone sees the same question, answers on
their own screen, and the fastest right answers score the most. The host
picks a built-in question pack (English or Turkish) or pastes their own
questions, and paces the game.

Code: `plugins/quiz` (`@lobbyforge/quiz`; the built-in packs' questions are
behind the server-only subpath `@lobbyforge/quiz/packs`). Hidden information:
`packages/core/src/activity-projection.ts` (the `quiz` block). Host
hydration: `apps/web/lib/prepare-plugin-action.ts` (the `quiz` branch). Tests:
`plugins/quiz/src/__tests__/`, `packages/core/src/__tests__/activity-projection.quiz.test.ts`,
`apps/web/e2e/activity-quiz.spec.ts`.

## How a game runs

| Phase | What happens |
|---|---|
| `lobby` | Anyone in the channel can **join** (or stay a spectator). The host sets the quiz up: a pack or their own questions, how many questions, time per question, shuffle. **Start** needs at least one player. |
| `playing` | One question is open until its **deadline**. Each player locks **one** answer. The question is revealed as soon as every player has answered, when time is up, or when the host presses **Reveal now**. |
| `reveal` | The right answer, how many players picked each option (counts only — never who), the viewer's own result and the leaderboard with this round's gains. The host presses **Next question** (or **See final results** after the last one). |
| `ended` | Podium (top three, ties share a place, zero scores are left off), the full ranking with each player's right answers and best streak, and the game's numbers. |

The creator of the activity is the host and starts on the player list; a
host who wrote the questions (and so knows the answers) should leave the
list and only host — the setup screen says so.

**Late joiners.** Joining mid-game is always allowed; the new player answers
from the **next** question, never the one already open, and does not hold up
"everyone has answered". **Spectators** see every question and reveal, and
can join at any time the same way.

**Leaving.** Before the start, leaving removes you. Mid-game you keep your
points and stay on the leaderboard (marked "left"); an answer you locked
before leaving still counts. If the last player still thinking leaves, the
question is revealed. Coming back re-activates you from the next question.

**Ending early.** The host can end the quiz at any time. A question that is
still open is void: nobody scores it. `ended` is final — the host's action
route refuses every action once a quiz has ended — so another round means
ending the activity and starting Quiz again (the final screen tells the host).

**Names** come from the host, never from the client. The activity route adds
everyone who acts to the session roster before the reducer runs, so on
`join` the reducer stores `ctx.players.get(id).name`; the panel prefers the
live name from its `players` prop, then that stored name, then "Player N".

## Timing

A question has a **deadline** (server epoch ms) in the state, never "seconds
left": every client counts down to the same moment.

- Answers are accepted until `deadline + 1 s` (`QUIZ_ANSWER_GRACE_MS`), so an
  answer sent just before the deadline is not lost in transit. Answers in
  that second score base points only (no speed bonus).
- The HTTP host has **no server timers** (`ctx.timer` is inert), so "time's
  up" is an action — `time-up` — that any member may send and the reducer
  honours **only** once the server clock is past `deadline + 1 s`. Sending it
  early changes nothing. The host's panel sends it 1.2 s after the grace
  period; players' panels 3.5–5 s after it (staggered per user) in case the
  host is away; each retries up to four times. Spectators never send it.
- Moving on from a reveal is **host-driven** (no auto-advance without server
  timers).

## Scoring

Only **right** answers score; wrong or missing answers score 0. Points are
added at the reveal — never while a question is open, so scores cannot be
used to probe which option is right.

```
points = 500                                   base
       + round(500 × timeLeft / timeAllowed)   speed, 0–500
       + min(100 × (streak − 1), 300)          streak bonus
```

`timeLeft` is measured from the moment the server received the answer to the
deadline (0 inside the grace second). `streak` counts consecutive right
answers including this one: the 2nd in a row adds 100, the 3rd 200, the 4th
and later 300. A wrong answer or a question the player could have answered
but didn't resets the streak; a question they sat out (joined later, or had
left) doesn't.

So a question is worth 500–1,300 points. Examples (20 s question): right
after 0 s → 1,000; after 10 s → 750; at the deadline → 500; after 5 s on a
3-answer streak → 500 + 375 + 200 = 1,075.

**Ranking:** by score, then right answers, then join order. Equal scores
share a rank (1, 2, 2, 4) and a podium place.

## Setup

| Setting | Values | Default | Notes |
|---|---|---|---|
| Questions | a built-in pack, or your own | the first pack in the host's language | |
| Number of questions | 5, 10, 15, 20 | 10 | Capped by what the source has. |
| Time per question | 10, 20, 30 s | 20 s | |
| Shuffle | on / off | on | **On:** a random subset in random order, and every question's answers in random order. **Off:** the first N questions exactly as written. |

Randomness is drawn by the reducer on the server (`Math.random`, injected as
`env.random` so tests are deterministic); no action field can seed or steer
it, and the deck never reaches a client.

**How a pack game starts.** The host's panel sends only
`{ type: 'start', source: 'pack', packId, language, questionCount,
secondsPerQuestion, shuffle }`. On the server, the activity route's prepare
step (`preparePluginAction` → `hydrateQuizPackStart` from
`@lobbyforge/quiz/packs`) loads that pack's questions and puts them in the
action's `questions`, replacing anything the client sent — a pack game only
ever plays the pack; an unknown pack is a 404. The reducer then picks and
shuffles as above. The reducer never looks a pack up itself: a pack `start`
that was not hydrated plays nothing.

### Your own questions

Paste them in the setup screen:

```
Which planet is closest to the Sun?
*Mercury
Venus
Mars

How many days are there in a leap year?
365
*366
367
```

One question per block, blank lines between blocks; the first line is the
question, then 2–6 answers, the right one marked with a leading `*`. "1." on
questions and "A)" / "-" on answers are tolerated. The panel checks the text
as you type and names the question that has a problem; the server validates
again (`quizValidateAction`: non-empty text ≤ 300 characters, 2–6 different
answers, one valid right answer, at most 50 questions).

A JSON array in the old shape (`[{ "question", "options", "correctIndex" }]`)
is accepted too, and the old `set-questions` action still works: it starts a
custom quiz straight away with every question in the given order.

## Built-in packs

| id | English | Türkçe |
|---|---|---|
| `general` | General Knowledge | Genel Kültür |
| `science` | Science & Nature | Bilim ve Doğa |
| `geography` | Geography | Coğrafya |

Each has 24 questions with exactly four answers. The questions live in
`src/packs/data/*` and are reachable only through `src/packs/server.ts` —
the `@lobbyforge/quiz/packs` subpath the host imports on the server. What
the panel (and the plugin's main entry) gets is the catalogue in
`src/packs/catalog.ts`: id, language, title, description and question count.

The Turkish packs are written for Turkish players (Turkish literature,
history and places sit next to the classics), not translated from the
English ones. The setup screen lists the viewer's language first, then
"Other languages".

Content rules the packs follow:

- **Stable, uncontroversial facts only** — nothing that changes (records,
  rankings, populations, "the current …") and nothing disputed (for example
  "the longest river", where sources disagree).
- The right answer's position is spread evenly over A–D (6 each), so a game
  with shuffle off has no pattern to learn.
- Wrong answers are plausible answers of the same kind (other capitals,
  other planets, other authors of the period).

### Adding a pack

1. Write the questions in `plugins/quiz/src/packs/data/<id>.<language>.ts`
   (copy an existing file): an array of `q(id, question, [four answers],
   correctIndex)`. Question ids are `<first 3 letters of the pack
   id>-<language>-NN`.
2. Register them in `src/packs/server.ts` (the `QUESTIONS` map).
3. Add the catalogue entry — id, language, title and description in the
   pack's own language, question count — to `QUIZ_PACK_CATALOG` in
   `src/packs/catalog.ts` (and a new id to `QUIZ_PACK_ORDER`). Never import a
   data file from anywhere else.
4. **Every language must ship the same pack ids** — add the pack in each
   language, or none.
5. Check every fact against a reliable source, keep questions ≤ 120
   characters and answers ≤ 40, end questions with "?".
6. `pnpm --filter @lobbyforge/quiz test` — `packs.test.ts` enforces the shape
   rules above (four different answers, a valid right answer, no duplicate
   questions or ids, the A–D spread, the same ids per language, the catalogue
   matching the data) and `client-bundle.test.ts` fails if a question becomes
   reachable from the client entries.

**Adding a language** means a set of packs in it (all pack ids) plus
`plugins/quiz/locales/<code>.json` for the interface (`pnpm i18n:add` scaffolds
the latter; see [TRANSLATING.md](TRANSLATING.md)).

## Fair play (hidden information)

The canonical state has two secrets; everything else is public:

| Field | Holds | Who sees it |
|---|---|---|
| `deck` | every question of the game **with** its right answer | nobody — not even the host (who may be playing a pack). Viewers get the open question as `current` (no answer) and `questionTotal`. |
| `answers` | who picked what on the open question | nobody, in any phase. Each viewer gets `answeredCount` and their own `myAnswer`; the reveal publishes per-option `counts`. |

The projection (`projectActivityState`, used by the REST routes, SSE and the
ws-gateway alike) also strips a stray `correctIndex` from `current` and
blanks `reveal` while a question is open. The leaderboard's per-round gains
are public by design, so it is visible who got the last question right —
but never which wrong answer anyone picked.

Other guarantees: one locked answer per player per question (no retries);
`playerId` is injected by the host from the session; answers after the
deadline are refused; the score moves only at a reveal.

**Pack answers never ship to browsers.** The plugin's main entry (which the
host's client-safe registry imports) and the panel reach only the pack
catalogue; the questions sit behind `@lobbyforge/quiz/packs`, which only the
server-side prepare step imports. `client-bundle.test.ts` walks the import
graph of both client entries (every `import`, `export … from` and
`import()`) and fails if a data file, the server entry or any question's
text is reachable.

## Actions

| Action | Policy | Payload | Phase |
|---|---|---|---|
| `start` | host | `source: 'pack'` + `packId`, `language` (the host injects the pack's `questions` server-side) — or `source: 'custom'` + `questions`; optional `questionCount`, `secondsPerQuestion`, `shuffle` | lobby |
| `set-questions` | host | `questions` (legacy: starts a custom quiz, all questions, in order) | lobby |
| `join` | member, `playerId` injected | — | any but ended |
| `leave` | member, `playerId` injected | — | any but ended |
| `answer` | member, `playerId` injected | `index` | playing |
| `time-up` | member | — | playing, after the deadline |
| `reveal` | host | — | playing |
| `next` | host | — | reveal |
| `end` | host | — | playing, reveal |

Every action is checked by `quizValidateAction` before dispatch (and again
by the reducer); anything invalid or out of phase leaves the state untouched.

## State

`QuizState` v2 (`plugins/quiz/src/state.ts`): `phase`, `settings`, `players`
(join order: score, right answers, answered, streak, best streak, last gain
and result, `eligibleFrom`, `active`), the secret `deck` and `answers`,
`questionTotal`, `questionsRevealed`, `currentIndex`, `current`,
`questionStartedAt`, `deadline`, `reveal`, `startedAt`, `endedAt`,
`endReason`.

`migrateQuizState` upgrades sessions written by older builds (no `version`:
a pasted `questions` list, `currentAnswers`, `playerScores`): the questions
become the deck, players keep their correct answers (500 points each), a
game in progress continues without a timer (the host reveals), and a
revealed question keeps its counts. It is idempotent and returns a current
state as the same object.

## Accessibility

- Answer tiles are real buttons: Tab reaches them, Enter or Space answers.
  Each has a letter **and** a distinct colour (the colour is never the only
  cue); the accessible name is "B: Jupiter".
- While the question has focus, `1`–`4` or `A`–`D` answer (up to 6 for
  custom questions). The handler sits on the question region, never on the
  window, and ignores keys typed in inputs and chords with Ctrl/Alt/Meta.
- After answering, the tiles stay focusable (`aria-disabled`), so focus is
  not lost. A new question and a reveal move focus to the question / the
  answer heading when focus was in the panel. Status lines ("Answer B is
  locked in…", "Time's up!", your result) are live regions.
- Everything is built from the activity UI kit and follows the dark, dim and
  light themes; answer swatches carry dark text at 7:1 or better.

## Files

```
plugins/quiz/
  locales/en.json, tr.json      interface strings (+ catalog.summary)
  src/index.ts                  the GamePlugin: manifest, policies, glue
  src/state.ts                  types, constants, initial state, migration
  src/actions.ts                validation, reducer, scoring
  src/deck.ts                   building a game's deck (shuffles)
  src/roster.ts                 eligibility, ranking, podium
  src/custom.ts                 the paste format
  src/packs/catalog.ts          pack catalogue (client-safe: titles, counts)
  src/packs/server.ts           SERVER ONLY: packs with questions, hydration
                                  (published as @lobbyforge/quiz/packs)
  src/packs/data/               the questions (server only)
  src/view.ts                   the panel's defensive read of the state
  src/renderClient.tsx          the panel
  src/ui/                       lobby/setup, question, reveal, final views
```
