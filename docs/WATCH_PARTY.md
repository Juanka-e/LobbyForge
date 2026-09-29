# Watch Party

Everyone in a voice channel watches the same YouTube video at the same
moment, each in their own player, while they talk. This is the **sync
playback** mode of the spec (`projectdetails/14_BOTS_MUSIC_WATCH_PARTY.md`
§6), delivering the §7 MVP — start it in a room, a host, ready state,
play/pause events, a basic sync clock — and the §8 copyright policy.

Code: `plugins/watch-party/` (`@lobbyforge/watch-party`). Registered in
`apps/web/lib/plugin-registry.ts`.

| Spec §7 item | Where it lives |
|---|---|
| Start a room activity | Activities hub → Watch Party (any voice or stage channel) |
| Pick a host | The creator hosts; hand-off, automatic hand-over, take-over (below) |
| Suggest screen share | The link field's hint: "Not on YouTube? Share your screen…" |
| Chat panel | The lobby's own chat, beside the party — not duplicated |
| Play/pause events | `play` / `pause` / `seek` actions on one server-stamped timeline |
| Participant ready state | Each viewer's player reports ready / buffering / not synced |
| Basic sync clock | Server time + a measured client clock offset (see "Sync") |

## Starting a party

1. A server admin installs the app: **Admin → Apps** (or
   `POST /api/servers/{id}/apps {"pluginId":"watch-party","enabled":true}`).
   It is listed with every other compiled-in plugin; nothing is installed
   by default.
2. Anyone with the Start activity permission opens **Activities** in a voice
   channel and picks **Watch Party**. One activity runs per channel.
3. Whoever started it hosts it. Paste a YouTube link — it loads for everyone,
   paused — and press play when people are ready.

## The screen

Following the Watch Party artboard, inside the kit's `ActivityShell`:

- **Header** — who hosts, whether everyone may control, a sync pill (Nothing
  playing / Paused / Playing / All in sync / *n* buffering) and how many are
  watching.
- **Player** — a 16:9 YouTube player. Before a video is chosen, an empty
  state with the link form instead.
- **Controls** — timeline with times; for whoever may control: back 10 s,
  play/pause, forward 10 s, a seek bar and **Sync everyone to me**. Everyone
  else sees the timeline, a sentence saying who controls it, and **Resync my
  player** (local only). The host also chooses **Who controls playback: Only
  me / Everyone**.
- **Your own state** — one line: in sync, catching up, paused on your screen
  ("Catch up"), loading, or "Press play on the video" when the browser
  blocked it.
- **Up next** — the queue and the link form. The host plays any item now,
  reorders, removes and skips; anyone removes what they added.
- **Watching** — everyone with the party open and their state (In sync /
  Ready / Buffering / Not synced / Away — words, colour only as a second
  cue). The host hands the party to someone here; anyone takes over a host
  who has gone quiet; the session's creator can take the controls back.
- **Small print** — the copyright note (below).

The sidebar sits beside the player when the centre column is wide and drops
under it when narrow (a flex "sidebar" layout — no fixed widths).

## Rules

Where the spec is silent these are the conventional choices, now the rules:

