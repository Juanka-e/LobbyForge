# Polls in text channels

A member with the right permission can post a poll in a text or
announcement channel, the way Discord does: a question, 2–10 answers, and a
closing time. It is a message kind, not an activity. The voice-room Poll
activity (`plugins/poll`) is separate and unchanged.

## 1. Behaviour

- **Create:** the `+` button in the composer opens a menu with **Create
  poll** (only for members who may post polls in that channel). The dialog
  asks for:
  - a question, 1–300 characters;
  - 2–10 answers, 1–80 characters each, no two the same after trimming and
    ignoring case (`Pizza` and ` PIZZA ` are the same answer);
  - **Allow multiple answers** (off by default);
  - a duration: 1 h, 4 h, 8 h, 24 h (default), 3 days or 7 days.
- **Vote:** anyone who can read the channel. Single choice, or any number
  of answers (up to all of them) when multiple answers are allowed. A member
  can change or remove their vote until the poll closes.
- **Results:** counts show to a member once they have voted, and to
  everyone once the poll has closed. Before voting, a member sees the
  answers without counts, and the number of people who voted.
- **Close:** automatic at the closing time, or early by the poll's creator
  or anyone with **Manage Messages** (owner and administrators included).
  A closed poll stays in the channel, read-only, with the final results and
  a **Closed** badge.
- **Edit and delete:** the question cannot be edited (people have voted on
  it). Deleting the message deletes the poll and every ballot.
- **Live:** votes and closes reach every open lobby without a reload. The
  card announces a new voter total politely to screen readers; the
  countdown is not announced.

## 2. Permission

`create_polls` ("Create polls" / "Anket oluştur"), in the role editors next
to the text permissions.

- New servers: the `Owner` role carries it. `@everyone` does not.
- Existing servers: migration 0047 adds it to every role that already has
  `administrator` or `manage_messages` (owner and moderator-style roles),
  never to `@everyone`. Owners can grant it to any role.
- The owner and administrators always pass (`administrator` implies every
  permission).
- Posting also needs **Send Messages** in that channel, and the channel must
  be `text` or `announcement`.

The same gates as a message apply to posting a poll: email verification
(`message`), channel visibility, member timeouts, `@everyone` needing
**Mention Everyone**, the Moderation Bot (it judges the question and every
answer together, exactly like a new message), and the message rate limit
(polls share the `messages-create` budget). Voting is gated like a reaction:
a timed-out member, or an unverified account in `required` mode
(`reaction`), cannot vote.

## 3. API

All routes are under `/api/servers/{id}/channels/{channelId}` and use the
session cookie.

| Method | Path | Body | Answer |
|---|---|---|---|
| `POST` | `/polls` | `{ question, options: string[], allowMultiple?, durationHours? }` | `201 { message, poll }` |
| `GET` | `/polls/{pollId}` | — | `{ poll }` |
| `PUT` | `/polls/{pollId}/vote` | `{ choices: number[] }` (option indexes) | `{ poll }` |
| `DELETE` | `/polls/{pollId}/vote` | — | `{ poll }` |
| `POST` | `/polls/{pollId}/close` | — | `{ poll }` |

`durationHours` is one of `1, 4, 8, 24, 72, 168` (default 24).
`allowMultiple` defaults to `false`.

