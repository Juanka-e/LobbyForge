# Manual Release Test Checklist

This checklist targets the self-host Docker stack. Preserve the named
PostgreSQL volume throughout testing. Do not run `docker compose down -v`, the
test reset endpoints, `db push`, or destructive seed scripts against the
development database.

## Start the stack

```sh
docker compose -f infra/docker/docker-compose.dev.yml up -d --build --wait
```

| What | URL / port |
|---|---|
| App | http://localhost:19520 |
| Realtime gateway | ws://localhost:19521 (`/health` over HTTP) |
| LiveKit | http://localhost:19580, media `19582/udp` |
| Postgres | localhost:19532 |
| Redis | localhost:19579 |
| Mailpit (`--profile full`) | http://localhost:19526 |
| MinIO console (`--profile full`) | http://localhost:19591 |

Ports live in a quiet range on purpose: 3000/3001/5432/6379 collide with
almost everything else a developer runs. Container-internal ports are
unchanged, and production still terminates on 80/443.

A second, isolated stack (own volumes, container names and ports 19620/
19621/19690) runs side by side for automated E2E — see
`infra/docker/docker-compose.e2e-ports.yml`.

## 15-minute end-to-end pass

Two browser profiles (or one normal + one private window) = two users.

1. **First run.** Open the app, complete the setup wizard (owner account).
2. **Invite.** As owner create an invite link; open it in the second
   profile and join as a guest.
3. **Chat.** Send messages both ways in `#general`. They must appear
   without a reload (realtime), and survive a refresh (persisted).
4. **Voice.** Both users join the voice channel. Check: you hear each
   other, the speaking ring reacts, mute silences you for the other side,
   deafen silences everyone for you, and the roster icons match.
5. **Moderation.** As owner, use the mute control next to the guest in the
   voice roster: the guest's footer says "Muted by a moderator", they
   cannot unmute themselves, and rejoining does not lift it. Lift it and
   confirm the guest has to unmute themselves.
6. **Push-to-talk.** In Voice & Video settings switch the guest to
   push-to-talk, rejoin, hold Space and confirm the owner hears audio only
   while the key is held.
7. **Activity.** As owner start Hushle (or Poll) in the voice channel from
   Activities and play a round with the guest.
8. **Ban.** Ban the guest: they must lose the server, be dropped from
   voice, and an invite link must not let them back in. Unban to restore.
9. **Restart.** `docker compose -f infra/docker/docker-compose.dev.yml
   restart web ws-gateway` — sign in again and confirm nothing was lost.

## P0 - Data persistence and bootstrap

- [ ] Create a local account, sign in, and record its email/display name.
- [ ] Restart only `web` and `ws-gateway`; confirm the account can still sign in.
- [ ] Rebuild the app image and recreate only app containers; confirm the same
  account, server, channels, roles, and messages remain.
- [ ] Visit `/setup` after setup completion; it must redirect and must never
  offer another owner creation flow.
- [ ] Confirm the `migrate` container exits with code 0 and does not create
  duplicate channels, users, roles, or servers.

## P0 - Authentication and access policy

- [ ] Open registration: create a new local account and reach the community.
- [ ] Invite only: direct registration must fail; a valid unused invite must
  create exactly one account and increment invite use exactly once.
- [ ] Closed registration: new registration must fail while existing users can
  still sign in.
- [ ] Explicit server policy `existing_local_users_only` must block new local
  accounts even when instance registration is open.
- [ ] Approval-required policies must fail closed until the approval queue is
  implemented.
- [ ] Wrong passwords and unknown emails must return the same generic error.
- [ ] Change password, verify the old password stops working, then sign out and
  verify authenticated pages require a new login.
- [ ] Revoke another active session and verify that browser receives 401 while
  the current session remains usable.

## P0 - Authorization and security boundaries

- [ ] A normal member cannot open admin/community settings or mutate roles,
  channels, bans, access policy, maintenance, or updates.
- [ ] Change server/channel/message UUIDs in requests; cross-server and
  non-member access must return 403 or 404 without leaking private data.