| Topic | Rule |
|---|---|
| Links | Only YouTube **video** links: `youtube.com/watch?v=` (also `m.`, `music.`), `youtu.be/`, `/shorts/`, `/embed/` (also `youtube-nocookie.com/embed/`). A scheme-less paste works. `t=`/`start=` (`90`, `1m30s`, `1h2m3s`) sets the start. Everything else — playlists, channels, `/live/`, lookalike hosts, redirect wrappers, credentials or ports in the URL — is refused. Only the 11-character id is stored. |
| First video | If nothing is on screen, the first link anyone adds goes straight up, **paused**. |
| Queue | At most **25** videos; the same video is not queued twice; a viewer may have **3** waiting at a time — the host is exempt (they run the queue). |
| Queue rights | The host plays now, reorders, removes and skips; anyone may remove what they added. |
| Changing video | The room keeps its play/pause state: skipping while watching carries on playing; a fresh party waits for the host's play. |
| End of a video | The **host's** player reports it (once); the next queued video starts playing, or the room pauses at the end. Viewers never report it (in "everyone" mode it would be a back-door skip). |
| Control | Only the host plays, pauses and seeks — unless the host picks "Everyone", which lets everyone **watching** do so. Changing the video and the queue stays the host's. |
| Host leaves | The longest-present viewer who is still around (not "away") becomes host; nobody left → no host, and the next person to join gets it. |
| Hand-off | The host makes anyone watching the host. |
| Host gone quiet | A host with no sign of life for **150 s** (since their last report, or since they got the role) counts as away: anyone watching may take over. |
| Take back | The session's creator and moderators (Start activity permission) can always take the controls (`take-host`, the route's `host` policy). |
| Watching list | Joined on opening the party, left on closing it; at most 50 listed (more can watch, unlisted). A viewer silent for **12 min** is shown as away and ignored by the sync pill. |

## Actions

Every action names its actor in `actorId`, which the host overwrites with
the authenticated caller (`actorFields`); the reducer takes the caller from
the host context. The route's `host` policy means "session creator", but a
party's host changes hands, so the reducer checks `state.hostId` itself and
every policy is `member` — except `take-host`, deliberately `host`.

| Action | Payload | Who (reducer) | No-op when |
|---|---|---|---|
| `join` | — | anyone | already listed (a heartbeat after 30 s), list full |
| `leave` | — | anyone listed | not listed |
| `report-status` | `status: ready\|buffering\|idle` | anyone (lists them if needed) | same status within 30 s, list full |
| `set-video` | `url` | host | bad link |
| `queue-add` | `url` | anyone | bad link, queue full, duplicate, over the per-viewer limit |
| `queue-remove` | `itemId` | host, or who added it | not queued |
| `queue-move` | `itemId`, `toIndex` | host | not queued, same place |
| `queue-play` | `itemId` | host | not queued |
| `skip` | — | host | queue empty |
| `video-ended` | `itemId`, `positionSec?` | host | not the current item, room paused |
| `play` | `positionSec?` | controller | no video; already playing without a position |
| `pause` | `positionSec?` | controller | no video; already paused without a position |
| `seek` | `positionSec` | controller | no video; paused at that position |
| `set-control-mode` | `mode: host\|everyone` | host | unchanged |
| `transfer-host` | `toUserId` | host | target not watching, or themselves |
| `claim-host` | — | anyone watching | host present |
| `take-host` | — | creator / moderator (route) | already host |

`validateAction` rejects malformed payloads with 400 before dispatch (unknown
type, missing actor, a bad link, positions outside 0–12 h, bad ids/modes).
The reducer re-validates and returns the **same state object** for every
no-op, so nothing is re-stamped.

## State

```jsonc
{
  "version": 1,
  "hostId": "user-uuid", "hostSince": 1759090000000,
  "controlMode": "host",
  "current": { "id": "v3", "videoId": "M7lc1UVf-VE", "startSec": 0, "addedBy": "user-uuid", "addedAt": 1759090000000 },
  "playback": { "status": "playing", "positionSec": 42.5, "updatedAt": 1759090012000 },
  "queue": [ { "id": "v4", "videoId": "aqz-KE-bpKQ", "startSec": 0, "addedBy": "other-uuid", "addedAt": 1759090005000 } ],
  "viewers": [ { "userId": "user-uuid", "status": "ready", "joinedAt": 1759090000000, "lastSeenAt": 1759090011000 } ],
  "nextItemSeq": 5,
  "stampedAt": 1759090012000
}
```

