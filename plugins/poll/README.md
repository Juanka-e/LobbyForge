# plugins/poll

Official anonymous live poll for a channel: the host asks a question with
2–6 options, any member votes once, and the tally shows to each viewer
once they have voted (to everyone when the poll closes).

## Actions

| Action | Policy | Payload | Effect |
|---|---|---|---|
| `open-poll` | host, `hostId` injected | `question` (1–200 characters), `options` (2–6, each ≤ 80) | A new poll: options `opt-1`…, an empty ballot box, `pollId` + 1. Replaces any poll on. |
| `vote` | member, `playerId` injected | `optionId`; optional `pollId` | One vote per player per poll, while the poll is open. Ignored when `pollId` names another poll (see below). |
| `close-poll` | host, `hostId` injected | — | Stops voting; the tally stays. |
| `reopen-poll` | host, `hostId` injected | — | Voting again on the same poll: same `pollId`, same ballot box, so nobody votes twice across the gap. |
| `clear-poll` | host, `hostId` injected | — | Back to idle, keeping `pollId` so the next poll gets a new one. |

`pollValidateAction` checks every payload before dispatch (a string is a
400) and the reducer re-checks it; anything else leaves the state untouched.

**A vote names its poll.** Option ids repeat from poll to poll, so a vote
sent for one poll could land on the next one the host opened after
clearing it. Every `open-poll` numbers the poll (`pollId`, never reused in
the session); the panel sends the `pollId` of the state it rendered, and
the reducer ignores a vote whose `pollId` is not the poll on now — it
returns the same state, so the vote changes nothing (the voter's panel,
answered with the current state, shows the new poll). A vote without
a `pollId` (a panel loaded before it, still open after a deploy) counts for
the open poll, as before; `null` counts as absent, and anything else that
is not a non-negative integer is a 400. `pollId` is public: it counts
polls and says nothing about who voted.

## State

`question`, `options` (`id`, `text`, `votes`), `phase` (`idle`, `open`,
`closed`), `hostId`, `pollId`, `createdAt`, `closedAt`, and the server-only
`ballotBox` (who has voted, never for what). The core projection
(`packages/core/src/activity-projection.ts`) replaces `ballotBox` with
`ballotCount` and the viewer's own `hasVoted` for every viewer.

`migratePollState` is the plugin's `migrateState`: a session written before
poll numbers gets `pollId: 0` (the same on every read), and a current state
comes back as the same object.

## Files

| File | What |
|---|---|
| `src/index.ts` | The plugin: manifest, policies, validation, reducer, migration. |
| `src/view.ts` | The panel's pure rules: when results show, shares, draft checks, the `vote` a choice sends. |
| `src/renderClient.tsx` | The panel. |
| `src/tally.ts` | Counts and the leader, shared by the reducer and the panel. |
| `locales/<code>.json` | The panel's text (`poll.*`) and `catalog.summary`. |