Refusals:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_poll`, `poll_duplicate_option` | the body breaks a rule above |
| 400 | `poll_channel_type` | not a text or announcement channel |
| 400 | `invalid_vote`, `vote_single_choice`, `vote_duplicate`, `vote_out_of_range` | a bad `choices` list |
| 403 | — / `email_unverified` | no permission, timed out, not verified |
| 403 | `poll_close_forbidden` | closing someone else's poll without Manage Messages |
| 404 | `poll_not_found` | unknown poll, deleted message, or a poll in another channel |
| 409 | `poll_closed` | voting, removing a vote or closing after the poll closed |
| 422 | `blocked_by_moderation` | the Moderation Bot refused it (same body as a message) |

The `poll` object is the only shape a poll leaves the server in:

```ts
{
  id, messageId, question,
  options: Array<{ text: string; votes: number | null }>, // null until results are visible to you
  allowMultiple, closesAt, closedAt, closed,
  totalVoters,      // always shown
  myChoices: number[], // yours only
  resultsVisible,
  version,          // bumped by every vote, removal and close
}
```

**Message routes.** A poll is stored as a message whose `content` is the
question, so search, notifications and bots see plain text. Its
`metadata.poll = { id }` is written only by the poll route: `poll` is a
reserved metadata key and the messages API refuses it from clients.
`GET …/messages` adds `poll` (projected for the caller) to each poll
message, with one batched query per page; `GET …/messages/{messageId}`
does the same. `PATCH` with `content` on a poll message answers
403 `poll_message_readonly` (pinning still works).

**Realtime.** On the chat topic `chat:{serverId}:{channelId}`:
- a new poll is a normal `message` event whose `message.poll` is the poll
  as everyone sees it at creation (no votes yet);
- after a vote, a vote removal or a close:
  `{ type: 'poll_update', poll: { id, messageId, counts, totalVoters, closesAt, closedAt, closed, version } }`.
  It carries ids and counts, never a voter. The lobby shows the counts to
  members who have voted (and to everyone once closed); a member who has
  not voted only sees the voter total move.
- Each write reads its tally after it commits, so updates can arrive out
  of order. The lobby drops an update older than the `version` it shows, a
  closed poll never reopens, and a REST answer older than the newest update
  seen is brought up to it (keeping the answer's own choices).

The lobby also handles `message_update` (refetches that one message) and
`message_delete` (drops it), so edits and deletes appear without a reload.
The realtime client re-sends its subscriptions when the gateway says
`hello`: the gateway drops a subscribe that arrives before it has
authenticated the socket, which used to leave a lobby without live
updates until a reload when sign-in checks were slow.

**Bots** see a poll as a plain `message_create` whose `content` is the
question. There is no poll data or poll API for bots in this version, and
they never receive `poll_update`.

**Audit log:** `poll.create` and `poll.close`. Votes are never audited.

## 4. Data model (migration 0047)

- `message_polls`: `id`, `message_id` (unique, FK → `messages` ON DELETE
  CASCADE), `channel_id` (FK → `channels` ON DELETE CASCADE),
  `creator_user_id` (SET NULL), `question`, `options` (JSON array of 2–10
  strings), `allow_multiple`, `closes_at`, `closed_at` (early close),
  `closed_by_user_id`, `version` (bumped by every vote, removal and
  close), `created_at`.
- `message_poll_votes`: primary key `(poll_id, user_id, option_index)`,
  FK → `message_polls` and `users`, both ON DELETE CASCADE. A single-choice
  vote is one row; a multiple-choice vote is one row per chosen answer.

The message and its poll are written in one transaction. Closing is lazy:
a poll is closed once `closes_at` has passed or `closed_at` is set; nothing
runs at expiry. Every write to a poll (vote, removal, close) locks the poll
row and bumps `version` in the same transaction, so writes run one after
another: two devices voting at once cannot leave a single-choice poll with
two rows, a vote cannot slip in after a close, and versions are ordered.

Messages are soft-deleted (`deleted_at`), which the FK cascade never sees,
so the delete route soft-deletes a poll message and deletes its poll (and
with it the ballots) in one transaction; if that fails, nothing is
deleted. A hard delete (a channel removed) cascades.

## 5. Anonymity

Results are anonymous to everyone, the poll's creator, moderators and the
server owner included:

- every API answer and every realtime event carries counts, the number of
  voters, and the caller's own choices, never another member's choice;
- votes are not written to the audit log.

**The limit:** the database does store who chose what
(`message_poll_votes.user_id`). It has to, so a vote can be changed or
removed and "your vote" shows on every device. Anyone with direct access to
the database (the operator of the instance, a backup) can read it. The
promise is that LobbyForge never exposes it, not that it does not exist.

Pre-vote hiding is a rule of the interface, not a secret: the `poll_update`
event carries counts to everyone who can read the channel, and the card
simply does not show them until you vote. The REST answers do hide them.