Every timestamp is **server** epoch milliseconds, written by the reducer —
`handleAction` passes `Date.now()`, and reducers run on the server inside
the actions route (the same way Poll and Hushle stamp their times). No
action carries a timestamp. `migrateState` is `normalizeWatchPartyState`:
idempotent, clock-free (a garbage row becomes a fresh party), and it keeps
what it can of the old M16 stub shape. The panel runs it too, because the
realtime gateway forwards stored state without migrating it.

## Sync

**The timeline.** The server keeps one record, `{ status, positionSec,
updatedAt }`. Where the video should be for everyone is

```
expected = positionSec + (serverNow − updatedAt) / 1000   while playing
expected = positionSec                                      while paused
```

capped at the video's length once the player knows it (`sync.ts`,
`expectedPositionSec`).

**Server time on a client.** `serverNow = Date.now() + offset`, and the
offset is measured, not assumed. Every change carries `stampedAt`, the
server's clock when it was made. When a change *arrives*, the server's clock
is at least `stampedAt` (delivery takes time, never negative time), so
`stampedAt − localArrival` is a lower bound of the offset; the largest bound
among the last 12 (≤ 10 min old) is the estimate — off by the quickest
delivery, a few milliseconds over WebSocket. The state a panel mounts with
is not a sample (it may be minutes old); until the first live change
(usually the viewer's own join or readiness report) the offset is 0. A
clock minutes off — common on machines without NTP, or a WSL2 VM after sleep
— is corrected by the first change that arrives.

**Correction** (`planCorrection`, `SyncController`). Twice a second each
viewer compares their player with `expected`:

- playing room: a playing/buffering player more than **1.5 s** off is
  seeked; a paused, cued or unstarted one is started (seeked first if it is
  elsewhere); one that ended early is restarted; at the real end it waits.
- paused room: a playing player is paused (and seeked back if it wandered);
  a paused one more than 1.5 s off is seeked (a paused YouTube player stays
  paused when seeked); a cued/unstarted one is left alone — YouTube *starts*
  such a player when seeked.

Around that: seeks are at least 3 s apart and play/pause retries 3 s / 2 s
apart (a slow connection is not seeked over and over); after this viewer's
own control their player follows at once and corrections wait (≤ 2.5 s)
for the new record, so the old one does not drag it back; a player still
showing the previous video is ignored; an errored player is left alone.

**The viewer's own choices.**

- *Joining playback.* Browsers refuse to start a video with sound until the
  person has interacted with the page. The panel starts "engaged" when
  `navigator.userActivation.hasBeenActive` (in the lobby you have always
  clicked something); otherwise it shows **Click to join playback** over
  the player and commands nothing until then.
- *Blocked autoplay.* If a play command has not got the player going within
  4 s, the browser refused it: the panel stops retrying and asks the viewer
  to press play on the video itself (a click inside the player always
  works); from there they are synced.
- *Paused on purpose.* A viewer who pauses their own player while the room
  plays is not dragged back ("You paused your player — Catch up"). A pause
  within 1.5 s of our own pause command is ours, not theirs.

**Sync everyone to me** seeks the room to the controller's own player.
Back/forward 10 s are gathered for 0.6 s into one seek. The pause button
sends the controller's position only when it agrees with the room within
3 s (otherwise the server pauses where the timeline is); play never sends
one — it resumes the room's timeline, so a player that never started
cannot rewind everyone to 0:00.

## Readiness, presence and the rate limit

Each viewer derives a status from their player (`desiredViewerStatus`):
**ready** (loaded and following), **buffering** (loading, seeking, starting)
or **idle** (not joined, blocked, paused on purpose, error). It is sent only
when it **changes**, after it has held for **2.5 s** (a buffering blip is not
news), and never more often than every **8 s** — plus a heartbeat (the same
status again): every **60 s** from the host, whose absence blocks the room,
every **5 min** from everyone else. A viewer flapping faster than the
debounce sends nothing (tested). Drift corrections never send anything.

Why so frugal: the actions route allows **30 actions a minute per client
IP**, audits every action and broadcasts every write — even a no-op the
reducer ignores. Without `LOBBYFORGE_TRUSTED_PROXY` all clients share **one**
bucket (`activity-action:unknown`), which is the case on the dev and e2e
stacks. A typical party costs a join per viewer, a report or two per viewer
per video change, the host's controls, and heartbeats (1/min for the host).

## The player

- **Embed**: `https://www.youtube-nocookie.com/embed/<id>?enablejsapi=1&origin=<location.origin>&playsinline=1&rel=0`
  — the privacy-enhanced domain, the JS API on, the page origin so the
  player knows where to answer. No autoplay parameter: the room decides.
  One iframe per video (`key` = item id).
- **No `iframe_api` script.** The app's CSP allows no third-party script,
  and that stays so. The panel speaks the same postMessage protocol YouTube's
  own `www-widgetapi.js` uses (checked against its source):
  - out: `{"event":"listening","id":n,"channel":"widget"}` every 250 ms until
    the player answers (≤ 30 s; the panel then says the player is stalled
    after 15 s), then `{"event":"command","func":"addEventListener","args":["onStateChange"]}`
    (and `onError`), and `playVideo` / `pauseVideo` / `seekTo [seconds, true]`
    — always posted to `https://www.youtube-nocookie.com` only;
  - in: `initialDelivery` / `infoDelivery` (player state, `currentTime`
    with its `currentTimeLastUpdated_`, duration, rate, video id and title),
    `onStateChange`, `onError`, `onReady`, `readyToListen`.
- **Every incoming message** must come from `https://www.youtube-nocookie.com`
  **and** from this panel's own iframe (`event.source`) before it is parsed;
  the parser keeps only well-typed fields (`player-protocol.ts`).
- **iframe attributes**: `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms"`
  — the set YouTube's own API applies, minus `allow-top-navigation`, so the
  player can never navigate the lobby away (`allow-same-origin` is safe
  here: the frame is cross-origin, it keeps *its* origin, not ours);
  `allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write; web-share"`
  (autoplay is what lets a click in the lobby start sound; no camera,
  microphone or sensors); `referrerpolicy="strict-origin-when-cross-origin"`
  (YouTube refuses embeds that send no referrer); a translated `title`.
- **Errors**: 101/150 "the owner only allows it on YouTube", 100 "private or
  removed", 2 "couldn't play this link", others "couldn't be played" — each
  with **Open on YouTube**.

## CSP change

`apps/web/middleware.ts`, one directive:

```diff
-    "frame-src 'none'",
+    "frame-src https://www.youtube-nocookie.com",
```

Why it is safe:

- **One exact origin.** No wildcard, no `https:`, not `youtube.com`, no
  `*.youtube…`. `apps/web/lib/__tests__/security-config.test.ts` pins it
  (and ties it to the plugin's `YOUTUBE_EMBED_ORIGIN`, so the two cannot
  drift) and checks the header a real response carries.
- **Framing only.** `frame-src` lets a page *embed* that origin in an iframe.
  It adds nothing to `script-src`, `style-src`, `connect-src` or `img-src`:
  no code from YouTube runs in the app's origin. The player runs in its own
  origin, isolated by the browser's same-origin policy, and the two sides
  only exchange postMessage strings that each checks (above).
- **Everything else unchanged**: `frame-ancestors 'none'` and
  `X-Frame-Options: DENY` (nobody may frame *us*), `object-src 'none'`,
  nonce-based `script-src`, `base-uri`/`form-action 'self'`.
- **Contained frame**: sandboxed without top navigation; the only feature
  delegations are the media ones above.
- **Only built from a validated id**: the iframe `src` is always
  `YOUTUBE_EMBED_ORIGIN + /embed/ + <11-char id>`; a user never supplies a
  URL that is framed.
- **Not widened for thumbnails.** Queue entries show `youtu.be/<id>` and an
  "open on YouTube" link instead of thumbnails, so `img-src` stays
  `'self' data: blob:` — and nobody's browser contacts Google just by
  looking at the queue.

The desktop app loads the instance as a top-level page, so the instance's
CSP (not the shell's `tauri.conf.json`) is the one that applies there.

## Privacy

The player is YouTube's privacy-enhanced mode (`youtube-nocookie.com`: no
tracking cookies until the viewer interacts with the player itself).
Loading it still sends the viewer's IP address and the embedding origin to
Google — that is what watching a YouTube video means, and each viewer's
player is theirs. Nothing about the party (who is watching, the queue) is
sent to YouTube. No YouTube account is needed or linked
(`externalAccountRequired: false`).

## Copyright

LobbyForge is not a distribution platform for copyrighted content (spec
§8). Watch Party shows, under the player:

> You're responsible for what you play. Videos stream from YouTube straight
> to each viewer's own player — LobbyForge doesn't download, store or
> re-stream them.

Each viewer's browser plays the video from YouTube under YouTube's terms;
the instance only relays a video id and a position. Videos whose owners
disable embedding simply do not play. Abuse on public servers is handled
like any other content (spec §8: action can be taken on directory abuse).

## Projection

None. Nothing in the state is secret — the queue, the timeline, who is
watching and how their player is doing are exactly what every viewer sees
on screen — so `packages/core/src/activity-projection.ts` has no Watch Party
rule and the state passes through unchanged (the projector's default).

## Names

Names come from the panel's `players` prop. The actions route adds everyone
who acts in an activity to its roster, and panels re-read the roster when it
grows — so each viewer's `join` puts their display name in front of
everyone. Someone listed without a roster entry (e.g. a row an older build
wrote) shows as "Viewer 1a2b", a stable prefix of their id. Your own row
reads "*name* (you)".

## Tests

`pnpm --filter @lobbyforge/watch-party test` — 274 tests:

| File | Covers |
|---|---|
| `youtube.test.ts` | every accepted link form, start times, ~25 rejected forms, embed/watch URLs |
| `reducer.test.ts` | `validateAction` for every action and malformation; every action's effect and every refusal; host hand-over, claim, take-back; queue limits |
| `state.test.ts` | initial state, normalisation (garbage, duplicates, bounds, counter repair, stub upgrade), idempotency |
| `sync.test.ts` | the timeline formula, clock-offset estimation, `planCorrection` for every player state, readiness, report throttling (incl. a flapping player costing nothing), the sync pill |
| `player-protocol.test.ts` | messages out, untrusted messages in, snapshot folding, time extrapolation, error kinds |
| `controller.test.ts` | the controller on a fake clock: start, cooldowns, blocked autoplay, drift, server-clock offset, pause/hold, joining playback, quiet after own controls, end of video, stale players, errors |
| `plugin.test.ts` | manifest, action policies, a session through the SDK harness (server clock, actor from context), migration |
| `locales.test.ts` | every key the panel renders exists in every language, arguments match, counts are plurals |
| `render-client.test.tsx` | `renderClient` returns an element (the #310 regression) |

End to end: `apps/web/e2e/activity-watch-party.spec.ts` (two browsers,
through the lobby; see its header).

## Not yet

- Other sources the spec lists (HLS streams, self-hosted media) — the player
  layer is YouTube-only; the timeline/sync model is source-agnostic.
- Titles and thumbnails for queued videos (needs a server-side oEmbed call
  or an `img-src` exception — deliberately not done, see above).
- Voice-channel presence for the watching list (the host's voice context is
  a stub for plugins today).
- Ads: YouTube may show an ad to some viewers on some videos; YouTube ignores
  seeks during it, and that viewer catches up when it ends.
- Firefox and Safari may refuse a play that did not come from a click inside
  the player itself; the viewer is then asked to press play on the video
  once ("blocked autoplay" above), and is synced from there.