- [ ] Test-reset endpoints must return 404 in the production container.
- [ ] Send an invalid cross-origin mutation request; Origin protection must
  reject it.
- [ ] Put HTML/script and SQL-looking text into allowed profile/message fields;
  values must render as text and database behavior must remain unchanged.
- [ ] Repeated login, registration, invite, and message requests must trigger
  rate limiting without affecting other authenticated users.

## P0 - Voice, video, and presence

- [ ] Join the same voice channel from two separate browser profiles; both
  users must appear before either user joins locally.
- [ ] Verify two-way microphone audio, mute, deafen, device selection, and mic
  test playback.
- [ ] Enable camera and screen share; voice view must become full-screen and
  show a stream preview before joining. After joining, camera + screen from the
  same publisher must be side by side on desktop and stacked on narrow screens.
- [ ] Confirm camera/screen icons appear beside the publisher in the voice
  channel roster and participant sorting persists for Default, Camera first,
  and Name modes.
- [ ] Stop camera and screen share independently, including the browser-native
  `Stop sharing` action; the matching roster and participant icons must clear
  immediately while voice remains connected.
- [ ] In full-screen voice view, verify the bottom call dock remains usable on
  desktop and mobile and Voice & Video settings opens without disconnecting.
- [ ] Stay in the lobby without joining voice for more than 90 seconds; the
  current member must remain Online in the right sidebar.
- [ ] Click the already joined voice channel; it must open voice view rather
  than disconnect. Use the explicit disconnect control to leave.
- [ ] Verify push-to-talk and remapped mute/deafen/camera/share keybinds.
- [ ] Blocked users must not appear in presence responses visible to the
  blocker, and unauthorized LiveKit token requests must fail.

## P1 - Messaging and member UI

- [ ] Switch text channels and confirm existing messages load immediately.
- [ ] Send, edit, and delete an owned message from two browser profiles; verify
  realtime delivery and no duplicate local echo.
- [ ] As a moderator, pin/unpin a message and filter to pinned messages.
- [ ] Search messages by author and content; empty/search/pinned states must be
  accurate.
- [ ] Toggle per-channel mute and desktop notifications; background messages
  must respect level, preview, and mute preferences.
- [ ] Open user profiles from chat and member list; nickname, banner, roles,
  block action, online/offline grouping, and per-user volume must work.

## P1 - User and community settings

- [ ] Change profile display name, status, avatar, banner, and server nickname;
  reload and verify every saved value.
- [ ] Change appearance, accessibility, notification, voice/video, and keybind
  settings; verify sticky Save/Reset behavior and reload persistence.
- [ ] Verify the settings modal has one full-screen dialog and closes to the
  lobby with both Escape and the top-right close button.
- [ ] In Community Authentication, change instance registration/SEO settings
  and open the first community's canonical Access policy page.
- [ ] Create/edit/reorder/delete channels and roles with an authorized owner;
  verify dangerous role changes require confirmation.
- [ ] Create/revoke invites, kick/ban a test member, and inspect audit entries.

## P1 - Operations and Docker

- [ ] `/api/health` returns 200; PostgreSQL, Redis, LiveKit, web, and gateway
  remain healthy after app-only restart.
- [ ] Run update check and dry-run. Apply/rollback must remain blocked unless
  every environment flag, confirmation, maintenance, signature, backup, and
  allowlist gate is satisfied.
- [ ] Verify update/maintenance requests reject unknown JSON keys and oversized
  request bodies.
- [ ] Inspect logs for raw passwords, session cookies, handoff codes, provider
  tokens, SQL errors, and command stdout; none should be exposed.
- [ ] Rebuild and recreate app containers once more, then repeat login, one
  message, and one voice join as the final persistence smoke test.

## Automated gates before a release candidate

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm --filter @lobbyforge/web test:e2e
```

Run the live DB integration suite only against the preserved development DB
with its cleanup-safe test cases. Never point destructive test reset tooling at
that database.
