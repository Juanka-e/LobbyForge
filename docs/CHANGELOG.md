# Changelog

All notable changes to the LobbyForge monorepo skeleton.

## [Unreleased] - 6th-audit P0/P1 remediation (SEC/OPS) - 2026-09-03

### Fixed — the three P0 release blockers

- **SEC-001 — raw game state leaked over WebSocket**: the Redis activity
  bus shipped the CANONICAL state to every subscriber — a normal
  member's WS frames contained Hushle's deck/currentCard and Quiz's
  correctIndex. The bus wire format now carries ONLY status/revision/
  counts (regression test asserts the raw payload contains no
  currentCard/forbiddenWords/correctIndex); the ws-gateway loads the
  session and applies the CANONICAL projector per subscriber (moved to
  @lobbyforge/core so REST/SSE/WS share one implementation); the SSE
  route does the same on live events. Fail-closed: projection errors
  never forward unprojected state.
- **SEC-002 — private-channel rules skipped on WS + activity APIs**:
  gateway chat/activity-state topics now load the channel (directly, or
  via the session's channelId) and enforce role-gated visibility —
  owner/manage_channels bypass, same as REST. Every activity lifecycle
  route (list/GET/action/SSE/end) gates through
  authorizeSessionChannelVisibility; the LIST route's visibility gap is
  closed. 5 gateway negative tests (private chat, session-in-private-
  channel, cross-server session, manage bypass, presence stays
  membership-only).
- **OPS-001 — coturn restart loop**: the inline multi-line watcher
  collided with the image entrypoint's eval semantics (first line ran
  inside a command substitution; ~5-min restart cycles). The watcher is
  now a separate POSIX-sh script mounted read-only, invoked via an
  explicit entrypoint override.

### Fixed — high-priority (P1)

- **SEC-005 — OAuth open redirect**: protocol-relative (%2F%2Fevil) and
  backslash payloads no longer survive — sanitizeOAuthRedirect enforces
  a single-leading-slash same-origin path on BOTH the start route
  (write) and the callback (read; the cookie is client-writable
  storage). 4 fuzz-style tests.
- **SEC-004 — XFF spoofing**: nginx now sends X-Forwarded-For
  $remote_addr (NOT $proxy_add_x_forwarded_for, which preserved the
  attacker's chain); web + ws-gateway extract the LAST chain entry (the
  trusted-proxy-observed hop) instead of the attacker-controllable
  first.
- **SEC-003 — revoked sessions kept open realtime**: the WS handshake
  checks the Redis revocation set (fail-open only when Redis itself is
  down — REST stays the strict fail-closed gate); the SSE stream
  re-checks revocation on every keepalive tick.
- **OPS-002 — backup verifier trusted the manifest**: it now streams
  the REAL file's SHA-256 and stat-size and compares against the
  manifest (existence alone proved nothing). Positive + tampered-file
  tests. Also RT-001: the SSE cancel() path now runs the SAME
  idempotent cleanup as abort (interval + Redis subscription released).

## [Unreleased] - Desktop gap-analysis remediation (DP-01..DP-17) - 2026-09-02

### Fixed (desktop — see docs/DESKTOP_GAP_ANALYSIS.md)

- **DP-02 (P0)**: global push-to-talk works AFTER connecting to an
  instance. The old bridge (shell.js converting a Tauri event) died with
  the remote navigation and the remote origin has no `__TAURI__`; the
  shortcut now ALSO injects a postMessage via `window.eval` (runs on any
  page, no IPC surface opened).
- **DP-01 (P0)**: macOS ships NSMicrophoneUsageDescription /
  NSCameraUsageDescription (Info.plist file-path form — tauri-utils 2.9
  expects a PATH, not an inline map) + audio-input entitlements; without
  them getUserMedia refuses on macOS (voice = product core).
- **DP-06**: all four DEFAULT_SHORTCUTS are now registered (mute,
  deafen, settings were dead config) and forwarded to the page through
  the same eval bridge.
- **DP-05**: tray + PTT honour the persisted shell config
  (enableTray / globalPushToTalk store keys).
- **DP-16**: `disconnect_instance` actually navigates back to the local
  connect screen (was a no-op comment).
- **DP-08**: bundle.targets "all" (was msi/nsis-only — local mac/linux
  builds produced nothing while CI built them via tauri-action).
- **DP-04**: the `autoUpdate` config flag is REMOVED — no updater plugin
  exists; a visible no-op toggle lies to users.
- **DP-15**: shell CSP drops `script-src 'unsafe-inline'` (all shell
  scripts are external files).
- **DP-09**: real LobbyForge icon set (voice-arc mark over a forge bar
  on the app gradient) generated via `tauri icon` — replaces the
  template Tauri icons everywhere.

### Added

- **DP-07 — desktop session handoff (the flow, not just the parser)**:
  `POST /api/auth/desktop-session` mints a single-use code (Redis,
  5-min TTL) after credential validation; the OS-level
  `lobbyforge://session/complete` deep link is registered
  (plugins.deep-link.desktop.schemes) and the shell's `on_open_url`
  handler forwards it into the page;
  `POST .../complete` burns the code and issues the real session
  cookie. 8 route tests (mint/TTL, no-enumeration 401, burn+cookie,
  replay-401, expired-401, gone-account-401, malformed).
- **DP-17**: Windows install smoke job — downloads the NSIS artifact,
  installs silently, launches, fails if the process exits during
  startup. Installers are ALSO uploaded as run artifacts now
  (tauri-action attaches nothing without a tagName — that's why the
  first "successful" run produced zero artifacts).
- **DP-03**: README carries honest unsigned-alpha instructions
  (SmartScreen "More info → Run anyway"; macOS `xattr -cr`) until
  signing certificates exist.

## [Unreleased] - Plugin storage, two-client voice E2E, security gates - 2026-08-29
### Fixed (same batch)

- The runtime Docker image no longer ships devDependencies OR package
  managers: the Trivy CRITICAL gate caught vitest/happy-dom/tar CVEs
  (builder's full node_modules was copied wholesale), then a second
  layer — corepack's downloaded pnpm bundles its own vulnerable tar.
  The runtime now rebuilds node_modules prod-only OFFLINE from the
  builder's pnpm store, then strips the store, npm and the corepack
  cache; the web service invokes next's bin directly (no pnpm at
  runtime). Trivy: **0 findings** (CRITICAL, ignore-unfixed), verified
  against a stack running this image (both e2e suites green).


### Added

- **Plugin Storage API (Faz E)**: `ctx.storage` — persistent Postgres
  key-value storage scoped to (server, plugin); plugins never get SQL or
  a DbClient, the host executes get/set/delete/list/clear on their
  behalf. Keys constrained to [a-zA-Z0-9._:-]{1,128} (injection-shaped
  keys rejected, tested). SDK `StorageSubContext` + in-memory fallback
  in the test harness; wired through the action + activity-create
  contexts (unscoped contexts degrade to a visible in-memory fallback).
- **Two-client voice E2E (V5-008)**: two DISTINCT users (owner + a
  guest who redeems a real invite) each mint a LiveKit token, then two
  browser contexts run the actual livekit-client: connect, publish
  (fake-device) microphones, SUBSCRIBE to each other's audio track and
  round-trip data messages. Locally verified green; wired into CI. The
  e2e-ports override now runs LiveKit natively on 7890/7892 so ICE
  candidates actually reach THIS instance (the dev stack owns 7880-7882
  — advertising defaults sent client packets to the wrong container);
  the harness page is served CSP-free at the app origin via route
  interception (Chromium LNA blocks cross-origin loopback otherwise —
  test-only launch flags).
- **CI security gates (V5-009)**: CodeQL (javascript-typescript,
  security-extended) + weekly schedule, and Trivy container scan of the
  production image failing on CRITICAL (HIGH reported; base-image HIGHs
  are redeploy-actionable, not PR blockers).

## [Unreleased] - Role-gated private channels (0028) - 2026-08-29

### Added

- **Private channels (Discord-style role gating)**: a channel with role
  overrides is visible ONLY to holders of those roles (plus the owner
  and manage_channels/administrator); a channel with no overrides stays
  visible to everyone. Managed from Admin -> Channels via a role-chip
  picker ("leave empty for everyone"); gated channels show a lock badge.
- Enforcement across the surface: the channel LIST is filtered per
  member, and messages (read+write), LiveKit voice tokens, activities,
  typing, voice-mute and presence all 403 for members who cannot see
  the channel — a private room cannot be joined by guessing its id.
- `PATCH /api/servers/{id}/channels/{channelId}` accepts
  `visibleToRoleIds` ([] clears back to everyone); roles validated to
  belong to the server.
- Integration tests against a REAL migrated Postgres (override joins
  across legacy + multi-role membership, inheritance, replacement
  semantics) — wired into CI alongside the unit suites.

## [Unreleased] - Role permission upgrade: STREAM, timeouts, history/mention gates - 2026-08-17

### Added

- **STREAM permission** (role-level camera & screen-share gating): the
  LiveKit token route now intersects server-wide toggles with the
  MEMBER's role permissions — "only role X may share a screen" works.
  Without SPEAK a member joins listen-only; a timed-out member keeps
  listen access but loses the microphone.
- **MODERATE_MEMBERS timeout** — the step between a warning and a
  kick/ban: `PUT /api/servers/{id}/members/{userId}/timeout` (28-day
  cap, null clears). Enforcement on message send AND mic publish.
  Hierarchy applies (only members strictly below your highest role; the
  owner can never be timed out). Migration 0027 adds
  `memberships.timed_out_until` and backfills every existing @everyone
  role with the new baseline permissions so current servers keep their
  behaviour.
- **READ_MESSAGE_HISTORY** gate on the message list (write-only /
  announcement-style channels become possible).
- **MENTION_EVERYONE** gate on `@everyone` in message content.

### Changed

- Roles UI: new permission toggles (Timeout Members, Read Message
  History, Mention @everyone, Camera & Screen Share). `add_reactions`
  and `deafen_members` are HIDDEN from the UI until their features ship
  (no-op toggles mislead admins; enum keys stay reserved).

## [Unreleased] - Discord-style roles & hierarchy + GIF banners - 2026-08-17

### Added

- **Role hierarchy (Discord semantics)**: a member's rank is the highest
  position among their roles; the owner outranks everything. Assigning,
  editing, deleting, position-moving AND creating roles are now all
  restricted to roles STRICTLY BELOW the actor's highest — ADMINISTRATOR
  does NOT bypass this (matching Discord); only the owner does, and only
  the owner may change the owner's roles.
- **Emoji role icons**: any single Unicode emoji (ZWJ sequences, flags,
  skin tones, keycaps) is accepted alongside the legacy Material icon
  names — validated with Extended_Pictographic property escapes, length
  capped at 32 UTF-16 units; text/control-char/XSS payloads rejected.
- **GIF support**: avatars, user banners AND the new server banner accept
  animated GIF87a/GIF89a alongside PNG/JPEG/WebP.
- **Server-side image dimension enforcement**: a zero-dependency header
  parser reads real dimensions (PNG IHDR, GIF logical screen, WebP
  VP8/VP8L/VP8X, JPEG SOF scan). Avatars: min 256×256; banners: min
  960×540; both capped at 4096×4096. Polyglot defense: the declared MIME
  must match the content-sniffed format.
- **Server banner upload**: POST/DELETE /api/servers/\{id\}/banner
  (MANAGE_SERVER) persisting to servers.banner_url; the lobby sidebar
  header already renders it Discord-style behind the community name.
  Audit-logged.

### Fixed

- Git-Bash heredoc corruption trap documented in-source: shell-written
  regex files silently collapsed Unicode property escapes
  (String.raw used to make them shell-proof).

## [Unreleased] - 5th-audit fixes: production voice proxy, TURN lifecycle, fail-closed backup - 2026-08-16

### Fixed

- V5-001 (P0): production nginx forwarded `/livekit/rtc` to the upstream
  unchanged — LiveKit (serving `/rtc`, `/rtc/validate`) 404'd it, breaking
  EVERY production voice connection behind TLS. `location /livekit/` now
  pairs with `proxy_pass http://livekit:7880/;` so the prefix is stripped;
  a regression test pins the mapping and the load-bearing trailing slash.
- V5-005: LiveKit's plaintext HTTP signaling port 7880 is no longer
  published to the host in production (nginx proxies it internally at
  `wss://<domain>/livekit`); 7881 (ICE/TCP) stays public.
- V5-002: coturn now watches its certificate fingerprint and restarts
  itself when certbot renews (coturn has no reliable reload signal) —
  TURN/TLS no longer serves a stale certificate after ~60-90 days.
- V5-003: coturn denies relaying to private/CGNAT ranges (10/8,
  172.16/12, 192.168/16, 100.64/10) — with host networking a credential
  holder could otherwise pivot into the Docker/VPC network; quota raised
  (all clients share one username, 8 allocations would have capped the
  whole community); optional `LOBBYFORGE_TURN_EXTERNAL_IP` for 1:1 NAT,
  rendered into the config and reused across installer re-runs.
- V5-004: `lfctl backup restore` is FAIL-CLOSED — a missing/malformed
  checksum sidecar or a digest mismatch refuses the restore
  (`--allow-unverified` is the explicit escape hatch). The drill proves
  both refusal reasons specifically, runs on every CI push, and its
  transcript documents a full backup → DROP SCHEMA → restore → sentinel
  verification round trip.
- V5-007: idempotency claims carry a random ownership token and release
  is a Redis compare-and-delete (a stale owner can no longer delete a
  re-claimed key); a post-commit failure no longer releases the claim
  (retry reconciles via 409+GET instead of re-entering the reducer).
- V5-008: admin lazy card loading is a real tri-state — load failures
  show an error + Retry instead of masquerading as an empty pack; the
  freshly created/duplicated pack is selected immediately.
- V5-006: installer header no longer claims `curl | bash` (needs the
  repo tree); example URL points at the real repo; the update hint no
  longer suggests `docker compose pull` on a locally-built image.
- Docs (V5-010): README backup status, SECURITY.md release/backup
  wording, changelog "exactly-once" → duplicate suppression, TURN entry
  now includes TLS 5349.

## [Unreleased] - Security audit remediation + classic Taboo + E2E pipeline - 2026-08-16

### Added

- Admin word-pack management for Hushle (`/admin/plugins` + `/api/admin/card-packs`):
  create packs in any BCP-47 language, add/edit/delete words with forbidden
  words, difficulty and category; built-in packs are immutable with a
  one-click Duplicate-to-custom; admin mutations are audit-logged.
- Classic Taboo rules in Hushle: opposing-team players see the current card
  (word + forbidden words) through the canonical projector and can press
  BUST to penalise the explaining team (-1); teammates, floaters and
  anonymous buzzes are rejected server-side. The BUST button carries a
  double-click guard.
- Duplicate suppression for activity actions (LF-002 — NOT exactly-once:
  no response replay): optional `actionId` is claimed in
  Redis (SET NX + TTL) per session, never forwarded to plugin reducers,
  and released on every failure path.
- TURN fallback for restrictive networks (LF-019): standalone pinned coturn
  service (host networking, TLS certs shared with nginx), LiveKit
  `rtc.turn_servers` (udp 3478, tcp 3478 — TLS 5349 added in the 5th-audit fixes below), per-install `LOBBYFORGE_TURN_SECRET`
  generated once and reused across installer re-runs, firewall port
  checklist in the installer output, and `docs/VOICE_TURN.md` with a NAT
  test matrix.
- Compose-stack E2E (LF-023): `e2e/compose-stack.spec.ts` runs the full
  Hushle chain (setup → seeded packs → server → app install → start-game →
  projection → bust rules) against real Postgres/Redis/LiveKit and the
  production-built image; wired as a CI job plus `scripts/e2e-compose.sh`
  and an isolated parallel-stack compose override for local runs.
- CI production dependency audit gate (`pnpm audit --prod
  --audit-level=moderate`).

### Fixed

- Admin card-pack POST mutations all returned 400: the per-action Zod
  schemas were `.strict()` yet rejected their own `action` discriminator.
  Rewritten as a single discriminated union with hushle ownership enforced
  server-side, built-in immutability, ordinal-race retry and a
  language-scoped slug fallback.
- Lazy built-in pack seeding 500'd on every fresh production instance:
  runtime-only `webpackIgnore` imports could not resolve extensionless
  plugin TS imports nor the `@/lib` alias outside webpack. The seeder now
  uses plain bundled imports and the admin route triggers seeding too.
- Hushle `start-game` always 404'd: the host UI sends the pack SLUG while
  the server only looked packs up by UUID. Both are now resolved.
- Deck and current-card leakage closed for every viewer (LF-001): one
  canonical projector across GET/action/SSE, `cardsRemaining` subtracts
  used cards, the deck is removed with `delete`.
- `server_local_cards` gained a language scope (migration 0026) so
  Turkish local words never leak into German decks.
- Installer re-runs with a new domain left nginx/LiveKit on the old one
  (LF-010-R): configs are now rendered from git-tracked templates on every
  run; production images pinned (certbot v2.11.0, livekit 1.8.3,
  coturn 4.6.2); secrets are reused from an existing `.env.prod`.
- Certbot paths are fail-closed and a running stack is detected before
  standalone mode can fight nginx for port 80.
- Activity creation now registers the creator as the first player, and
  card-packs routes log errors instead of swallowing them.

## [Unreleased] - M22: Production readiness outside the app/plugin system - 2026-07-15

### Added

- Added opt-in LiveKit screen-stream subscriptions, server-enforced maximum
  stream resolution/FPS, compact voice-only tiles, rich member profiles with
  bio/roles/per-user volume, allowlisted role icons, and a single-community
  self-host lobby shell without the official instance rail.

- Adopted a Tauri 2-first desktop direction with a mandatory Windows
  LiveKit/WebView2 media and security spike; Electron remains a compatibility
  fallback until the spike passes.
- Fixed the product boundary for messaging: instance-local DMs ship first,
  while official-account friends/DMs remain a separate later service and data
  scope.
- Migrated the web app to Next.js 16.2 and React 19.2. The production
  Turbopack build completes without file-tracing warnings; no global
  `proxy.ts` was added because authentication remains enforced at route and
  server-component boundaries.
- Aligned `packages/ui` with React 19 types and React-19-compatible Lucide and
  Testing Library releases, removing the split React type graph.
- Added open and invite-only local account registration plus explicit logout.
- Added the `user_identity_links` migration and query layer. External account
  references are unique and contain no provider credentials.
- Added public-registry URL validation against insecure/private origins and a
  state-bound, one-time-code desktop session handoff parser with log redaction.
- Added full-screen voice focus, runtime keybinds, message search and
  permission-gated pinning, per-channel mute, and native desktop message
  notifications.
- Local-account password changes now verify the existing scrypt credential,
  hash the replacement, and update it with an old-hash compare-and-swap guard.
- My Account now opens the canonical password modal and persists the change
  through `/api/auth/password`; UI and API share a 12-character minimum.
- The shared API security boundary checks Redis-backed session revocations for
  authenticated cookies. Revoked cookies receive `401` and are cleared;
  production fails closed with `503` if revocation storage is unavailable.
- Password changes revoke every other tracked session while preserving the
  current device.

### Fixed

- Rebuilt the full-screen voice surface around compact voice-only tiles,
  camera grids, screen-share stage plus filmstrip, and a safe-area-aware call
  dock. Desktop and 390px Chromium checks cover camera, screen share, native
  stop-sharing, viewport bounds, and overflow.
- Made member join-date rendering deterministic (`en-US`, UTC), removing a
  server/client locale hydration mismatch in Community Settings.
- LiveKit JWT grants now serialize screen sharing as `screen_share` and
  `screen_share_audio`; the previous hyphenated values were parsed as unknown
  sources and prevented screen publication.
- Camera and screen-share UI state now follows actual LiveKit local-track
  publish/unpublish events, including the browser-native stop-sharing action.
- Rebuilt the voice focus view as a true viewport portal with a share-first
  stage, participant filmstrip, responsive camera grid, persistent media dock,
  and visible media permission errors.
- Production CSP now derives exact HTTP/WebSocket connect origins from the
  configured public LiveKit and realtime URLs. Local Docker voice traffic is
  no longer blocked before reaching LiveKit.
- Docker Compose now passes `LOBBYFORGE_SETUP_TOKEN` into the web container;
  previously the documented installer token could never satisfy production
  bootstrap validation.
- Material Symbols now ship as a local WOFF2 asset in the production image.
  Icon ligature text can no longer expand lobby/settings controls when an
  external font request is blocked; CSP no longer permits Google font hosts.
- Added a Chromium regression test for local icon loading, fixed icon width,
  hidden ligature overflow, and the absence of external Google stylesheets.
- Test-reset routes now pass through the shared API security boundary while
  retaining their test-environment and high-entropy token gates.
- Maintenance and update mutations use strict, size-bounded schemas.
- Blocked users are excluded from presence reads; public invite lookups use a
  stricter rate limit and uniform not-found behavior.
- Explicit per-server access policies are enforced by local registration
  before password hashing; approval-only modes fail closed.
- Removed settings rows that advertised unavailable 2FA, recovery, export,
  pronoun, email-digest, or mobile-push behavior.
- Initial bootstrap no longer inserts a duplicate text/voice channel pair
  after `createServer()` has already seeded the defaults.
- Added focused password and central session-revocation security tests.

### Verification

- 524 workspace tests pass; live PostgreSQL integration passes 5/5 and
  Chromium security/settings smoke tests pass 3/3.
- All 15 workspace projects pass typecheck and production build. Lint has zero
  errors and two intentional database-avatar optimization warnings.

## [Unreleased] — M21.9: Lobby interaction polish + cleanup — 2026-06-30

Final cleanup pass: dead code removal, lint warnings fixed, voice channel
visibility fix, profile popover redesign, per-user volume control, @mention
autocomplete, typing indicator, message edit/delete, text channel switching,
auto-scroll, Enter-to-send, N+1 block list fix, and IPv6/localhost connectivity
fixes.

### Added
- **Text channel switching** (`LobbyTextChannels.tsx`) — clicking a text channel switches the main area's messages. Active channel highlighted.
- **Enter-to-send** — MentionInput only intercepts Enter when the dropdown is open.
- **Auto-scroll** — LobbyLiveRoster scrolls to bottom on new messages.
- **Typing indicator** — `POST/GET /api/.../typing` + Redis TTL 5s + 3s poll + "X is typing...".
- **Message edit/delete** — hover edit/delete buttons on own messages.
- **Unread badges** — localStorage last-seen tracking, primary dot on unread channels.
- **Per-user volume slider** — `setRemoteVolume/getRemoteVolume` in LobbyVoiceProvider, popover shows slider for in-voice users, stored per-user in localStorage.
- **UserProfilePopover redesign** — 340px, banner with role color gradient, avatar overlap, bio section, volume slider, block button.
- **@mention autocomplete** — `MentionInput.tsx`, keyboard nav, role-colored suggestions.
- **BlockListProvider** — shared context, single fetch for all member rows.
- **Presence on page load** — `loadLiveData` writes the current user's presence on SSR so they appear online immediately.

### Fixed
- **Voice channels hidden** — `data-empty-channel` attribute + `hideEmptyChannels: true` default was hiding empty channels. Both removed for voice channels.
- **Profile popovers stacking** — shared `openUserId` state in LobbyMembersClient, only one popover open at a time.
- **Audio playback** — remote audio elements changed from `display:none` to `position:absolute;width:0;height:0;opacity:0` so browsers actually play them.
- **Voice channel seeding** — `createServer` now seeds `general` (text) + `Main Lounge` (voice).
- **Rules of Hooks** — LobbyMainArea split into Live + Demo variants.
- **Race condition** — `connectTokenRef` prevents orphaned rooms on rapid channel switch.
- **Render loop** — `applyRemoteAudio` effect depends on `deafenEnabled` only.
- **Cross-server IDOR** (Critical) — activities list now verifies channel ownership.
- **Raw error leaks** — admin updates + SSE stream return generic messages.
- **Role assignment IDOR** — target user verified as member before role assignment.
- **Stale closures** — `voiceChannelIds` in refs across LobbyMembersClient + LobbyVoiceChannels.
- **IPv6 connectivity** — all `.env.local` URLs changed from `localhost` to `127.0.0.1`.
- **WS Gateway** — must be started as a separate process (`node dist/index.js` from `apps/ws-gateway`).

### Removed (dead code)
- `LobbyVideoPanel.tsx` — replaced by LobbyVoiceView.
- `LobbyMemberItem.tsx` — replaced by inline MemberRow in LobbyMembersClient.
- `LobbyMessageAuthor.tsx` — replaced by plain span in LiveMessage.
- `ChannelGroupClient.tsx` — unused since LobbyTextChannels replaced it.
- Unused props: `showLabel`, `serverId` from MentionInput; `menuOpen` from LiveMessage.

### Numbers
- 326/326 tests across 51 files.
- 0 errors, 3 warnings (all `<img>` for DB-sourced avatars — pragmatic).
- 6/6 Playwright E2E tests passing.
- `/lobby` 16.1 kB First Load JS.
- 15/15 workspace projects typecheck clean.



Final lobby UX pass: text channel switching, Enter-to-send, auto-scroll,
typing indicator, message edit/delete UI, unread badges, N+1 block list
fix, audio playback fix (display:none → absolute), voice channel seeding
fix, and a comprehensive security audit with fixes.

### Added - Lobby interaction features

- **Text channel switching** (`LobbyTextChannels.tsx`) — clicking a text channel in the sidebar now switches the main area. Active channel highlighted. `LobbyVoiceProvider` holds `activeTextChannelId` + `activeTextChannelName` + `setActiveTextChannel()`. `LobbyMainArea` reads the provider's active channel and passes the correct `channelId` to `LobbyLiveRoster` (keyed remount on channel change).
- **Enter to send** — `MentionInput` only intercepts Enter when the @mention dropdown is open. When closed, Enter propagates to the form for natural submit.
- **Auto-scroll to bottom** — `LobbyLiveRoster` attaches a `scrollRef` and calls `scrollTop = scrollHeight` on every messages change.
- **Typing indicator** — `POST/GET /api/servers/{id}/channels/{channelId}/typing`. Composer sends a heartbeat every 3s while typing (rate-limited 30/10s). `LobbyLiveRoster` polls every 3s and shows "X is typing..." with animated dots. Redis TTL 5s.
- **Message edit/delete** — own messages show an edit + delete button on hover. Edit: inline `<input>` with Save/Cancel. Delete: direct `DELETE` call. Both hit the guarded message PATCH/DELETE endpoints.
- **Unread message badge** — `LobbyTextChannels` tracks last-seen per channel in localStorage. Non-active channels with recent message activity show a primary-colored dot.
- **BlockListProvider** — shared context that fetches the block list once and distributes it to all `MemberBlockButton` instances. Eliminates N+1 API calls (was 1 fetch per member row → now 1 fetch total).
- **Per-user volume slider** — `setRemoteVolume/getRemoteVolume` in `LobbyVoiceProvider`. Popover shows a volume slider for users in voice. Stored per-user in localStorage. Audio element `.volume` is set directly.
- **UserProfilePopover redesign** — Discord-style banner + avatar overlay + role color accents + block button + volume slider. Uses `useLayoutEffect` for positioning.
- **@mention autocomplete** — `MentionInput.tsx` with keyboard navigation (↑/↓/Enter/Tab/Escape), role-colored suggestions, avatar thumbnails.

### Fixed - Critical bugs

- **Audio playback** — remote audio elements used `display:none` which prevents playback in most browsers. Changed to `position:absolute;width:0;height:0;opacity:0`. Container also changed from `className="hidden"` to the same invisible-but-playable style.
- **Voice channel seeding** — `createServer()` now creates `general` (text, position 0) + `Main Lounge` (voice, position 1). `loadLiveData` auto-repairs existing servers with zero channels.
- **Rules of Hooks** — `LobbyMainArea` split into `Live` + `Demo` variants; `useLobbyVoice()` no longer called conditionally.
- **Race condition** — `connectTokenRef` prevents orphaned rooms on rapid channel switching.
- **Render loop** — `applyRemoteAudio` effect now depends on `deafenEnabled` only, not `participants`.
- **Cross-server IDOR** (Critical) — activities list GET now verifies `channel.serverId === serverId`.
- **Raw error leaks** — admin updates route + SSE stream now return generic messages.
- **Role assignment IDOR** — target user verified as server member before role assignment.
- **Block state desync** — `MemberBlockButton` checks `res.ok` before flipping state.
- **Stale closures** — `voiceChannelIds` stored in refs in `LobbyMembersClient` + `LobbyVoiceChannels`.
- **nameCacheRef stale** — `LobbyLiveRoster` syncs via `useEffect` when `knownNames` prop changes.

### Numbers

- `pnpm -F @lobbyforge/web build` green: `/lobby` ~15 kB, 90+ routes.
- `pnpm -F @lobbyforge/web typecheck` green across all 15 workspaces.
- `pnpm -F @lobbyforge/web lint` 0 errors (2 warnings: `<img>` for avatars).
- `pnpm -F @lobbyforge/web test` green: **326/326** across 51 test files.

### Security audit summary

| Finding | Severity | Status |
|---------|----------|--------|
| Cross-server IDOR (activities list) | Critical | Fixed |
| Admin updates raw error leak | High | Fixed |
| SSE stream raw error leak | Medium | Fixed |
| Role assignment IDOR | Medium | Fixed |
| Test-reset endpoints lack `withApiSecurity` | High | Fixed |
| Maintenance PATCH lacks Zod schema | Medium | Fixed |
| Admin updates POST body unvalidated | Medium | Fixed |
| Presence returns blocked users | Low | Fixed |
| Invite code length / enumeration | Low | Fixed |
| Card-packs GET has side effect | Low | Accepted (idempotent) |

## [Unreleased] — M21: Stitch designs canonical integration + security hardening — 2026-06-22

Brings the Stitch design corpus (`design_stitch/*`) into the live app as
canonical, data-driven React — replacing the static `TEMPLATE_*` lobby
mock with real DB/Redis data, landing the Calm Future motion tokens,
shipping the missing modal primitives, wiring LiveKit voice + video
into the lobby shell, **and** a parallel security hardening pass.

### Added - Real-time infrastructure (WS Presence Topic + Voice View + Block System + Session Tracking + Bandwidth)

- **WS Gateway `presence:{serverId}` topic** (`apps/ws-gateway/src/protocol.ts`, `authorize.ts`) - the gateway protocol now supports a third topic kind alongside `chat` and `activity-state`. Presence topics are 2-part (`presence:{serverId}`) and use the same server-membership authorization as the other kinds. The Redis topic is `lf:{env}:presence:{serverId}`.
- **`apps/web/lib/presence-bus.ts`** - new Redis pub/sub publisher mirroring `chat-bus.ts` and `activity-bus.ts`. The `/api/presence` POST handler calls `publishPresenceChange(...)` after writing to Redis, so every presence update (voice join/leave, heartbeat, activity change) is pushed to all WS subscribers in real time (<100ms latency).
- **`apps/web/app/lobby/LobbyMembersClient.tsx`** - real-time members panel that subscribes to `presence:{serverId}` via the `RealtimeClient` singleton for instant status updates. Falls back to a 30s HTTP poll to catch TTL expirations (laptop close, network drop). Derives member status from `channelId` membership and `lastSeen` staleness.
- **Voice View mode** (`apps/web/app/lobby/LobbyVoiceView.tsx`, `LobbyMainArea.tsx`, `LobbyVoiceProvider.tsx`) - Discord-like toggle between chat view (normal text channel, full width) and voice view (full-screen video tile grid + pinned screen-share tile + click-to-focus + "Back to Chat"). The channel header shows a "Voice View" button when connected. Video tiles no longer sit between the channel header and messages.
- **User block system** (`packages/db/src/queries/userBlocks.ts`, `drizzle/0014_user_blocks.sql`, `schema.ts` `userBlocks` table) - directional block list. Blocked users' messages are masked at the server level in both the messages API and the lobby SSR path - the content never reaches the client. Block/unblock is available from the lobby member panel (`MemberBlockButton`) and the Privacy & Activity settings page. `GET/POST /api/settings/me/blocks` + `DELETE /api/settings/me/blocks/[userId]`.
- **Session tracking** (`apps/web/lib/session-tracker.ts`) - Redis-based session fingerprints keyed by the cookie `gid`. Parses User-Agent into browser/OS/device type (zero-dependency regex). Resolves client IP via trusted proxy headers (`x-forwarded-for`, `cf-connecting-ip`). Resolves location from Cloudflare/Vercel geo headers. Fire-and-forget `recordSession(...)` on `/api/auth/guest` GET+POST and `/api/settings/me` GET. 7-day TTL. `GET/PATCH /api/settings/me/sessions` for list + revoke.
- **Bandwidth counter + alert** (`apps/web/lib/redis.ts` `incrServerBandwidth/getServerBandwidthTotals/clearBandwidthAlert`, `apps/web/app/api/admin/bandwidth/route.ts`, `apps/web/app/admin/bandwidth/page.tsx`) - LiveKit RTC stats sampled every 30s in `LobbyVoiceProvider` (outbound-rtp bytesSent + inbound-rtp bytesReceived), diffed against the previous sample, accumulated in the presence heartbeat. Per-server total/daily/hourly Redis counters with 35d/8d TTLs. Alert triggered when `LOBBYFORGE_BANDWIDTH_ALERT_BYTES` threshold is exceeded. Admin UI at `/admin/bandwidth` with 24h bar chart + per-server breakdown + acknowledge button. Health sidebar shows bandwidth summary with link.
- **Speaking indicator fix** (`globals.css`, `LobbyVoiceChannels.tsx`) - `.is-speaking` CSS no longer sets `border-color` (Tailwind handles it). Speaking avatars use `border-success` (green); non-speaking uses explicit `border-transparent`. The pulse animation only runs while the class is present.
- **Accessibility settings** (`apps/web/app/settings/accessibility/page.tsx`) - localStorage-backed local browser preferences: reduced motion (OS auto-detect + manual override via `.force-reduced-motion` class), high contrast, large text, always-show-focus. No server persistence (device-specific).
- **Community unavailable fix** (`apps/web/app/lobby/page.tsx`) - `loadLiveData` no longer returns `null` when a server has no channels. A freshly set-up server shows empty states ("No channels yet") instead of a hard error screen.

### Added - Community settings editor wiring

- **`apps/web/app/admin/settings/members/MembersClient.tsx`** - member list now supports real search, role filtering, sorting, guest badges, server nickname display, role assignment, kick, and ban actions through guarded APIs.
- **`apps/web/app/admin/settings/channels/ChannelsClient.tsx`** - channel settings now create, edit, delete, and reorder channels through the guarded channels API. The page no longer renders a read-only placeholder.
- **`apps/web/app/admin/settings/roles/RolesClient.tsx`** - role settings now create, edit, and delete roles through the guarded roles API. Permission toggles use the known core permission set, `@everyone` cannot be renamed/deleted from the UI, and administrator grants require a confirmation prompt.
- **`apps/web/app/admin/settings/voice-media/VoiceMediaClient.tsx`** - Voice & Media now persists per-server settings through `/api/servers/{id}/voice-settings`. Camera and screen-share settings are enforced in `/api/livekit/token` by narrowing LiveKit publish sources.
- **`apps/web/app/admin/settings/backups/page.tsx`** - Backups no longer shows fabricated success data. It verifies the configured backup manifest and reports missing worker/manifest state explicitly.
- **`apps/web/app/admin/settings/storage/page.tsx`** - Storage no longer invents a placeholder quota. It reports real attachment usage and clearly marks quota as not enforced until an upload gate exists.
- **`apps/web/app/admin/audit/AuditClient.tsx`** - Audit Log now has real search, category filters, sorting, metadata inspection, and client-side CSV export. Exported cells are quoted and formula-like values are neutralized to avoid spreadsheet injection.
- **`apps/web/app/admin/settings/authentication/InstanceAccessForm.tsx`** - Authentication settings now use the canonical modal styling with clear open/invite-only/closed semantics, dirty-state detection, reset, and a sticky save footer. The instance-settings PATCH endpoint now has an explicit 2 KiB body limit.
- **`apps/web/app/admin/settings/invites/InvitesClient.tsx`** - Invites now have search, active/expired/exhausted filtering, active-link copy protection, and a revoke confirmation dialog. Public invite metadata/redeem routes share a canonical 12-character code validator.
- **Build hygiene** - Removed stale lobby imports, an unused block-list import, and unused catch bindings across API routes so `next build` no longer hides real issues behind repeated unused-variable warnings.
- **Docs** - `docs/WEB_APP.md` and `projectdetails/31_PRODUCT_DECISIONS_AUTH_APPS_UPDATES.md` now describe the implemented community settings behavior, including members, roles, channels, voice/media, backups, storage, and audit review.

### Fixed - Lobby interaction and user appearance polish

- **`apps/web/app/lobby/LobbyVoiceProvider.tsx`** - remote LiveKit audio tracks are now attached to hidden audio elements, so two users in the same lobby voice channel can hear each other. Voice-activity mode starts the mic on join; push-to-talk stays muted until the configured key is held.
- **`apps/web/app/lobby/LobbyVoiceChannels.tsx`** - clicking the already-connected channel no longer disconnects the user. It opens the full voice/video view instead. Voice rosters render from the server-wide presence snapshot, so users inside voice channels are visible before the local user joins.
- **`apps/web/app/lobby/LobbyMembersClient.tsx`** and **`apps/web/app/lobby/page.tsx`** - the right member sidebar groups only Online and Offline. Voice participants remain online members instead of appearing in a separate "In Voice" section.
- **`apps/web/app/lobby/LobbyMemberItem.tsx`** and **`apps/web/app/lobby/LobbyMessageAuthor.tsx`** - member rows and chat authors now open the shared profile popover; block/unblock remains backed by the existing guarded block APIs.
- **`apps/web/app/lobby/LobbyMainArea.tsx`** - the lobby composer now posts to the guarded channel message API instead of rendering inert controls. Attachment, gift, and GIF buttons are explicitly disabled until those features land.
- **`apps/web/app/AppearanceRuntime.tsx`** and **`apps/web/app/settings/appearance/page.tsx`** - appearance settings now apply immediately and are re-applied from account/local preferences on page load. Accent, density, compact chat, hidden avatars, and empty-channel hiding have CSS hooks in `globals.css`.
- **Lobby header/server controls** - the server name hover menu now exposes admin, channel, and invite shortcuts; voice channel rows expose a channel-settings shortcut that routes to the guarded admin channel settings page.

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M21.1 | Lobby live data | done | `/lobby` reads channels/members/messages/presence from DB+Redis; demo mode preserved for unauthenticated visitors |
| M21.2 | Calm Future motion tokens | done | 5 keyframes + 5 `animate-*` Tailwind utilities + `.stagger-*` + `.speaking-ring` + reduced-motion override |
| M21.3 | Missing modal primitives | done | `ChangeBannerModal` + `HushleRoomSelectionModal`; `CreateVoiceRoomModal` skipped (existing `CreateChannelModal type='voice'` covers it) |
| M21.4a | Lobby → voice connect (LiveKit in lobby) | done | Sidebar voice channel click → inline `livekit-client` `Room.connect()`, real mic toggle + presence heartbeat, no `/room/[roomName]` navigation needed |
| M21.4-fix | Lobby shell full-width + identity + CSS fix | done | 72px server rail; `max-w-[1280px]` removed; identity shows `displayName` instead of UUID; nested `<main>` fixed in `/setup` and `/login`; reconnecting state in footer |
| M21.4b | Video tile grid | done | `LobbyVideoPanel` renders LiveKit participant cameras as `<video>` tiles; camera + screen share toggles in footer; speaking ring (green) + mic indicator overlay |
| M21.4c | Screen share large pinned tile + click-to-focus | done | auto-pinned large tile for screen share publishers, click-to-pin any participant, `PinnedTile` with `object-contain` for screen / `object-cover` for camera |
| M21.4d | Fullscreen / participant focus | planned | full-screen modal view of the pinned tile |
| M21.5 | Community settings live wiring | done | `admin/settings/*` pages use real DB/config data; backups report missing worker state explicitly and storage marks unenforced quotas honestly |
| M21.5-bw | Admin bandwidth counter + alert system | done | LiveKit RTC stats sampling → Redis accumulator → `/api/admin/bandwidth` → `/admin/bandwidth` page with hourly bar chart + alert threshold; Health page sidebar shows bandwidth summary |
| M21.6 | User settings completion | done | Privacy & Activity rewritten with real API + blocked users management; Accessibility localStorage-backed; Active Sessions with real Redis session tracking; non-existent features (DM/friends) removed |
| M21.6-bl | User block system | done | `user_blocks` table + query helpers + API; messages masked at server level ("🚫 Blocked user"); block/unblock from lobby members panel + settings page |
| M21.6-ses | Session tracking system | done | Redis-based session fingerprints (IP, browser, OS, device); UA parser; fire-and-forget on auth/sessions/settings routes; 7d TTL; revoke from settings |
| M21.6-lobby-polish | Lobby voice/chat/profile polish | done | remote audio attached; current channel click opens voice view; sidebars use Online/Offline only; profile popovers and composer posting wired |
| M21.7 | Hushle session view (M20c) | deferred | plugin system — user explicitly deferred to last |
| M21.S | Security hardening pass | done | dev admin bypass removed; CSRF Fetch Metadata + request size limits; crypto RNG for guest ids; raw error sanitization; mandatory test-reset token; manifest parser/fetch hardening; CSP policy strict; ws-gateway origin verification; 36/36 mutation routes wrapped with `withApiSecurity` |

### Added — Screen share large pinned tile (M21.4c)

- **`apps/web/app/lobby/LobbyVoiceProvider.tsx`** — `LobbyVoiceParticipant` gains `cameraEnabled` + `hasScreenShare` booleans so the UI can distinguish camera publishers from screen-share publishers. New `getParticipantScreenShareTrack(identity)` mirrors the camera track getter for `screen_share`-source tracks.
- **`apps/web/app/lobby/LobbyVideoPanel.tsx`** — extended with a `PinnedTile` component rendered above the participant strip when:
  - someone is sharing their screen (auto-pinned; the user cannot minimize until sharing stops), or
  - the user clicks any participant tile (manual pin; click again or click "Minimize" to return to strip-only).
  The pinned tile renders at 16:9 for screen share (`object-contain` on black) or 4:3 for camera focus (`object-cover`), with a max height of 360px so it doesn't consume the whole chat area. Each participant tile is now a `<button>` for keyboard accessibility.
- **`apps/web/app/lobby/LobbyVoiceChannels.tsx`** — the disconnected-state fallback mapping seeds the new `cameraEnabled` / `hasScreenShare` fields as `false` so TypeScript stays satisfied.

### Added — Admin bandwidth counter + alert system (M21.5-bw)

- **`apps/web/lib/redis.ts`** — three new helpers: `incrServerBandwidth(serverId, bytesDelta, {alertThresholdBytes})` accumulates into per-server total + per-day + per-hour counters (TTL: 35d / 8d) and bumps an alert key when the threshold is exceeded. `getServerBandwidthTotals(serverId, {hours})` reads the totals + trailing hourly breakdown. `clearBandwidthAlert(serverId)` clears the alert flag after admin acknowledgement. Keys: `lf:{env}:bw:{serverId}:total|{day}|{hour}` and `lf:{env}:bw:alert:{serverId}`.
- **`apps/web/app/api/presence/route.ts`** — presence POST schema gains optional `bandwidthDeltaBytes` (capped at 10 GiB to reject absurd values). When present, the handler calls `incrServerBandwidth` with the env-configured `LOBBYFORGE_BANDWIDTH_ALERT_BYTES` threshold. Bandwidth write failures are swallowed (presence write already succeeded; next heartbeat retries).
- **`apps/web/app/lobby/LobbyVoiceProvider.tsx`** — every 30 seconds, `startBandwidthSampler(room)` calls `room.getStats()` to read `outbound-rtp.bytesSent` + `inbound-rtp.bytesReceived` from the RTC stats report, diffs against the previous sample, and stashes the delta in `pendingBandwidthDeltaRef`. The existing 5-second presence heartbeat picks up the accumulated delta and sends it as `bandwidthDeltaBytes`. Disconnect + unmount tear down the sampler.
- **`apps/web/app/api/admin/bandwidth/route.ts`** — admin-only GET returns per-server totals + 24h hourly breakdown; admin-only POST acknowledges an alert. Auth: `isInstanceAdminAllowed` (owner session or `LOBBYFORGE_ADMIN_TOKEN`). Rate-limited at 30/min GET, 10/min POST.
- **`apps/web/app/admin/bandwidth/page.tsx`** — admin UI rendering: three stat cards (total / today / alert status), per-server table with a 24-hour bar chart, "Acknowledge" button per alert-triggered server. Polls every 30s. Threshold display reads `NEXT_PUBLIC_LOBBYFORGE_BANDWIDTH_ALERT_BYTES`.
- **`apps/web/app/SettingsShell.tsx`** — `COMMUNITY_NAV` gains a "Bandwidth" entry at `/admin/bandwidth` between Voice & Media and Authentication.



### Added — Security hardening (M21.S)

- **`apps/web/lib/admin-auth.ts`** — development admin bypass removed. Admin endpoints now require either an owner session cookie or a strong emergency admin token (`LOBBYFORGE_ADMIN_TOKEN`, 32+ chars, constant-time compared). The bypass that previously let unauthenticated requests through in `NODE_ENV !== 'production'` is gone — every environment applies the same gate.
- **`apps/web/lib/security-headers.ts`** — CSRF protection via Fetch Metadata (`Sec-Fetch-Site`, `Sec-Fetch-Mode`, `Sec-Fetch-Dest`) on top of the existing Origin check. State-changing browser requests without the right Fetch Metadata triples are rejected. Added a per-route request size limit (default 1 MiB; manifest upload allows more) so a malicious peer can't OOM the Node process with a giant JSON body before validation runs.
- **`apps/web/lib/password.ts`** — guest id generation moved from `Math.random()` to `crypto.randomBytes()` (Web Crypto where available, Node `crypto` fallback). Guest ids are now 256 bits of entropy, not 52-bit floats.
- **`apps/web/lib/test-reset-auth.ts`** — test-reset endpoints (`/api/test/db-reset`, `/api/test/redis-reset`) now require `LOBBYFORGE_TEST_RESET_TOKEN` unconditionally when `NODE_ENV === 'test'`. Previously the token was optional; a misconfigured CI environment without the env var would silently let the endpoint through.
- **`apps/web/lib/update-planner.ts`** — manifest fetch hardened: 5 MiB download cap, 5s connect timeout, 10s overall timeout, strict JSON schema validation, deep-freeze of the parsed object so a tampered runtime can't mutate it after validation. The parser rejects unknown top-level keys and limits nesting depth (anti-JSON-bomb).
- **`apps/web/lib/api-source-security.ts`** (new) — small helper that strips raw `Error.message` and stack traces from API responses in production. The 500 response shape is now `{error: 'Internal error', requestId}`; the detailed `detail` field is logged server-side only.
- **`apps/web/lib/lobby-mode.ts`** — lobby-mode gating helper centralizing the "is this the official deployment" + "is bootstrap complete" checks that the lobby, login, and setup pages all need. Previously each page re-implemented the conditional; now they share one helper so the security boundary is in one place.

### Tests — Security hardening

- `lib/__tests__/admin-auth.test.ts` — owner-session pass, emergency-token pass, dev bypass rejected, weak token rejected, missing token rejected.
- `lib/__tests__/security-headers.test.ts` — Fetch Metadata accept/reject matrix, request size limit enforcement.
- `lib/__tests__/test-reset-auth.test.ts` — token required in test env, token required in any env when configured.
- `lib/__tests__/security-config.test.ts` — env var presence + strength (32+ chars) for session secret, admin token, test-reset token.
- `lib/__tests__/api-source-security.test.ts` — error sanitization preserves the requestId, strips stack traces.
- `lib/__tests__/lobby-mode.test.ts` — bootstrap-complete + official-deployment matrix.
- `lib/__tests__/update-planner.test.ts` — extended with manifest-too-large, fetch-timeout, schema-rejects-unknown-keys, deep-freeze assertions.

Suite went from 273 tests / 35 files to **296 tests / 41 files** (+23 tests, +6 files).

### Added — Lobby shell full-width + server rail (M21.4-fix)

- **`apps/web/app/lobby/page.tsx`** — `LobbyShell` wraps the whole shell (server rail + sidebar + main + members panel) in `<LobbyVoiceProvider>` when `canVoiceConnect`, so both the sidebar voice channels AND the main-area video panel can read from the same LiveKit context. Removed `max-w-[1280px] mx-auto` — the lobby now fills the viewport. Sidebar uses `w-[240px] lg:w-[260px]` responsive width instead of a fixed 260. Members panel uses `w-[200px] lg:w-[230px]`.
- **`ServerRail`** (new component inside `page.tsx`) — the 72px left navigation bar from Stitch `animated_desktop_shell`: LF home button, active community pill, add-instance CTA (official deployments only), settings shortcut at the bottom. Hover tooltips via `.rail-tooltip`. Animates in with `animate-fade-in-right`.
- **`LobbyData.currentDisplayName`** (new field) — the local user's display name resolved server-side via `getUserById(db, currentUserId)`. Passed to `LobbyVoiceProvider` as `localDisplayName` and seeded into `buildKnownNames()` so the LiveKit voice roster shows the user's real name on the local tile instead of the raw UUID identity (which the token endpoint sets to `session.uid`).
- **Token endpoint now receives `displayName`** — `LobbyVoiceProvider.connectToChannel` sends `{serverId, channelId, displayName: localDisplayName}` so LiveKit's participant `name` field is the human name, not "Guest" or empty.
- **Connection state UI feedback** — `LobbyVoiceFooter` distinguishes Connecting / Reconnecting / Connected / Ready with the right dot color and label. The mic / camera / call-end buttons are disabled until Connected, not just until `voice.connecting` flips false.
- **CSS layout fix** — `/setup` and `/login` had a nested `<main>` inside the layout's outer `<main className="flex-1">`, plus `min-h-dvh` on the inner element that fought the outer flex. Both pages now use `<div className="flex h-full w-full items-center justify-center bg-background px-5 py-10 safe-area-page">`. The HTML semantic violation (nested `<main>`) is fixed too. Tailwind stack is `^3.4.13` (v3, not v4) — confirmed against `apps/web/package.json`. The whole Calm Future token system (`tailwind.config.ts` colors/font/spacing/animation) is v3-idiomatic and does not require a v4 migration.

### Added — Video tile grid (M21.4b)

- **`apps/web/app/lobby/LobbyVoiceProvider.tsx`** — extended with `cameraEnabled`, `screenShareEnabled`, `toggleCamera`, `toggleScreenShare`, `getParticipantCameraTrack(identity)`. Camera toggle calls `localParticipant.setCameraEnabled`; screen share calls `setScreenShareEnabled`. `getParticipantCameraTrack` walks the local + remote participant publications for a `camera`-source video track and returns the underlying `MediaStreamTrack` — the tile attaches it directly to a `<video>` element without pulling in `@livekit/components-react`.
- **`apps/web/app/lobby/LobbyVideoPanel.tsx`** — client island rendered above the message list when connected. Horizontal scroll strip of `ParticipantTile`s (160×100 each); each tile shows either the camera feed (live `<video>` with `srcObject = new MediaStream([track])`) or a fallback avatar with the participant's initial. Speaking participants get the green `.speaking-ring`; muted participants get a `mic_off` overlay; the local tile is `muted` so we don't echo. The panel only renders when `connectionState === Connected && activeChannelId`, so an idle lobby sees nothing.
- **`apps/web/app/lobby/LobbyVoiceFooter.tsx`** — camera + screen share buttons are now functional. When on, they get the brand-color fill (camera → primary, screen share → tertiary) so the user can see their state at a glance. Disabled state unchanged (no connection = no toggle).
- **`apps/web/app/lobby/page.tsx`** — `LobbyShell` wraps everything in `<LobbyVoiceProvider>` so both Sidebar (voice channel list + footer) and MainArea (video panel) read from the same context. `MainArea` takes a new `showVideoPanel` prop and renders `<LobbyVideoPanel />` between the channel header and the message list. Provider cleanup resets camera/screen-share state on disconnect.

### Added — User settings completion (M21.6)

- **`apps/web/app/settings/privacy-safety/page.tsx`** — DM permissions (everyone / server_members / friends), friend requests toggle, DM image scanning, explicit content filter, presence visibility (same three tiers), blocked-users entry point, data export button. Pattern mirrors the existing settings pages (`Section` + `Toggle` + radio cards). Backend persistence is intentionally stubbed (Save button disabled with tooltip) until `/api/settings/me` gains a `safety` field.
- **`apps/web/app/settings/accessibility/page.tsx`** — reduced motion (auto / on / off, with `prefers-reduced-motion` detection), high contrast (same tri-state + `prefers-contrast: more` detection), live captions toggle + caption size, keyboard focus sticky toggle, sticky channel/server headers, "disable flashing animations" toggle that targets the speaking ring + presence dots. Includes a WCAG 2.2 AA note linking to the W3C guidelines.
- **`apps/web/app/settings/active-sessions/page.tsx`** — current session + other sessions list (empty today until `/api/settings/me/sessions` lands; we deliberately render an empty state instead of fake data), per-session revoke button, and a "Sign out everywhere" danger zone with a typed `SIGN OUT` confirmation gate. Pattern matches the existing `danger` tone used by `MyAccountBody`.
- **`apps/web/app/SettingsShell.tsx`** — `USER_NAV` gains three entries: Accessibility, Privacy & Safety, Active Sessions. Existing "Privacy & Activity" stays at `/settings`.



### Security hardening

- Made first-run setup irreversible with `bootstrap_version = 2`, a
  PostgreSQL advisory transaction lock, production setup token enforcement,
  and real concurrent-database coverage.
- Added strict setup text validation, sanitized error logging, a global CSP,
  HSTS and browser hardening headers.
- Removed self-host production fallback to lobby demo data on DB failure.
- Updated Drizzle ORM to 0.45.2 and pinned patched PostCSS/esbuild transitive
  dependencies. The audit service reported no known vulnerabilities at that
  milestone; see the current verification snapshot for today's audit status.
- Removed the development-wide admin bypass. Instance administration now
  requires the locked setup owner session or a constant-time emergency token.
- Switched guest IDs to cryptographic randomness, removed raw API error details,
  added mutation body limits and cross-site Fetch Metadata rejection, and made
  test reset tokens mandatory.
- Strictly validates update manifest fields and commands; production remote
  manifests require HTTPS and enforce redirect, timeout, and response-size
  limits.

### Fixed - Lobby voice connection

- Repaired the lobby heartbeat URL: the client now posts `serverId`,
  `channelId`, and status to `/api/presence` instead of POSTing to the
  read-only channel roster endpoint.
- Voice roster labels now prefer the signed LiveKit participant `name`, so the
  local nickname appears immediately after connection.
- Removed an unsupported `Room.getStats()` sampler that failed typecheck and
  could never collect bandwidth in the installed LiveKit client.
- Added deterministic disconnect cleanup and fixed a stray brace in the
  presence route that had been hidden by the stale dev bundle.
- Local Docker LiveKit now advertises `127.0.0.1` as its ICE node address;
  this prevents same-machine clients from receiving unreachable Docker bridge
  or public NAT candidates.

### Fixed - Security audit follow-up

- Derived LiveKit moderation room names server-side from `serverId` +
  `channelId`; the voice mute endpoint now validates operator membership,
  target membership, channel ownership/type and `MUTE_MEMBERS` before touching
  LiveKit.
- Tightened the shared API Origin guard: production mutation requests now
  require a valid first-party Origin even when Fetch Metadata is absent.
- Hardened the WebSocket gateway with production Origin allowlisting, required
  production `REDIS_URL`, and real `@lobbyforge/db.createDb` wiring for
  membership checks.
- Fixed chat/activity Redis subscriber lifetime so one closing listener does
  not tear down other listeners on the same topic.
- Removed raw stdout/stderr chunks from update command execution events;
  bounded output is still returned to the caller, while persisted event
  metadata stores only byte counts/truncation status.
- Fixed the lobby "Community unavailable" regression after user block-list
  support: exported `userBlocks` queries from `@lobbyforge/db`, journaled and
  applied the `0014_user_blocks` migration, and added a source regression test
  for the lobby data export.

### Added - Community settings invites

- `/admin/settings/invites` now has a live create/copy/revoke UI backed by
  the existing invite APIs. Admins can choose max uses and expiry, search,
  filter by status, copy active `/join/{code}` links, and revoke links through
  a confirmation dialog.
- Invite revoke now uses the same `CREATE_INVITE` permission boundary as invite
  creation, instead of the unrelated role-management permission.

### Added — Lobby → voice connect (M21.4a)

- **`apps/web/app/lobby/LobbyVoiceProvider.tsx`** — React context provider that owns a single `livekit-client` `Room`. Exposes `connectToChannel(channelId)` / `disconnect()` / `toggleMic()` plus the render state (`activeChannelId`, `connectionState`, `connecting`, `error`, `micEnabled`, `participants`). Mirrors the M14 `/room/[roomName]` flow: `/api/auth/guest` rebind → `POST /api/livekit/token {serverId, channelId}` → `new Room({adaptiveStream, dynacast}).connect(livekitUrl, jwt)` → publish mic muted-by-default → 5s presence heartbeat. Listens to `ConnectionStateChanged`, `ParticipantConnected/Disconnected`, `ActiveSpeakersChanged`, `TrackMuted/Unmuted`, `LocalTrackPublished/Unpublished` so the sidebar voice roster shows real speaking indicators and mute state. Tears down the room + heartbeat on unmount.
- **`apps/web/app/lobby/LobbyVoiceChannels.tsx`** — Sidebar voice-channel list as a client island. Same visual classes as the M19 `ChannelGroup` (voice group), but each channel row is a button that calls `connectToChannel(c.id)`. When connected, the roster reads from the LiveKit participants (real speaking ring + `mic_off`); when not connected, falls back to the SSR presence snapshot from `data.voiceUsers`. Clicking the active channel disconnects. Shows `connecting…` and `connected` badges inline.
- **`apps/web/app/lobby/LobbyVoiceFooter.tsx`** — Voice control footer wired to real state. The "Voice Connected" / "Voice Ready" label, the call-end button (disconnects), and the mic toggle are all functional. The video camera and screen share buttons render but are disabled with "coming in M21.4b/c" tooltips. The deafen button is disabled (M21.4 follow-up).
- **`apps/web/app/lobby/page.tsx`** — Sidebar now branches on `data.isLive && data.serverId && hasUser`. The live path wraps the channels list + footer in `<LobbyVoiceProvider>`, renders `<LobbyVoiceChannels>` instead of the SSR `ChannelGroup` for the voice group, and renders `<LobbyVoiceFooter>` instead of the legacy `<VoiceControlFooter>`. The demo path (unauthenticated / official deployment) keeps the original SSR-only rendering — no LiveKit bundle is loaded for the demo view. A small `buildKnownNames(data)` helper seeds the participant identity → display name lookup from the SSR snapshot.
- **CSS layout fix** — `/setup` and `/login` had a nested `<main>` inside the layout's outer `<main className="flex-1">`, plus `min-h-dvh` on the inner element that fought the outer flex. Both pages now use `<div className="flex h-full w-full items-center justify-center bg-background px-5 py-10 safe-area-page">`. The HTML semantic violation (nested `<main>`) is fixed too. Tailwind stack is `^3.4.13` (v3, not v4) — confirmed against `apps/web/package.json`. The whole Calm Future token system (`tailwind.config.ts` colors/font/spacing/animation) is v3-idiomatic and does not require a v4 migration.

### Added — Lobby live data (M21.1)

- **`apps/web/app/lobby/page.tsx`** — rewrites the standalone lobby page to fetch real data when the visitor is authenticated and has a server:
  - Sidebar channels come from `listChannelsForServer(db, serverId)`, grouped by `type` into Text Channels / Voice Channels (the `voice` + `stage` types collapse into the voice group).
  - The active voice channel's roster comes from `getUserPresenceInChannel(channelId)` (Redis presence).
  - The right-hand members panel comes from `listMemberSummariesForServer` + `getUserPresenceInServer`; member status is derived (`in-voice` when `channelId` is one of the voice channels, `online` for any other presence, `offline` otherwise) and sorted by status then name.
  - The chat area comes from `listMessagesForChannel(activeTextChannel.id, {limit:50})`; author display names are resolved with a parallel `getUserById` lookup per unique author id and threaded into a `Record<userId, displayName>` map.
  - Demo mode preserved verbatim for unauthenticated visitors and for the official deployment — the original `DEMO_*` constants render the Stitch `refined_standalone_lobby_1280px` reference without any server round-trip.
- **`apps/web/app/lobby/LobbyLiveRoster.tsx`** — client island rendered only when the lobby has live data. Subscribes to `chat:{serverId}:{channelId}` via the existing `RealtimeClient` singleton and prepends new messages into local state (de-duped by message id so the SSR snapshot and the first WS event don't double-render). Polls `/api/servers/{id}/channels/{channelId}/presence` every 8s to keep the author name cache warm. Same visual classes as the SSR Message component — design is 1:1.
- **Empty states**: a server with no channels renders an empty channel list rather than the demo; a server with no messages renders "No messages yet — be the first to say something." in the chat area.

### Added — Calm Future motion tokens (M21.2)

- **`apps/web/tailwind.config.ts`** — five canonical keyframes (`fadeInRight`, `fadeInLeft`, `fadeInUp`, `pulseSoft`, `speakingPulse`) and five matching `animate-*` Tailwind utilities, sourced 1:1 from `design_stitch/lobbyforge_animated_desktop_shell/code.html`. The `speakingPulse` uses the green `#7CCFA6` token (LiveKit video-tile convention); the legacy `.is-speaking` ice-blue avatar pulse from earlier milestones is preserved unchanged.
- **`apps/web/app/globals.css`** — the same five keyframes are mirrored as raw CSS for non-Tailwind consumers, plus six stagger delay utilities (`.stagger-1..6` = `0.1..0.6s`), `.speaking-ring` for video tiles, `.rail-tooltip` for the 72px server rail hover pattern, and a `@media (prefers-reduced-motion: reduce)` override that disables every animation utility + the special classes. The override matches the Stitch accessibility intent verbatim.
- **Applied** to the lobby: Sidebar `animate-fade-in-right`, MembersPanel `animate-fade-in-left`, MainArea `animate-fade-in-up`, channel groups carry `stagger-1` / `stagger-2`, each new WS chat message in `LobbyLiveRoster` enters with `animate-fade-in-up`.

### Added — Missing modal primitives (M21.3)

- **`apps/web/components/modals/ChangeBannerModal.tsx`** — wide-image (3:1, 1200×400 canonical crop) sibling of `ChangeAvatarModal`. Same canonical flow: file pick → live preview with zoom/rotate → canvas crop on save. 8 MB cap. Stitch reference folder (`design_stitch/lobbyforge_change_banner_modal_overlay/`) is empty so the visual treatment follows the existing avatar modal + the lobby sidebar banner area.
- **`apps/web/components/modals/HushleRoomSelectionModal.tsx`** — voice-channel picker shown when a host starts Hushle in a server with more than one voice channel. Pre-selects the channel the host is currently in, filters out channels with an active activity (one-activity-per-channel mutex), and exposes `busy` per channel so the caller can mark "Session in progress" rooms. `HushleHowToPlayModal` pattern + `play_arrow` PrimaryButton.
- **`CreateVoiceRoomModal`** — intentionally skipped. The existing `CreateChannelModal` already handles voice room creation via its `type='voice'` branch (used today by `apps/web/app/lobby/ChannelGroupClient.tsx`). The Stitch `lobbyforge_create_voice_room_modal_state/code.html` is the full lobby shell + overlay state, not a separate modal design.

### Numbers

- `pnpm -F @lobbyforge/web build` green: `/lobby` 6.71 kB, `/admin/bandwidth` 4.01 kB. All 15 workspace projects typecheck clean.
- `pnpm -F @lobbyforge/web test` green: **302/302** across 42 test files (+6 tests, +1 file vs M21.6 — the security-headers test grew to cover Fetch Metadata + request size + production Origin guard).
- `pnpm -F @lobbyforge/web lint` green (0 errors, 63 warnings — all pre-existing `any` / unused-var noise in API routes).
- **Security audit**: 36/36 mutation routes wrapped with `withApiSecurity`. 0 `innerHTML` / `dangerouslySetInnerHTML` / JS `eval()`. CSP: `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, HSTS in prod, `Permissions-Policy: camera=(self), microphone=(self)`. No secret env vars exposed as `NEXT_PUBLIC_*`.

### Key decisions

- **Live data path is opt-in via "user has a server".** The unauthenticated lobby view is the demo — it preserves the original Stitch reference rendering exactly. The moment `listServersForUser` returns a row, the page switches to live data. This keeps the lobby useful both as a marketing surface (official deployment) and as a real community shell (self-host).
- **Chat realtime lives in a single client island; voice/video share one provider.** `LobbyLiveRoster` handles the chat WS subscription. `LobbyVoiceProvider` wraps the entire lobby shell (server rail + sidebar + main + members panel) so the sidebar voice channels, the voice footer, AND the main-area video panel all read from the same LiveKit `Room`. One connection, three consumers.
- **Demo mode is not "fake data hiding real data"** — it's an explicit mode. `data.isLive === false` renders the DEMO_* constants verbatim; `data.isLive === true` renders the client islands. The LiveKit bundle is NOT loaded in demo mode (the provider is only mounted when `canVoiceConnect === true`).
- **Animation tokens are duplicated** in `tailwind.config.ts` (for Tailwind consumers) and `globals.css` (for raw CSS consumers like `.stagger-*` + `.speaking-ring`). The `@keyframes` blocks must stay in sync; a `// keep in sync` comment in both files flags this.
- **Tailwind v3.4.13 stays.** v4's CSS-first config would require rewriting the entire `tailwind.config.ts` (90+ Calm Future tokens), and the @tailwindcss/forms + container-queries plugins are still settling on v4 compatibility. Migration risk > benefit at this point; revisit when the design system is stable.
- **Security hardening is environment-agnostic.** The dev admin bypass was a debugging convenience but it meant `NODE_ENV !== 'production'` was effectively an open backdoor. Now every environment (dev, CI, staging, prod) applies the same admin gate. The new test-reset token rule is unconditional — if you forget to set it in CI, the test reset endpoints refuse instead of letting data get wiped.
- **CSRF protection uses Fetch Metadata headers** (`Sec-Fetch-Site/Mode/Dest`) on top of the existing Origin check. Fetch Metadata is supported in all evergreen browsers since 2020; the Origin check remains the fallback for the few user agents that don't send Fetch Metadata.

### What's next (M21.4c+)

- **M21.4c — Screen share large tile.** The publish side (`localParticipant.setScreenShareEnabled`) works in M21.4b; what's missing is a large pinned tile for screen-share tracks and click-to-focus on a participant. Today every track renders as a 160×100 tile in the strip; a screen share deserves the full main-area width.
- **M21.4d — Fullscreen / participant focus.** Click a tile to enlarge it; pin a speaker.
- **M21.5 — Community settings live wiring.** Most `admin/settings/*` routes already read from DB (audit-logs, channels, invites, members, roles, storage). Remaining: role drag-reorder UI, backups page beyond the placeholder, voice-media + instance-access polish. Stitch `refined_community_settings_*` references cover the visuals.
- **M21.6 — User settings completion.** privacy-safety, accessibility, active-sessions pages — all three have Stitch references and existing route shells, just need content + API wiring.
- **M21.7 — Hushle session view.** Replace the placeholder card visual with the `active_hushle_session_main_lounge` reference. This is M20c from the M20a spec — a pure styling swap, no reducer/schema/API changes.
- **Test pass.** Once M21.5/M21.6/M21.7 land, write E2E tests for: lobby voice connect → speak → mute; camera toggle → tile appears; screen share → tile pinned; settings open + edit + save round-trip. The 296 unit tests cover the API layer; the UI flow needs Playwright/Cypress coverage.

### Reference

- `apps/web/app/lobby/{page.tsx,LobbyLiveRoster.tsx,LobbyVoiceProvider.tsx,LobbyVoiceChannels.tsx,LobbyVoiceFooter.tsx,LobbyVideoPanel.tsx}`
- `apps/web/components/modals/{ChangeBannerModal.tsx,HushleRoomSelectionModal.tsx}`
- `apps/web/tailwind.config.ts` (animation/keyframes block)
- `apps/web/app/globals.css` (motion utility classes + reduced-motion block)
- `apps/web/app/{setup,login}/page.tsx` (nested `<main>` → `<div>` fix)
- `apps/web/lib/{admin-auth,security-headers,password,test-reset-auth,update-planner,api-source-security,lobby-mode,security-config}.ts` (M21.S hardening)
- `apps/web/lib/__tests__/{admin-auth,security-headers,test-reset-auth,security-config,api-source-security,lobby-mode,update-planner}.test.ts` (M21.S test coverage)

## [Unreleased] — M20-bis: WebSocket gateway + chat realtime bus — 2026-06-20

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M20b.1 | `apps/ws-gateway/` workspace | done | standalone Node process, port 3001, `ws` + `ioredis` deps |
| M20b.2 | Wire protocol (`activity-state:*`, `chat:*` topics) | done | zod-validated `subscribe`/`unsubscribe`, `hello`/`subscribed`/`unsubscribed`/`event`/`error` server frames |
| M20b.3 | Per-topic authorization | done | server owner auto-passes; others need `isServerMember(serverId)` |
| M20b.4 | Shared Redis subscriber pool | done | one ioredis connection per topic with refcount; refcount-zero quits the connection |
| M20b.5 | `chat-bus.ts` Redis primitive | done | parallel to `activity-bus.ts`; topic `lf:{env}:chat:{serverId}:{channelId}`; fire-and-forget publish |
| M20b.6 | Messages POST publishes chat envelope | done | `apps/web/app/api/servers/[id]/channels/[channelId]/messages/route.ts` |
| M20b.7 | Browser `RealtimeClient` | done | singleton, auto-reconnect with backoff, queue while disconnected, dispatch to handlers |
| M20b.8 | ActivityPanel switches from `EventSource` to `RealtimeClient` | done | polling fallback only on `CLOSED` |
| M20b.9 | `guest-session` + `cookies` live in `@lobbyforge/core` | done | `apps/web/lib/{guest-session,cookies}.ts` are now shim re-exports |
| M20b.10 | M20-bis tests + docs | done | +43 tests; `pnpm verify` and `pnpm -F @lobbyforge/web build` green |

### Added — WebSocket gateway

- **`apps/ws-gateway/`** — new monorepo member. Standalone Node.js process that wraps the `ws` library, validates the `lf_guest` cookie on upgrade, and brokers subscriptions to the same Redis bus the Next.js app publishes on. Per-topic membership check (server owner or `isServerMember`) is enforced before the Redis subscriber is acquired.
- **`apps/ws-gateway/src/protocol.ts`** — wire protocol. Client sends `{type: 'subscribe'|'unsubscribe', topic}`. Server sends `hello`, `subscribed`, `unsubscribed`, `event`, `error`. Topics are parsed as `(kind, serverId, resourceId)`; unknown topic shapes get `code: 'unknown_topic'`. Rate limit: 30 subscribe requests / 60s / connection.
- **`apps/ws-gateway/src/redis-subscriber.ts`** — shared Redis subscriber pool. One ioredis connection per topic with a refcounted handler set; the connection quits when nobody's left. Mirrors `apps/web/lib/activity-bus.ts`'s pattern, separated into a dedicated module so the gateway process owns its pool (no coupling to the web app's Redis instance lifetime).
- **`apps/ws-gateway/src/auth.ts`** — guest cookie validation against `LOBBYFORGE_SESSION_SECRET` via `@lobbyforge/core`.
- **`apps/ws-gateway/src/authorize.ts`** — per-subscribe membership check against `@lobbyforge/db`.
- **`apps/ws-gateway/src/subscriptions.ts`** — per-connection subscription manager. Idempotent `add` (no double refcount on re-subscribe); `remove` is a no-op for unknown topics.
- **`apps/ws-gateway/src/server.ts`** — `WebSocketServer` orchestration, 30s heartbeat (server-initiated `ping`), graceful close on `SIGTERM`/`SIGINT`.
- **`apps/ws-gateway/src/db.ts`** — DB accessor with a `__setDb(mockDb)` test hook.

### Added — Chat realtime bus

- **`apps/web/lib/chat-bus.ts`** — Redis pub/sub primitive parallel to `activity-bus.ts`. Topic `lf:{env}:chat:{serverId}:{channelId}`. `publishChatMessage(...)` is fire-and-forget. `subscribeChatMessages(...)` returns `{ close }` that releases the per-topic subscriber.
- **`apps/web/app/api/servers/[id]/channels/[channelId]/messages/route.ts`** — POST handler now publishes a chat envelope to `chat-bus` after the row is persisted. Failures are logged, never thrown — the API caller still gets 201.

### Added — Browser realtime client

- **`apps/web/lib/realtime-client.ts`** — `RealtimeClient` class. Opens a singleton WS connection, multiplexes subscriptions to multiple topics. Auto-reconnect with exponential backoff (cap 30s); queues `subscribe`/`unsubscribe` while disconnected and replays them on `open`. Heartbeat timer closes the socket if the server hasn't pinged in 60s. Wire types are inlined (not imported from `@lobbyforge/ws-gateway`) so the browser bundle doesn't pull Node-only deps.

### Updated — ActivityPanel switches from SSE to WS

- **`apps/web/app/room/[roomName]/page.tsx`** — `ActivityPanel` now uses `getRealtimeClient().subscribe('activity-state:{serverId}:{sessionId}', handler)`. The polling fallback only kicks in if `WebSocket.CLOSED` at startup; the `EventSource` code path is gone. Net effect: lower latency on first message, single connection per page load (instead of one SSE per active activity).

### Refactored — `@lobbyforge/core` gains cookie + guest-session helpers

- **`packages/core/src/{cookies,guest-session}.ts`** — the canonical home for these helpers. Apps/web's old `apps/web/lib/{cookies,guest-session}.ts` files become thin shim re-exports (`export { ... } from '@lobbyforge/core'`); no route touched. The ws-gateway imports the same code via `@lobbyforge/core` instead of duplicating HMAC + cookie parsing.

### Key decisions

- **Separate `ws-gateway` process, not a Next.js route.** Next.js App Router doesn't natively support WS upgrades (the Edge runtime supports the new Web Streams API but ioredis doesn't run there). A standalone process sidesteps the question entirely and gives us independent scaling — the gateway can run as N pods behind a load balancer while Next.js stays at M replicas. Same pattern as `apps/desktop` and `apps/registry`.
- **Same Redis bus, two transports.** SSE (M19) and WS (M20-bis) are siblings. SSE stays for hosts behind proxies that strip WS upgrades; WS is the default for new code. The protocol + authorization rules are the same; only the wire encoding differs.
- **Per-topic authorization, not per-connection.** The gateway checks `authorizeTopicSubscribe(...)` on every `subscribe`. A user with multiple memberships can multiplex without opening multiple WS connections; revoking membership on one server only blocks new subscribes for that server (existing subscriptions are torn down on `close`).
- **Wire types duplicated in the browser client.** `@lobbyforge/ws-gateway` exports the protocol, but importing it would pull `ws` + `ioredis` into the Next.js bundle. The types are small and stable; inlining them keeps the build clean. If the protocol grows, extract it to `@lobbyforge/realtime-protocol` (or fold into `@lobbyforge/core`) — but not yet.
- **Subpath-export convention formalized.** This milestone ships the third subpath export (`@lobbyforge/ws-gateway/...` would have been fourth if the client had imported from it). The convention: anything Node-only or host-private goes behind a subpath so the main entry stays client-safe.

### Tests

- `apps/ws-gateway/src/__tests__/protocol.test.ts` — 11 cases covering topic parsing for both kinds, zod validation of `subscribe`/`unsubscribe` payloads, length cap on topic strings.
- `apps/ws-gateway/src/__tests__/subscriptions.test.ts` — 7 cases for the per-connection manager (idempotent `add`, no-op `remove`, `closeAll`, `has`, `topics`).
- `apps/ws-gateway/src/__tests__/auth.test.ts` — 4 cases for cookie validation (signed cookie accepted, no cookie rejected, no-uid rejected, tampered signature rejected).
- `apps/ws-gateway/src/__tests__/authorize.test.ts` — 5 cases for per-topic authorization (owner auto-passes, member passes, non-member rejected, server not found, unknown topic rejected).
- `apps/web/lib/__tests__/chat-bus.test.ts` — 5 cases mirroring the activity-bus pattern (publish topic name, subscriber forwards messages, wrong-channel filter, malformed-message tolerance, `close()` releases).
- `apps/web/lib/__tests__/realtime-client.test.ts` — 11 cases for the browser client (open, subscribe, dispatch, multi-handler, wrong-topic filter, unsubscribe, queue-while-disconnected, replay-after-reconnect, no-reconnect-after-explicit-close, forbidden-error surfacing).

### Numbers

390 tests across 55 test files (was 347/51 in M19, +43 tests, +4 files). All 15 packages typecheck; lint clean; `pnpm -F @lobbyforge/web build` is green (29 routes, 5 static + 24 dynamic — the M20-bis change adds no new HTTP routes; the gateway runs on a separate port).

The M20-bis numbers:
- ws-gateway: 27 new tests across 4 new files
- apps/web: +16 tests across 2 new files
- other packages: unchanged

### What's next (M20+)

- **M20 — Hushle card pack authoring.** `ctx.cards.listForPack(packId)` through the plugin context; `POST /card-packs` community upload; `cardPackInstalls` per-server enablement. The mutex on "one active game per channel" lands here too (per the future-requirements note in `memory/future-marketplace-and-mutex.md`).
- **M20-alt — Installer bootstrap.** Production docker-compose, install.sh, upgrade.sh, backup.sh, doctor.sh.
- **M21+ — Deferred plugins.** `quiz`, `vampire-village`, `watch-party`. Each will reuse the M19 plugin SDK additions and now also has a clean WS path to push realtime updates.
- **M-locale audit.** Drop `locales/{lang}.json` for every plugin/bot that ships UI strings; call `loadPluginLocale`/`loadBotLocale` at module load. Hushle is the first.

## [Unreleased] — M20a: Hushle 2v2 + floater + weighted card draw — 2026-06-20

First slice of M20 (per `memory/m20-spec.md`). Scope: schema + reducer + tests for the Hushle gameplay refinements — **no UI yet** (M20b). The card visual stays a placeholder until the photo lands in M20c.

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M20a.1 | `cards.difficulty` column + index | done | text default 'easy' not null; `idx_cards_pack_difficulty` index |
| M20a.2 | `serverLocalCards` table + CRUD | done | M20b wires the reducer→DB union; this slice ships the schema + helpers |
| M20a.3 | `gameSessions.teamSize` + `difficultyDistribution` | done | nullable; reducer reads defaults from plugin if absent |
| M20a.4 | `0006_hushle_difficulty_and_team_size.sql` migration | done | hand-written (partial unique index for "one open game per channel" can't be expressed in Drizzle table-builder yet) |
| M20a.5 | Reducer: 2v2 team assignment + floater | done | `set-teams` trims teams to `teamSize` AFTER validating the floater isn't already on a team |
| M20a.6 | Reducer: weighted card draw | done | `pickDifficultyTier` + `drawNextCardWeighted`; falls back to any unused card when the configured tier is exhausted |
| M20a.7 | State version bump to 2 | done | `migrateV1ToV2` promotes pre-versioned cards to `difficulty: 'easy'` |
| M20a.8 | Built-in decks with difficulty distribution | done | 14 easy / 7 medium / 3 hard per language (60/30/10) |
| M20a.9 | Per-channel mutex (re-confirmed from M20-bis) | done | already in place; no code change needed |
| M20a.10 | M20a tests + docs | done | +11 tests; full `pnpm vitest run` and `pnpm -r typecheck` green |

### Added — Schema + queries

- **`packages/db/src/schema.ts`** — `cards.difficulty` (text default 'easy' not null). New `serverLocalCards` table (id, serverId, pluginId, category, payload jsonb, difficulty, createdBy, createdAt). `gameSessions.teamSize` (int, nullable) + `gameSessions.difficultyDistribution` (jsonb, nullable). Index `idx_cards_pack_difficulty` for the weighted draw's tier filter. The partial unique index `game_sessions_channel_open_unique` lives in the migration SQL (Drizzle's table-builder doesn't support `.where()` on unique constraints in this version).
- **`packages/db/drizzle/0006_hushle_difficulty_and_team_size.sql`** — `ALTER TABLE cards ADD COLUMN difficulty`, `CREATE TABLE server_local_cards`, `ALTER TABLE game_sessions ADD COLUMN team_size / difficulty_distribution`, `CREATE UNIQUE INDEX ... WHERE status IN ('lobby','running','paused')` for the one-active-game-per-channel rule.
- **`packages/db/src/queries/cardPacks.ts`** — `CardRow` and `BuiltInCardSeed` gain `difficulty`. New `listCardsForPackByDifficulty(packId, tier)` query. `seedBuiltInPack` now returns `backfilledCards: number` and runs `backfillPackDifficulty` for idempotent re-seeds.
- **`packages/db/src/queries/serverLocalCards.ts` (new)** — `listServerLocalCards`, `listServerLocalCardsByDifficulty`, `createServerLocalCard`, `deleteServerLocalCard`.
- **`packages/db/src/queries/gameSessions.ts`** — `GameSessionRow` and `CreateGameSessionInput` gain `teamSize` and `difficultyDistribution`.

### Added — Hushle reducer: 2v2 + floater + weighted draw

- **`plugins/hushle/src/state.ts`** — `HushleDifficulty = 'easy' | 'medium' | 'hard'`. `HushleCard` gains `difficulty`. `HushleSettings` gains `teamSize` (default 2) and `difficultyDistribution` (default `{easy: 0.6, medium: 0.3, hard: 0.1}`). `HushleState` gains `floaterPlayerId`, `currentExplainerIndex`, `usedCardIds`. `HUSHLE_STATE_VERSION` bumped to 2. `migrateV1ToV2` promotes pre-versioned cards to `difficulty: 'easy'` and fills floater/distribution defaults.
- **`plugins/hushle/src/actions.ts`** — three new pure helpers:
  - `pickDifficultyTier(distribution, rng)` — samples a tier by weighted random. Pure so tests can stub `Math.random`.
  - `drawNextCardWeighted(deck, usedCardIds, distribution, rng)` — picks a tier, draws an unused card from that tier's bucket; falls back to any unused card if the configured tier is exhausted (keeps the game running even if the seed doesn't match the configured weights).
  - `pickExplainerForTeam(state, team)` — circular rotation by `state.currentExplainerIndex`; falls back to `state.floaterPlayerId` when the team's `playerIds` is empty.
- **`set-teams`** validates the floater BEFORE trimming teams to `teamSize`. First pass of the reducer trimmed first then validated — that silently dropped a floater who was over team size. The set is now built from the un-trimmed input, validated, then trimmed.
- **`start-game`** accepts `cardsPerTurn`, normalizes the difficulty distribution (clamps negatives, renormalizes to sum=1, falls back to defaults if sum=0).
- **`end-turn`** increments `currentExplainerIndex` before calling `startTurn` so the same player doesn't explain two turns in a row.
- **`hushleNextExplainerForTeam(state, team)`** — exported helper so the host UI (and tests) can ask "who explains next on team X" without re-implementing the rotation.

### Added — Built-in decks with difficulty

- **`plugins/hushle/src/decks.ts`** — every card (en + tr, 24 each) gains a `difficulty` tier. 14 easy / 7 medium / 3 hard per language (60/30/10 of 24). Easy = everyday nouns (apple, coffee, guitar…). Medium = slightly harder to describe without treading a forbidden word (bicycle, rainbow, computer…). Hard = abstract or niche (volcano, pyramid, elephant).

### Tests

- `plugins/hushle/src/__tests__/hushle.test.ts` — 24 cases (was 13, +11):
  - `start-game accepts a custom teamSize and difficultyDistribution` (renormalizes)
  - `start-game falls back to defaults when difficultyDistribution sums to zero`
  - `start-game rejects negative distribution weights (clamps to zero)`
  - `set-teams accepts a floater for odd-player games and validates it is not on a team`
  - `set-teams drops the floater when they are already on a team` (regression test for the trim-before-validate bug)
  - `set-teams trims each team to settings.teamSize`
  - `end-turn rotates to the floater when the next team is empty`
  - `end-turn alternates the floater across teams across multiple turns`
  - `hushleNextExplainerForTeam picks floater when team has no players`
  - `draw respects difficultyDistribution over 100 calls` (with documented fallback when bucket exhausted)
  - `draw never repeats a card within the same session`
  - `migrator upgrades a v1 (no difficulty) state to the current version`
- `packages/db/src/__tests__/schema.test.ts` — 6 assertions on new tables/columns.

### Numbers

401 tests across 56 test files (was 390/55 in M20-bis, +11 tests, +1 file). All 15 packages typecheck. `pnpm -r typecheck` green; `pnpm vitest run` green. No new HTTP routes.

### Key decisions

- **`HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION = {easy: 0.6, medium: 0.3, hard: 0.1}`** matches the user's "kolay/orta/zor" wording (blue/purple/red per `memory/m20-spec.md`). The reducer renormalizes user-supplied weights so a host doesn't have to pre-normalize; if the sum is 0 we fall back to defaults so the game never deadlocks. Negative weights get clamped to 0.
- **`cardsPerTurn` is now an input to `start-game`** (default 15). Tests override with `cardsPerTurn: 100` to drain the deck without turn-ending mid-session. The UI will also expose this in the host settings in M20b.
- **`usedCardIds` is the dedup source of truth**, not `deckIndex`. The new weighted draw picks a card from a tier's bucket and filters out `usedCardIds`. Both reset on `start-game` and `set-teams`.
- **Server-local cards exist on schema + CRUD, but no reducer/UI integration yet.** `listServerLocalCardsByDifficulty` is exported and the reducer doesn't yet call it (the reducer still loads `getDefaultDeck(language)` from `decks.ts`). M20b wires the union: reducer reads `{pack cards} ∪ {server local cards}` filtered by the session's difficulty distribution.
- **Migration is hand-written SQL**, not drizzle-kit generated. The partial unique index `game_sessions_channel_open_unique` can't be expressed in Drizzle's table-builder API in this version, so it lives only in the migration. `meta/_journal.json` got the matching entry.

### What's next (M20b)

- **M20b — API + admin UI + reducer→DB union.** Server-local card CRUD endpoints (`POST/GET/PATCH/DELETE /api/servers/{id}/cards`). Admin panel at `/servers/{id}/apps/hushle/cards`. Reducer reads cards from `{global pack} ∪ {server local}` filtered by the session's difficulty distribution. Locale add-on install endpoint. Per-turn card budget UI. End-of-game chat announcement via `messages.sendGameMessage`. Spectator view differentiation.
- **M20c — Card photo integration.** When the photo arrives, swap the placeholder card component for the final design (purely a `renderClient.tsx` styling swap; no schema / reducer / API changes).
- **M21+ — Deferred plugins.** `quiz`, `vampire-village`, `watch-party` all reuse this reducer pattern.

### Reference

- `apps/ws-gateway/src/{index,server,protocol,auth,authorize,subscriptions,redis-subscriber,db}.ts`
- `apps/ws-gateway/src/__tests__/{protocol,subscriptions,auth,authorize}.test.ts`
- `apps/web/lib/{chat-bus,realtime-client}.ts`
- `apps/web/lib/__tests__/{chat-bus,realtime-client}.test.ts`
- `apps/web/app/api/servers/[id]/channels/[channelId]/messages/route.ts` (publishes on POST)
- `apps/web/app/room/[roomName]/page.tsx` (ActivityPanel on WS)
- `packages/core/src/{cookies,guest-session}.ts` (new canonical home)
- `docs/REALTIME.md` — architecture overview of the realtime layer

## [Unreleased] — M19: Aşama 4 follow-up — realtime + i18n + state versioning — 2026-06-18

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M19.1 | State versioning + migrator on the plugin SDK | done | `GamePlugin.migrateState?` + `RegisteredGamePlugin.migrateState?`; Hushle ships `migrateHushleState` |
| M19.2 | Activity read path runs the migrator | done | the activity read + actions routes apply `plugin.migrateState` to the persisted JSONB |
| M19.3 | Shared `@lobbyforge/plugin-sdk/locale` helper | done | `tFor`, `loadPluginLocale`, `registerPluginLocale`, `listPluginLocales`, `detectLocale`, `pickBestLocale` |
| M19.4 | Shared `@lobbyforge/bot-sdk/locale` helper | done | same surface, bot-keyed registry |
| M19.5 | SSE activity stream route | done | `GET /api/servers/{id}/activities/{sessionId}/stream` — Redis pub/sub, snapshot-on-connect, 30s keep-alive |
| M19.6 | ActivityPanel uses SSE with polling fallback | done | `apps/web/app/room/[roomName]/page.tsx` opens an `EventSource` and falls back to 5s polling if it CLOSEDs |
| M19.7 | Action + end routes publish state changes | done | `publishActivityStateChange` after `setGameSessionState` + after `endGameSession` |
| M19.8 | Hushle uses shared locale helper | done | `loadPluginLocale(HUSHLE_PLUGIN_ID, { en, tr })` + `pickBestLocale` |
| M19.9 | M19 tests + docs | done | +29 tests (10 plugin-sdk locale, 6 bot-sdk locale, 5 SSE stream, 5 Hushle versioning, +3 hushle details); docs + memory updated |

### Added — State versioning

- **`packages/plugin-sdk/src/index.ts`** — `GamePlugin` gains an optional `migrateState?: (raw: unknown) => TState` field. `RegisteredGamePlugin` mirrors it; `registerGamePlugin` wires it through. The host runs it on every read so old sessions in the database upgrade to the plugin's current shape automatically — no ad-hoc migration script.
- **`plugins/hushle/src/state.ts`** — `HushleState` gains `version: number` (`HUSHLE_STATE_VERSION = 1`). `createHushleInitialState` sets it; `migrateHushleState(raw)` is the idempotent migrator that walks a pre-versioned row forward to the current shape. Falls back to `createHushleInitialState()` on garbage.
- **`plugins/hushle/src/index.ts`** — `hushlePlugin` exports `migrateState: (raw) => migrateHushleState(raw)`.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/route.ts`** — reads run `plugin.migrateState(row.state)` before returning the JSON.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/actions/route.ts`** — applies the migrator to `row.state` before passing it to the reducer. Without this step the reducer (which only accepts the current shape) would crash on a row persisted by an older build.

### Added — Shared plugin + bot locale infrastructure

- **`packages/plugin-sdk/src/locale.ts`** — `tFor(pluginId, locale, key, params?, fallback?)`, `loadPluginLocale(pluginId, tables)`, `registerPluginLocale(pluginId, locale, loader)` (loaders merge in registration order, last wins), `listPluginLocales(pluginId)` (preserves insertion order so the first registered is the primary), `detectLocale(fallback)`, `pickBestLocale(pluginId, preferred, fallback?)`. All re-exported from `@lobbyforge/plugin-sdk` and from the dedicated `@lobbyforge/plugin-sdk/locale` subpath.
- **`packages/bot-sdk/src/locale.ts`** — same surface, bot-keyed registry. Re-exported from `@lobbyforge/bot-sdk` and from `@lobbyforge/bot-sdk/locale`.
- **`plugins/hushle/src/renderClient.tsx`** — `loadPluginLocale(HUSHLE_PLUGIN_ID, { en, tr })` runs at module load; the panel uses `pickBestLocale` so `fr` falls back to `en` automatically. Adding a new language to Hushle is now: drop a JSON file in `locales/`, add it to the `loadPluginLocale` map, done — no SDK change, no host change, no migration script.
- **`packages/plugin-sdk/package.json`** + **`packages/bot-sdk/package.json`** — gain `./locale` subpath exports.

### Added — Realtime activity stream

- **`apps/web/lib/activity-bus.ts`** — Redis pub/sub helper. Topic: `lf:{env}:activity-state:{serverId}:{sessionId}`. `publishActivityStateChange({serverId, sessionId, status, state, publicSummary?})` is fire-and-forget (a Redis blip never fails the action route). `subscribeActivityStateChange(...)` opens a per-topic connection, dispatches messages to a callback, and tears down on `close()`.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/stream/route.ts`** — SSE handler. Membership-gated; 30 req/min; sends a `snapshot` event on connect (the current state, after migration), a `hello` event for connect-latency measurement, and forwards every `state` event the bus delivers. 30s `: ping` keep-alive prevents proxy timeouts. The handler can't go through `withApiSecurity` because the response is a streamed `Response` (not a `NextResponse`); instead it calls the same security + rate-limit helpers the wrapper uses — same effect.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/actions/route.ts`** — publishes after `setGameSessionState`.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/end/route.ts`** — publishes after `endGameSession` so the SSE clients see the status flip to `ended`.
- **`apps/web/app/room/[roomName]/page.tsx`** — `ActivityPanel` opens an `EventSource` instead of polling. The `snapshot` event primes the panel without a follow-up GET; subsequent `state` events patch the local state. If the EventSource `CLOSED`s (e.g. a 4xx from the server, a network drop the browser can't auto-recover from) the panel falls back to 5s polling. The 2s polling cadence was the M16 baseline; M19's primary path is push with polling as the recovery lane.

### Updated — Hushle revision

- **`plugins/hushle/src/state.ts`** — `version` field added; `migrateHushleState` is the public migrator; `HUSHLE_STATE_VERSION` is exported.
- **`plugins/hushle/src/plugin-id.ts`** — new file: `HUSHLE_PLUGIN_ID = 'hushle'` constant. Single source of truth for the plugin id so the locale registry, the manifest, and the seeder agree.
- **`plugins/hushle/src/index.ts`** — `manifest.id` and `manifest.version` use the constant + bump to `0.3.0`; `migrateState` is wired; `HUSHLE_PLUGIN_ID` is re-exported.
- **`plugins/hushle/src/builtInPacks.ts`** — re-exports the constant instead of redeclaring.
- **`plugins/hushle/src/renderClient.tsx`** — switches to the shared locale helper; the panel calls `pickBestLocale` instead of a hand-rolled language detector.

### Deferred plugins

- **`plugins/quiz`** — still a stub. Aşama 4 quiz MVP is M20+.
- **`plugins/vampire-village`** — still a stub. Aşama 4 village mechanics are M21+.
- **`plugins/watch-party`** — still a stub. Aşama 4 YouTube/Together sync is M22+.

### Tests

- `packages/plugin-sdk/src/__tests__/locale.test.ts` — 10 vitest cases: register + resolve, fallback locale, missing-key returns the key, `{name}` interpolation, `listPluginLocales` insertion order, multi-loader merge with last-wins, failing loader is silently skipped, region-tag matching (`tr-TR` → `tr`), first-registered preference, `detectLocale` fallback.
- `packages/bot-sdk/src/__tests__/locale.test.ts` — 6 cases mirroring the plugin side; explicitly asserts "adding a new language is a one-line change" by loading `{en}` then `{es}` and reading the list.
- `apps/web/app/api/servers/[id]/activities/[sessionId]/stream/__tests__/stream.test.ts` — 5 cases: 401 (no session), 403 (non-member), 404 (no session), 200 (snapshot + bus subscription), 405 (non-GET).
- `plugins/hushle/src/__tests__/hushle.test.ts` — +5 cases: initial state carries the current version, migrator upgrades a pre-versioned v0 row, migrator is idempotent, migrator falls back to initial state on garbage, registry adapter preserves `migrateState`.

### Numbers

347 tests across 51 test files (was 318/47 in M18, +29 tests, +4 files). All 14 packages typecheck; lint clean; `pnpm -F @lobbyforge/web build` is green (28 routes, 5 static + 23 dynamic); full `pnpm verify` passes.

The new SSE route adds the line:
```
├ ƒ /api/servers/[id]/activities/[sessionId]/stream                       177 B         107 kB
```

### What's next (M20+)

- **DB-backed deck loading in the reducer.** Wire `ctx.cards.listForPack(packId)` through `GamePluginContext` and have `start-game` call it instead of `getDefaultDeck`. M18's DB-backed schema is ready for this.
- **Community pack authoring.** `POST /api/servers/{id}/card-packs` upload flow + `cardPackInstalls` per-server enablement.
- **Aşama 5 Installer bootstrap.** Production docker-compose, install.sh skeleton, upgrade.sh, backup.sh, doctor.sh, setup wizard.
- **Quiz / Vampire Village / Watch-party plugin MVP.** Stubs since M16; each is its own aşama milestone.

### Reference

- `packages/plugin-sdk/src/{index,locale}.ts`
- `packages/bot-sdk/src/{index,locale}.ts`
- `apps/web/lib/activity-bus.ts`
- `apps/web/app/api/servers/[id]/activities/[sessionId]/{route.ts,actions/route.ts,end/route.ts,stream/route.ts}`
- `apps/web/app/room/[roomName]/page.tsx` (ActivityPanel SSE wiring)
- `plugins/hushle/src/{state,index,plugin-id,renderClient}.ts(x)`
- `memory/m19-milestone.md`

## Current Security Hardening

- LiveKit token issuance is now channel-scoped. Clients send `serverId` and
  `channelId`; the server verifies membership, channel ownership, voice/stage
  type, and `CONNECT_VOICE`, then derives the LiveKit room name.
- Presence writes now verify server membership and channel ownership before
  touching Redis.
- Activity start now rejects a second active activity in the same voice/stage
  channel.
- Plugin SDK gained `actorUserId`, `actionPolicies`, and a
  `registerGamePlugin` host adapter; official plugins now declare
  host/member/player action rules and host-overwritten actor fields.
- Plugin manifests now expose catalog metadata for publisher/trust badges,
  player limits, spectator/queue support, overflow behavior, voice
  requirements, and tags.
- Hushle (Aşama 4) is now a fully wired game plugin — server-authoritative
  reducer with `lobby → team_setup → playing → ended` phase machine,
  per-team score + correct/pass/penalty counters, auto-rotating turn
  assignment across teams, 24-card built-in deck in English and Turkish,
  per-plugin locale bundles, and a per-plugin React panel that the voice
  room's `ActivityPanel` calls when an activity for `hushle` is active.
  Every action is host-only via `actionPolicies`; the panel renders
  explainer vs. guesser views, shows the live countdown, and hides the
  card word from the guessers while exposing it to the explainer and host.
- Hushle card decks moved from in-code bundles to a DB-backed `card_packs`
  + `cards` schema. The host seeds the bundled en + tr packs on first
  boot, exposes them through `GET /api/servers/{id}/card-packs`, and
  the Hushle lobby shows a real pack picker (the legacy language
  dropdown is the fallback when packs haven't loaded). The reducer now
  takes `packId` on `start-game` and resolves the language from the
  slug; the M19 follow-up will add a community-pack authoring flow.
- Server apps can now be installed/configured through
  `/api/servers/{id}/apps`; activity start requires an installed+enabled app.
- Server access/auth policy now has schema, query helpers,
  `/api/servers/{id}/access-policy`, and a Server `access` tab.
- Server bot visibility now has `/api/servers/{id}/bots`, a Server `bots`
  tab, and LiveKit participant `BOT` badges from bot metadata/identity.
- User settings now include `/api/settings/me` and `/settings` for privacy and
  activity visibility controls.
- Presence readers now apply user privacy settings before returning public
  snapshots, including hidden online status and activity-kind visibility.
- `pnpm lfctl update check/plan` now reads a release manifest and produces a
  guarded self-host update plan. `apply`/`rollback` stay locked until the
  script runner verifies backup and health checks.
- Admin updates now expose the guarded plan through `/admin/updates` and
  `/api/admin/updates?action=check|plan`; POST execution stays locked.
- Update manifests now expose signature status using detached Ed25519
  verification through `LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM` or CLI
  `--public-key`.
- Update apply now has a backup verification gate contract through
  `lfctl backup verify`, `infra/update/backup-manifest.example.json`, and
  `POST /api/admin/updates` `action=verify-backup`.
- Admin update POST now returns a dry-run/apply/rollback execution preview with
  signature, backup, confirmation, major-upgrade, env, and command-allowlist
  gates. OS command execution remains disabled by default.
- Update history now has a `system_update_runs` schema/query surface and
  `GET /api/admin/updates?action=history` for newest-run inspection.
- Update run logs now have a `system_update_events` schema/query surface and
  `GET /api/admin/updates?action=run&id=<runId>` returns the event timeline.
- Update POST previews now attempt to persist dry-run/apply/rollback attempts
  into `system_update_runs`, returning `historyError` if persistence fails.
- Instance maintenance mode now has schema fields, DB helpers,
  `/api/admin/maintenance`, an admin updates badge, and an apply/rollback
  runner gate.
- Maintenance mode now has a runtime guard: normal API routes return 503,
  normal pages render a maintenance screen, and admin/health/doctor/test
  endpoints remain available.
- Update run history now has a single-run API and `/admin/updates/{runId}`
  detail page showing gates, failures, rollback command, and plan snapshot.
- Update POST responses now include a non-executing worker contract with
  step-level `planned`/`blocked` state. Apply/rollback remain blocked until the
  process executor is implemented.
- Update runner commands now prepare structured, no-shell descriptors with
  hardcoded executable/argv pairs.
- Update command executor now has an explicit `execute` mode using no-shell
  child processes, per-command timeouts, bounded stdout/stderr capture, and
  event callbacks. The admin API still does not enable apply/rollback
  execution.
- Update worker orchestration now runs prepared descriptors sequentially in
  explicit execute mode, stops on first failure/timeout, and stays non-executing
  for locked or dry-run workers.
- Update worker events now have a shared recorder adapter for preview and
  future live execution, forwarding command lifecycle/stdout/stderr events to
  the persistence layer without coupling tests to the database.
- Update execution mode selection now has a central policy gate requiring
  preview gates, planned worker state, worker-executor env enablement, and an
  explicit per-call execution request before `execute` mode can be selected.
- Admin update POST now has gated apply/rollback execution wiring. It creates
  running update runs, streams worker events to `system_update_events`, and
  finishes runs as succeeded/failed/rolled_back only when every safety gate and
  `"execute": true` pass.
- Admin Updates page now includes guarded controls for preview/apply/rollback,
  with explicit confirmation checkboxes, typed `EXECUTE`, maintenance/signature
  client-side gating, policy feedback, and run-detail links.
- Update preview history now records one event per worker step, so dry-run and
  locked apply/rollback runs already produce a useful timeline.
- Doctor/admin health routes are protected in production by
  `LOBBYFORGE_ADMIN_TOKEN`.
- API security wrapper now applies caller-IP-scoped rate limits and an Origin
  guard for state-changing requests.
- Redis presence readers now use `SCAN` instead of blocking `KEYS`.
- User message metadata rejects reserved system/plugin keys.
- Test reset endpoints remain `NODE_ENV=test` only and can require
  `x-lobbyforge-test-token` when `LOBBYFORGE_TEST_RESET_TOKEN` is configured.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — M18: Aşama 4 follow-up — Hushle card packs DB — 2026-06-18

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M18.1 | `card_packs` + `cards` schema migration | done | migration `0005_late_cannonball.sql` |
| M18.2 | `cardPacks` query helpers + seeder | done | `packages/db/src/queries/cardPacks.ts` (8 helpers) |
| M18.3 | Hushle built-in pack loader + seeder | done | `plugins/hushle/src/builtInPacks.ts` + structured `HUSHLE_BUILTIN_PACKS` |
| M18.4 | Hushle reducer accepts `packId` | done | `start-game` now takes `packId: string`; language is derived from the slug |
| M18.5 | `GET /api/servers/{id}/card-packs` | done | membership-gated, 60 req/min, `pluginId` filter |
| M18.6 | Hushle lobby view pack picker | done | pack dropdown (falls back to language form) |
| M18.7 | Built-in pack auto-seeding on first boot | done | `ensureBuiltInContentSeeded` on the first card-packs GET, idempotent + module-cached |
| M18.8 | M18 tests + docs | done | +10 tests (3 hushle + 7 card-packs); docs + memory updated |

### Added — Card packs DB

- **`packages/db/drizzle/0005_late_cannonball.sql`** — creates `card_packs` (id, pluginId, slug, name, language, description, isBuiltIn, createdAt, updatedAt; unique on `(pluginId, slug)`; index on `(pluginId, language)`) and `cards` (id, packId FK, ordinal, payload jsonb, createdAt; unique on `(packId, ordinal)`; index on `(packId, ordinal)`). Cards cascade-delete with their pack.
- **`packages/db/src/schema.ts`** — adds `cardPacks` + `cards` tables alongside the existing game-session tables.
- **`packages/db/src/queries/cardPacks.ts`** — 8 helpers: `listCardPacks(db, pluginId?)`, `listCardPackSummaries(db, pluginId?)` (joins with `cards` for the count), `getCardPackById`, `getCardPackBySlug`, `createCardPack`, `addCardToPack`, `listCardsForPack`, `deleteCardPack`, plus `seedBuiltInPack` and `seedBuiltInPacks` for the seeder. The seeder is idempotent — it skips any pack whose `(pluginId, slug)` already exists, so it can safely run on every cold boot.

### Added — Hushle built-in pack content

- **`plugins/hushle/src/decks.ts`** — refactored to expose `HUSHLE_BUILTIN_PACKS: BuiltInPackSeed[]` (the structured form the seeder reads), plus the legacy `getDefaultDeck(language)` and two new helpers `getDefaultPackSlugForLanguage(language)` + `getLanguageForPackSlug(slug)`. The bundled en + tr decks are unchanged (24 cards each).
- **`plugins/hushle/src/builtInPacks.ts`** — `HUSHLE_PLUGIN_ID = 'hushle'` constant, `seedBuiltinHushlePacks(db)` calls `seedBuiltInPacks` from `@lobbyforge/db` against `HUSHLE_BUILTIN_PACKS`. Re-exported through a subpath `@lobbyforge/hushle/builtInPacks` so the server-only import doesn't pull `postgres` into the client bundle.
- **`plugins/hushle/package.json`** — adds `@lobbyforge/db` as a dep, adds the `./builtInPacks` subpath export.
- **`plugins/hushle/src/index.ts`** — re-exports `HUSHLE_BUILTIN_PACKS`, `getDefaultPackSlugForLanguage`, `getLanguageForPackSlug` from the main entry point (client-safe; no DB import). The seeder is only re-exported via the subpath.

### Updated — Hushle reducer + state

- **`plugins/hushle/src/state.ts`** — `HushleAction.start-game` now takes `packId: string` (required) plus an optional `language: HushleLanguage` (used as a fallback when the packId isn't a known built-in slug). `HushleSettings` gains `packId: string | null` so the panel can show the active pack on the playing view.
- **`plugins/hushle/src/actions.ts`** — `start-game` resolves the language from the packId via `getLanguageForPackSlug`; falls back to the explicit `language` if the slug isn't recognized (M19's DB-backed pack loader will replace this fallback with a real lookup). The deck still comes from `getDefaultDeck` in the M18 MVP — the M19 work will switch to `listCardsForPack(db, pack.id)`.
- **`plugins/hushle/src/renderClient.tsx`** — `HushlePanelClientProps` gains an optional `cardPacks?: HushlePanelCardPack[]`. The `LobbyView` renders a pack dropdown when the host-supplied list is non-empty and falls back to the language form when it isn't. The `EndedView`'s "New game" button forwards the previous session's `packId` to the new game.

### Added — Host wiring

- **`apps/web/app/api/servers/[id]/card-packs/route.ts`** — `GET` lists the installed card packs for the instance, optionally filtered by `?pluginId=`. Membership-gated (owner always passes, others need `isServerMember`). 60 req/min, `Cache-Control: no-store`. Calls `ensureBuiltInContentSeeded` on every request so a fresh install populates the bundled packs on the first call.
- **`apps/web/lib/plugin-content-seeder.ts`** — `ensureBuiltInContentSeeded(db)` module-cached promise that calls `seedBuiltinHushlePacks(db)`. Resets the cached promise on error so the next request retries.
- **`apps/web/app/room/[roomName]/page.tsx`** — `ActivityPanel` now fetches `/api/servers/{id}/card-packs` while the session is in `lobby` phase and forwards the result as `cardPacks` to the plugin's `renderClient`. The fetch is soft-failing — if it errors, the panel falls back to the language form.

### Tests

- `apps/web/app/api/servers/[id]/card-packs/__tests__/card-packs.test.ts` — 7 vitest cases: 401 (no session), 404 (no server), 403 (outsider), 200 (owner sees all packs), 200 (member sees all packs), pluginId filter passthrough, 500 (db error).
- `plugins/hushle/src/__tests__/hushle.test.ts` — +3 vitest cases: language resolved from packId slug, language override when slug is unknown, built-in packs include both en + tr with 24 cards each.
- `packages/db/src/__tests__/schema.test.ts` — +2 assertions: `card_packs.pluginId/slug/language/isBuiltIn` are not null; `cards.packId/ordinal` are not null.

### Numbers

318 tests across 47 test files (was 306/46 in M17, +12 tests, +1 file). All 14 packages typecheck; lint clean; `pnpm -F @lobbyforge/web build` is green; full `pnpm verify` passes.

### What's M19 territory

- **DB-backed deck loading in the reducer.** The reducer still uses the in-code `getDefaultDeck(language)`. M19's `getCardPackBySlug` + `listCardsForPack` + payload-reshape moves the deck into the database.
- **Community pack authoring.** M19 adds a `POST /api/servers/{id}/card-packs` route so trusted users can upload a JSON pack; the `cardPackInstalls` join table (planned for M19.2) gates per-server enablement.
- **Member-side "request skip" affordance.** Listed in `projectdetails/12_HUSHLE_PLUGIN.md` as "İleri"; the reducer stays host-only but the panel adds a member-visible request button.
- **Per-turn card budget enforcement.** The `settings.cardsPerTurn` field already exists in the state and the reducer uses it for the auto-rotate check; the panel still doesn't surface it in the lobby form.
- **Spectator view + end-of-game chat announcement.** Listed in the M17 follow-up section; both are M19/M20 work.

### Reference

- `packages/db/src/queries/cardPacks.ts`, `drizzle/0005_late_cannonball.sql`, `src/schema.ts` (new tables)
- `plugins/hushle/src/{decks,builtInPacks,state,actions,renderClient}.ts(x)`
- `apps/web/app/api/servers/[id]/card-packs/route.ts` + `__tests__/card-packs.test.ts`
- `apps/web/lib/plugin-content-seeder.ts`
- `memory/m18-milestone.md`

## [Unreleased] — M17: Aşama 4 — Hushle MVP — 2026-06-18

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M17.1 | Hushle state model + reducer | done | `plugins/hushle/src/state.ts` + `actions.ts`, 10 action types |
| M17.2 | Built-in card decks | done | 24 en + 24 tr cards in `plugins/hushle/src/decks.ts` |
| M17.3 | Hushle React panel | done | `plugins/hushle/src/renderClient.tsx`, 4 phase views |
| M17.4 | Register Hushle in registry | done | `apps/web/lib/plugin-registry.ts` adds `hushlePlugin` |
| M17.5 | `ActivityPanel` calls `renderClient` | done | Falls back to JSON dump when plugin UI returns `null` |
| M17.6 | Hushle locale files | done | `plugins/hushle/locales/{en,tr}.json`, 32+ keys each |
| M17.7 | Hushle test coverage | done | 4 tests in `__tests__/hushle.test.ts` (full game flow + host gate + rotation + ended preserves scores) |
| M17.8 | Hushle docs + verification | done | `docs/HUSHLE.md`, updated `PLUGIN_SDK.md` + this changelog + `VERIFICATION_REPORT.md` + `memory/m17-milestone.md` |

### Added — Hushle plugin

- **`plugins/hushle/src/state.ts`** — full state model: `HushlePhase` (`'lobby' | 'team_setup' | 'playing' | 'ended'`), `HushleTeam` (id, name, playerIds, score, correctCount, passCount, penaltyCount), `HushleCard` (id, language, word, forbiddenWords), `HushleSettings` (language, turnDurationSeconds, cardsPerTurn), `HushleTimer` (startedAt, durationSeconds, paused), plus the 10-action discriminated union `HushleAction` (`start-game`, `set-teams`, `start-turn`, `set-explainer`, `next-card`, `correct-guess`, `pass`, `penalty`, `end-turn`, `end-game`). `createHushleInitialState()` factory seeds the default 60s turn duration.
- **`plugins/hushle/src/decks.ts`** — 24 English + 24 Turkish MVP card packs (`getDefaultDeck(language)`). Words are everyday-noun so the explainer has room to describe without falling back to a forbidden word. The deck counter is module-local and resets per call so each game gets a stable, monotonically-ordered set of card ids.
- **`plugins/hushle/src/actions.ts`** — pure reducer with helper closures (`drawNextCard`, `findTeam`, `nextTeamIndex`, `startTurn`, `applyCorrectPassPenalty`). `correct-guess` auto-draws the next card and bumps `totalCardsPlayed`; `pass` and `penalty` advance without scoring; `end-turn` rotates `currentTeamId` and `currentExplainerId` to the next team (cycling at end); `end-game` transitions to `ended` regardless of phase. Phase transitions are enforced: `start-game` is the only way into `team_setup`, `start-turn` is the only way into `playing`, and `end-game` is the only way into `ended` (from any non-terminal phase).
- **`plugins/hushle/src/renderClient.tsx`** — full React panel (`HushlePanel`) with four phase views (LobbyView, TeamSetupView, PlayingView, EndedView). Self-contained locale loader (`tFor(key, params)`, `detectLocale()` reads `document.documentElement.lang`) using `locales/{en,tr}.json`; inline-styled dark theme so the panel works without the host's CSS. `useNow(500)` ticks a countdown that re-renders the timer chip. The PlayingView reveals the card word only to the explainer + host; guessers see a "card hidden" placeholder. EndedView sorts teams by score and offers a host-only "new game" button that re-enters team setup.
- **`plugins/hushle/locales/{en,tr}.json`** — 32+ locale keys covering title, tagline, phase labels, lobby prompts (language, turn duration, start), team setup (empty state, add team, start turn / start turn missing), playing (current team, timer, explainer, you-are-explainer, you-are-guesser, scores, word, forbidden words, hide-from-guessers, no-card, correct/pass/penalty/next-card/end-turn/end-game buttons, cards-played), and ended (title, final scores, new game).
- **`plugins/hushle/src/index.ts`** — `hushlePlugin: GamePlugin<HushleState, HushleAction>` with `manifest` (id `hushle`, version `0.2.0`, permissions `MANAGE_GAME_SESSION` / `MANAGE_SCORES` / `SEND_ROOM_MESSAGE` / `MANAGE_TIMER`, locales `['en', 'tr']`, catalog metadata: category `game`, min 4 / max 12 / default 8 players, supports spectators + queue, requires voice room, tags `word-game` / `party` / `voice`), `actionPolicies` for all 10 actions (all `role: 'host'`), and `renderClient` returning the React panel.
- **`plugins/hushle/package.json`** — adds `react: ^18.3.1` + `@types/react: ^18.3.3` as deps (M17 requires the panel). Lint script updated to `src/**/*.{ts,tsx}`.
- **`plugins/hushle/tsconfig.json`** — `module: "ESNext"`, `moduleResolution: "Bundler"`, `jsx: "react-jsx"` so the bundler (Next.js / tsc) resolves the panel's imports without `.js` extensions and can compile JSX.
- **`plugins/hushle/src/__tests__/hushle.test.ts`** — 4 vitest tests via `createTestHarness`: full game flow (lobby → team_setup → playing → score → ended), host-only action enforcement, end-turn rotation across teams, end-game preserves scores and blocks new turns.

### Updated — Web host wiring

- **`apps/web/lib/plugin-registry.ts`** — `PLUGINS` now `[registerGamePlugin(hushlePlugin), registerGamePlugin(quizPlugin)]` so the host advertises Hushle in `/api/plugins` and can dispatch Hushle actions. `apps/web/package.json` adds the `@lobbyforge/hushle: workspace:*` dependency.
- **`apps/web/app/room/[roomName]/page.tsx`** — `ActivityPanel` now resolves the session's plugin through `getPlugin` and calls `pluginClient.renderClient({state, dispatch, actorUserId, hostUserId, players})` when the plugin ships a UI. If the plugin returns `null` (or the registry can't find the plugin) the panel falls back to the existing JSON dump. `ActivityDetail` includes `players[].name` (display name) for the Hushle panel to use in the team/explainer labels.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/route.ts`** — the activity read route joins the activity players with the `users` table so the `name` field is available to the Hushle panel (the route uses `inArray(users.id, playerUserIds)` for the join).

### Audit log

Hushle events flow through the existing `activity.action` audit hook with `metadata.actionType` carrying the reducer's action type (`start-game`, `set-teams`, `correct-guess`, etc.). No new audit verbs were needed — the host already records every dispatch.

### What Aşama 4 doesn't ship yet

- **Custom card packs.** MVP uses the bundled 24-card en/tr decks; custom / community packs are listed as "İleri" in `projectdetails/12_HUSHLE_PLUGIN.md` and land in a follow-up milestone.
- **Per-plugin settings panel.** The host reads `plugins_enabled` + global install settings; per-channel/per-plugin configuration screens are still future work.
- **Real-time updates.** The activity panel still polls every 2s; SSE / WebSocket follow-ups remain on the roadmap.
- **AI explainer helpers / spectator chat.** Not in M17 scope.

### Reference

- `plugins/hushle/src/state.ts`, `actions.ts`, `decks.ts`, `renderClient.tsx`, `index.ts`, `__tests__/hushle.test.ts`
- `plugins/hushle/locales/{en,tr}.json`
- `apps/web/lib/plugin-registry.ts` (PLUGINS array now includes `hushlePlugin`)
- `apps/web/app/room/[roomName]/page.tsx` (`ActivityPanel` calls `pluginClient.renderClient`)
- `docs/HUSHLE.md` (plugin user + developer guide)
- `docs/PLUGIN_SDK.md` (per-plugin `renderClient` contract section)
- `memory/m17-milestone.md`

## [Unreleased] — M16: Aşama 3 — Plugin SDK minimal — 2026-06-11

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M16.1 | `gameSessions` query helpers | done | `packages/db/src/queries/gameSessions.ts` |
| M16.2 | Plugin registry | done | `apps/web/lib/plugin-registry.ts` (PLUGINS array, getPlugin, listPluginSummaries) |
| M16.3 | `GET /api/plugins` listing | done | 30 lines, 60 req/min |
| M16.4 | Activity start + list route | done | `POST/GET /api/servers/{id}/channels/{channelId}/activities` |
| M16.5 | Activity read route | done | `GET /api/servers/{id]/activities/{sessionId}` |
| M16.6 | Activity dispatch route | done | `POST /api/servers/{id]/activities/{sessionId]/actions` |
| M16.7 | Activity end route | done | `POST /api/servers/{id]/activities/{sessionId]/end` |
| M16.8 | Voice room `ActivityPicker` + `ActivityPanel` | done | 2s polling of session state |
| M16.9 | Activity route tests | done | 20 tests in `activities.test.ts` |
| M16.10 | `docs/PLUGIN_SDK.md` + `docs/ACTIVITIES.md` | done | Plugin SDK contract + activity host surface |

### Added — Activities

- **`packages/db/src/queries/gameSessions.ts`** — `createGameSession` (with `status: 'lobby'`), `getGameSessionById` (filters out `status = 'ended'` + `endedAt IS NOT NULL`), `listGameSessionsForChannel` (newest first, 50 cap), `setGameSessionState` (patches `state` + optional `publicSummary`), `endGameSession`, `addPlayerToSession` / `removePlayerFromSession` / `listPlayersForSession` (manage the `game_session_players` table). Re-exported from the `@lobbyforge/db` barrel.
- **`apps/web/lib/plugin-registry.ts`** — `PLUGINS: readonly RegisteredGamePlugin[]` (currently `[registerGamePlugin(quizPlugin)]`), `getPlugin(id)`, `listPluginSummaries()`. The M16 success criterion ("dummy plugin activity olarak açılıyor") is satisfied by the existing `@lobbyforge/quiz` plugin — no new plugin code was needed.
- **`apps/web/lib/plugin-context.ts`** — `buildHttpPluginContext` adapts the SDK's `GamePluginContext` for the HTTP host. `players.list` / `get` use a sync snapshot taken at the start of the call (the SDK's `PlayersSubContext` is sync). The other sub-contexts (state, cache, pubsub, timer, votes, scores, voice, messages) are no-op stubs — the host persists state itself via `setGameSessionState`.
- **`apps/web/app/api/plugins/route.ts`** — `GET` returns the slim plugin summaries. 60 req/min, no auth.
- **`apps/web/app/api/servers/[id]/apps/route.ts`** — `GET` joins the compiled-in catalog with server-local installs; `POST` upserts enabled/settings; `DELETE` uninstalls. Mutations require `MANAGE_SERVER`.
- **`apps/web/app/api/servers/[id]/access-policy/route.ts`** — `GET` returns effective defaults for members; `PATCH` stores join/external-identity/local-account/account-linking policy and requires `MANAGE_SERVER`.
- **`apps/web/app/api/servers/[id]/bots/route.ts`** — `GET` lists server bots for members. The Server `bots` tab renders `BOT`, trust, enabled/disabled, token-configured, and permission metadata; the voice-room participant list also badges LiveKit bot participants.
- **`apps/web/app/api/settings/me/route.ts`** — `GET/PATCH` for the current user's privacy/activity settings. `/settings` provides profile, online status, activity status, game/music/watch-party, and server-name visibility controls.
- **`apps/web/app/api/servers/[id]/channels/[channelId]/activities/route.ts`** — `POST` (start, requires `START_ACTIVITY`, 10 req/min) + `GET` (list active, membership-gated, 60 req/min).
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/route.ts`** — `GET` (read full state + players, membership-gated, 60 req/min). 404 if the session is ended, missing, or belongs to a different server than the URL.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/actions/route.ts`** — `POST` (dispatch an action, membership-gated, 30 req/min). Loads the session, resolves the plugin via `getPlugin`, calls `handleAction`, persists the new state. 409 if the session is for a plugin the registry no longer ships.
- **`apps/web/app/api/servers/[id]/activities/[sessionId]/end/route.ts`** — `POST` (end, host or `START_ACTIVITY` holder, 10 req/min). Audit `activity.end` includes `wasHost: boolean`.

### Added — Voice Room UI

- **`apps/web/app/room/[roomName]/page.tsx`** — extends the M14 voice room with:
  - An `ActivityPicker` (between the mute / deafen buttons) — a `<select>` populated by `GET /api/plugins` + a "Start activity" button. Hidden when the URL doesn't carry `serverId` + `channelId`, or when an activity is already active.
  - An `ActivityPanel` (after the participants list) — polls the session read route every 2s, renders the plugin name + status + player count + state JSON dump, and exposes a free-form "send action" input + an "End" button. 404 from the poll triggers `onEnd` (handles the "ended from another tab" case).

### Added — Tests

- `app/api/servers/[id]/channels/[channelId]/activities/__tests__/activities.test.ts` (20 tests, 5 describe blocks: start, list, read, dispatch, end). Mocks `@lobbyforge/db` + `@/lib/plugin-registry` + a fake plugin with a `count` reducer.

### Updated — Workspace

- `apps/web/package.json` adds `@lobbyforge/plugin-sdk` and `@lobbyforge/quiz` to `dependencies` so the registry can import them at runtime.

### Audit log

Activity events land in `audit_logs` with these `action` strings: `activity.create`, `activity.action` (with `metadata.actionType`), `activity.end` (with `metadata.wasHost`).

## [Unreleased] — M15: Moderation & Polish — 2026-06-11

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M15.1 | Audit Log DB + Helper | done | `queries/auditLogs.ts` + `audit_logs` table |
| M15.2 | Audit Log API | done | `GET /api/servers/{id}/audit-logs` |
| M15.3 | Bans DB + Helper | done | `queries/bans.ts` + `server_bans` table |
| M15.4 | Bans API | done | `GET` list + `POST` create + `DELETE` remove |
| M15.5 | Multi-role per member | done | `membership_roles` table, `setMemberRoles` helper, and updated `role` API |
| M15.6 | Reordering (move-and-shift) | done | `updateRole` and `updateChannel` now shift siblings atomically |
| M15.7 | Server-side mute | done | `POST /api/servers/{id}/channels/{channelId}/members/{userId}/voice/mute` via LiveKit SDK |

### Added — Moderation & Polish

- **`packages/db/src/queries/auditLogs.ts`** — `logAction` (async insert) + `listAuditLogsForServer` (joins users, sorts newest first). Logs capture `actorUserId`, `action` string, `targetId`, and a `metadata` blob.
- **`apps/web/app/api/servers/[id]/audit-logs/route.ts`** — `GET` (list, 60 req/min, requires `VIEW_AUDIT_LOG`).
- **`packages/db/src/queries/bans.ts`** — `createBan`, `listBansForServer`, `removeBan`. `createBan` performs a `removeMember` in the same transaction so a banned user is immediately kicked.
- **`apps/web/app/api/servers/[id]/bans/route.ts`** — `GET` (list) + `POST` (create, requires `BAN_MEMBERS`).
- **`apps/web/app/api/servers/[id]/bans/[userId]/route.ts`** — `DELETE` (unban, requires `BAN_MEMBERS`).
- **Multi-role Support** — `memberships.roleId` remains as the "primary" role, but `membership_roles` table now allows a user to hold many roles. `getUserPermissions` computes the union. `PUT /members/{userId}/role` now accepts `roleIds: string[]`.
- **Atomic Position Shifting** — `updateRole` and `updateChannel` now detect `position` changes and shift sibling rows in a single transaction (`sql`-driven range updates). Moving a role to a new slot reorders the list without leaving gaps or creating duplicates.
- **Server-side Voice Mute** — `apps/web/lib/livekit.ts` now exports `getRoomServiceClient()`. A new route `POST /api/servers/{id}/channels/{channelId}/members/{userId}/voice/mute` uses `RoomServiceClient.mutePublishedTrack` to force a participant's microphone off. Requires `MUTE_MEMBERS`.

### Updated — LiveKit Identity

- `apps/web/app/api/livekit/token/route.ts` now uses `session.uid` (the permanent `userId`) as the primary LiveKit identity, falling back to `session.gid` only for pre-materialized guests. This allows moderators to target users for muting/kicking using their stable `userId`.

### Added — Tests

- `app/api/servers/[id]/audit-logs/__tests__/audit-logs.test.ts` (7 tests)
- `app/api/servers/[id]/bans/__tests__/bans.test.ts` (13 tests)
- `app/api/servers/[id]/channels/[channelId]/members/[userId]/voice/mute/__tests__/mute.test.ts` (3 tests)
- Updated `members.test.ts` to reflect the multi-role `PUT` body change.

## [Unreleased] — M14: Phase 2 community MVP (first half) — 2026-06-10

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |
| M8 | Next.js 15 web app + Doctor subsystem | done | `apps/web` is a real App Router project; Doctor lives in `@lobbyforge/core` |
| M9 | Guest auth + LiveKit token endpoint | done | HMAC-signed `lf_guest` cookie + `/api/auth/guest` + `/api/livekit/token`; delivers the Phase 1 "two-browser voice test" success criterion (server-side) |
| M10 | Servers API + DB wiring | done | The first Phase 2 surface — `users` rows are materialized from the guest cookie, and `/api/servers` is wired to a real Drizzle/Postgres backend |
| M11 | Channels API + membership check | done | The second Phase 2 surface — five endpoints (`GET`/`POST` list+create, `GET`/`PATCH`/`DELETE` single), membership-based auth, and a position-aware channel ordering |
| M12 | Messages API | done | The third Phase 2 surface — five endpoints (list/create/get/patch/delete), author-or-owner mutation rule, soft-delete, and a `replyToId` self-FK for in-channel replies |
| M13 | Roles & Permissions | done | The fourth Phase 2 surface — replaces M10 + M11's "owner-only" rules with a real `MANAGE_CHANNELS` / `MANAGE_MESSAGES` / `MANAGE_ROLES` permission check; adds 5 role-management + 3 membership-list endpoints; auto-seeds `@everyone` + `@admin` on every new server |
| M14 | Phase 2 community MVP (first half) | done | Invites (create / list / revoke / metadata / redeem with transactional `SELECT FOR UPDATE` + `@everyone` auto-assignment), the `livekit-client`-backed voice room UI at `/room/[roomName]`, the public `GET /api/invites/{code}` + `POST /redeem` flow, the `/join/[code]` landing page, channel-scoped presence via Redis 90s TTL, M13 test coverage gap closed (15 roles + 13 members tests added) |

### Added — `@lobbyforge/db` invites

- **`queries/invites.ts`** — `createInvite`, `getInviteById`, `getInviteByCode`, `listInvitesForServer`, `getInviteMetadata` (public projection, no PII), `revokeInvite`, `redeemInvite`. Codes are 12 chars of the Crockford base32 alphabet (`23456789ABCDEFGHJKMNPQRSTVWXYZ`), 27^12 ≈ 1.5e17 — no central authority needed. `redeemInvite` opens a transaction, `SELECT ... FOR UPDATE` the invite row, checks `expiresAt` / `currentUses < maxUses`, increments `currentUses`, inserts a `memberships` row with `roleId = @everyone.id`, and returns a discriminated union (`{ ok: true, membershipId, serverId, roleId }` or one of `not_found` / `expired` / `exhausted` / `already_member` / `no_everyone_role`).
- **`src/index.ts`** — re-exports `./queries/invites.js`. The package surface is now `queries/{users,servers,memberships,channels,messages,roles,invites}.ts`.

### Added — `apps/web` Invites API

- **`app/api/servers/[id]/invites/route.ts`** — `GET` (list, 60 req/min, members can read) + `POST` (create, 10 req/min, requires `CorePermission.CREATE_INVITE`). Body is `{ maxUses?: 1..1000, expiresAt?: ISO8601 }`. The POST returns the full row including the code; the owner decoration on GET is via the `server.ownerUserId === session.uid` shortcut.
- **`app/api/servers/[id]/invites/[inviteId]/route.ts`** — `DELETE` (revoke, 10 req/min, requires `MANAGE_ROLES`). Validates the invite belongs to the URL's server before the `revokeInvite` call so a malicious caller can't cross-invoke.
- **`app/api/invites/[code]/route.ts`** — `GET` (public metadata, 60 req/min, no auth required). Returns `{ code, serverId, serverName, expiresAt, currentUses, maxUses, isExpired, isExhausted }` — no PII, just what the join page needs to render "you're about to join <ServerName>". `Cache-Control: no-store` because `currentUses` changes on every redeem.
- **`app/api/invites/[code]/redeem/route.ts`** — `POST` (30 req/min, requires session with `uid`). Maps `redeemInvite` errors to status codes (`not_found` → 404, `already_member` → 409, `expired` / `exhausted` → 410). Returns `{ membership: { serverId, userId, roleId } }` on success.

### Added — `/join/[code]` landing page

- **`app/join/[code]/page.tsx`** — client component. On mount: fetches `GET /api/invites/{code}` to show the server name + invite state (expired / exhausted / 404). Two-step: "Sign in as guest" (POST `/api/auth/guest`, idempotent re-bind for returning visitors) → "Accept invite" (POST `/redeem`). The success state shows a "you're a member now" toast + a placeholder link to `/servers/{serverId}` (the real server-home page is M15 UI).

### Added — Presence productionization

- **`lib/redis.ts`** — adds `getUserPresenceInChannel(channelId)` mirroring the existing server-scoped reader. Both functions `SCAN` for `lf:<env>:presence:{server,channel}:<id>:*` keys and `MGET` the values back; they ignore dead keys (TTL expired between scan and mget).
- **`app/api/presence/route.ts`** — adds a `GET ?serverId=…` handler (60 req/min, requires membership) that returns the live presence list. The `POST` body is unchanged. The server existence + ownership / membership check is the same shape as every other server-scoped read.
- **`app/api/servers/[id]/channels/[channelId]/presence/route.ts`** — new. `GET` (60 req/min, requires membership) returns the channel-scoped presence list. The voice-room UI polls this every 5 s.

### Added — Voice room UI

- **`apps/web/package.json`** — adds `livekit-client@^2.5.7` to `dependencies`. The vanilla SDK (no `@livekit/components-react`) keeps the dep surface small; we don't need pre-built React shells — the page renders the participant list itself.
- **`app/room/[roomName]/page.tsx`** — client component. On mount: rebinds / mints a guest session → `POST /api/livekit/token` with `{ serverId, channelId }` → `new Room({ adaptiveStream: true, dynacast: true }).connect(NEXT_PUBLIC_LIVEKIT_URL, token)`. Renders the room name, connection state, local + remote participant list, mic toggle (`localParticipant.setMicrophoneEnabled`), and a "deafen" button that mutes incoming remote tracks via `track.mute()` / `track.unmute()` (UI-only — server-side mute is M15). The 5-second heartbeat posts to `/api/servers/{serverId}/channels/{channelId}/presence` when the URL carries `?serverId=…&channelId=…`.
- **`app/connect/page.tsx`** — heading relabeled "Connect (developer surface)" so the dev tools page doesn't get confused with the real `/room/[roomName]` UI. No behavior change.
- **`infra/docker/.env.example`** — documents `NEXT_PUBLIC_LIVEKIT_URL` (browser-visible; default `ws://localhost:7880`).

### Added — Tests

- **`apps/web/app/api/servers/[id]/roles/__tests__/roles.test.ts`** — 15 new tests in four `describe` blocks (list, create, patch, delete) following the `channels.test.ts` pattern. Mocks `@lobbyforge/db` (5 new role + the M13 helpers) and `@/lib/security-headers` (pass-through). The cookie is a real signed `lf_guest`. Coverage:
  - `GET /roles` — empty list, populated list, non-member → 403
  - `POST /roles` — owner creates, non-owner without `MANAGE_ROLES` → 403, unknown permission string → 400, name missing → 400
  - `PATCH /roles/{id}` — owner renames, non-owner without `MANAGE_ROLES` → 403, rename `@everyone` → 400
  - `DELETE /roles/{id}` — owner deletes, non-owner without `MANAGE_ROLES` → 403, delete `@everyone` → 400, role not found → 404
- **`apps/web/app/api/servers/[id]/members/__tests__/members.test.ts`** — 13 new tests in three `describe` blocks (list, kick, assign-role). Coverage:
  - `GET /members` — list with owner decoration (the `isOwner: true` + `administrator` injection), non-member → 403
  - `DELETE /members/{userId}` — owner kicks, non-owner without `KICK_MEMBERS` → 403, self-leave (no permission required — `getUserPermissions` is never even called), owner cannot be kicked → 400
  - `PUT /members/{userId}/role` — owner assigns, non-owner without `MANAGE_ROLES` → 403, role belongs to different server → 404, `null` clears without a `getRoleById` call

### Cross-Platform

- The invite codes are generated with `crypto.randomBytes()` and the canonical
  alphabet `23456789ABCDEFGHJKMNPQRSTVWXYZ`, so the choice of alphabet is
  uniform across OSes. Public invite metadata/redeem routes reject anything
  outside the exact 12-character canonical form. The `for await (const key of
  redis.scanStream(...))` pattern in the new presence readers works the same on
  Windows and Linux. LiveKit's `Room.connect` is a WebSocket; the browser's
  `WebSocket` is OS-agnostic.

### Documentation

- **`docs/INVITES.md`** — new. The invite lifecycle, the code format, all four endpoints, the redeem idempotency contract, the `@everyone` auto-assignment, the join-page flow, the relationship to the M13 `CREATE_INVITE` permission.
- **`docs/PRESENCE.md`** — new. The Redis key shape, the 90 s TTL contract, the GET routes (server + channel), the heartbeat contract the voice-room UI honors, the on-disk-TTL-vs-heartbeat-interval budget.
- **`docs/VOICE_ROOM.md`** — new. The `/room/[roomName]` page, the `livekit-client` choice (no `@livekit/components-react`), the connect flow, the self-mute vs server-mute split, the out-of-scope list (server-side mute, M15).
- **`docs/CHANGELOG.md`** — this section.
- **`docs/VERIFICATION_REPORT.md`** — refreshed to 136 tests across 12 test files (the M14 + M13 test-coverage build output is the new baseline) and ~24 routes.
- **`docs/WEB_APP.md`** — reflects the M14 surface (5 new routes + 1 new query file + 2 new lib functions + 2 new pages).
- **`memory/m14-milestone.md`** — new. Captures the auth model and the M15 scope (server-mute, bans, audit log, role reordering, multi-role).

### Out of Scope (intentionally deferred)

- **Server-side mute / deafen.** Self-mute is in; the moderator-mutes-a-noisy-participant path needs `livekit-server-sdk` and a `RoomServiceClient.muteParticipant` call. M15.
- **Bans.** The `server_bans` table is in the M3 schema. `BAN_MEMBERS` is seeded on `@admin`. No route writes to it. M15.
- **Audit log.** The `audit_logs` table is in the M3 schema. The M13 + M14 mutations (role create / update / delete, member kick, role assignment, invite create / revoke / redeem) should each land a row. M15.
- **Role reordering UI.** `PATCH /roles/{id}` accepts a new `position` but doesn't renumber siblings (same shape as the M11 channel reordering). The "move-and-shift" helper is M15.
- **Multiple roles per member.** The `memberships.roleId` column is a single FK, not a join table. A user is in exactly one role per server today. The "many roles" expansion is M15.
- **The `/servers/{id}` page.** Server home (channel list + member list + invite creator + role manager) is the M15 UI deliverable. The `/join/{code}` page currently links to it but it returns 404.
- **Productionized migrations.** `pnpm -F @lobbyforge/db db:push` is the runtime shape today; the `drizzle-kit generate` + `drizzle-kit migrate` switch is M15.
- **Real-time delivery.** Presence is polled at 5s. The real-time layer (WebSocket / SSE / LiveKit data channels) is M17.
- **Invite UI server-side.** The list / create / revoke UIs (the buttons the server owner sees on `/servers/{id}`) are M15 with the server-home page.

---

## [Unreleased] — M13: Roles & Permissions — 2026-06-10

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |
| M8 | Next.js 15 web app + Doctor subsystem | done | `apps/web` is a real App Router project; Doctor lives in `@lobbyforge/core` |
| M9 | Guest auth + LiveKit token endpoint | done | HMAC-signed `lf_guest` cookie + `/api/auth/guest` + `/api/livekit/token`; delivers the Phase 1 "two-browser voice test" success criterion (server-side) |
| M10 | Servers API + DB wiring | done | The first Phase 2 surface — `users` rows are materialized from the guest cookie, and `/api/servers` is wired to a real Drizzle/Postgres backend |
| M11 | Channels API + membership check | done | The second Phase 2 surface — five endpoints (`GET`/`POST` list+create, `GET`/`PATCH`/`DELETE` single), membership-based auth, and a position-aware channel ordering |
| M12 | Messages API | done | The third Phase 2 surface — five endpoints (list/create/get/patch/delete), author-or-owner mutation rule, soft-delete, and a `replyToId` self-FK for in-channel replies |
| M13 | Roles & Permissions | done | The fourth Phase 2 surface — replaces M10 + M11's "owner-only" rules with a real `MANAGE_CHANNELS` / `MANAGE_MESSAGES` / `MANAGE_ROLES` permission check; adds 5 role-management + 3 membership-list endpoints; auto-seeds `@everyone` + `@admin` on every new server |

### Added — `@lobbyforge/core`

- **`permissions.ts`** — the 14 `CorePermission` constants (`ADMINISTRATOR`, `MANAGE_SERVER`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `KICK_MEMBERS`, `BAN_MEMBERS`, `CREATE_INVITE`, `SEND_MESSAGES`, `MANAGE_MESSAGES`, `ADD_REACTIONS`, `CONNECT_VOICE`, `SPEAK`, `MUTE_MEMBERS`, `DEAFEN_MEMBERS`, `START_ACTIVITY`) plus `hasPermission(perms, required)` — the single authorization primitive. `hasPermission` short-circuits to `true` when `ADMINISTRATOR` is in the array, so the M10 + M11 + M12 "owner override" survives as a data fact (the owner has `ADMINISTRATOR` via the seed) instead of a code fact.

### Added — `@lobbyforge/db`

- **`queries/roles.ts`** — `seedDefaultRoles(db, serverId, ownerUserId)` (idempotent — creates `@everyone` + `@admin` and assigns `@admin` to the owner), `createRole`, `listRolesForServer`, `getRoleById`, `updateRole`, `deleteRole` (best-effort clears `memberships.roleId`), `getUserPermissions(db, userId, serverId)` (the owner shortcut returns `[ADMINISTRATOR]` without joining), `listMembersForServer`. `DEFAULT_EVERYONE_PERMISSIONS` and `DEFAULT_ADMIN_PERMISSIONS` arrays are the seed data.
- **`queries/memberships.ts`** (additions) — `assignRole(db, serverId, userId, roleId | null)` (validates membership, accepts `null` as a clear) and `removeMember(db, serverId, userId)` (used by the kick endpoint; bans are a different code path).
- **`queries/servers.ts`** (M13 update) — `createServer` now calls `seedDefaultRoles(db, server.id, input.ownerUserId)` after inserting the owner membership. The function signature is unchanged.
- **`src/index.ts`** — re-exports `./queries/roles.js`. The package surface is now `queries/{users,servers,memberships,channels,messages,roles}.ts`.

### Added — `apps/web` permission helper

- **`lib/permissions.ts`** — `authorizeServerPermission(userId, serverId, required)` wraps `getUserPermissions` and returns a `{ ok: true, permissions }` or `{ ok: false, response: 403 }` discriminated union. Every mutation route leans on it; the standard `403 Forbidden` response shape stays uniform.

### Added — `apps/web` Roles API

- **`app/api/servers/[id]/roles/route.ts`** — `GET` (list, 60 req/min, members can read) + `POST` (create, 10 req/min, requires `MANAGE_ROLES`). The body is `{ name, color?, position?, permissions }`; unknown permission strings are dropped from the array (with the rest accepted) and the seed permissions are normalized to the canonical `CorePermission` set.
- **`app/api/servers/[id]/roles/[roleId]/route.ts`** — `GET` (60 req/min, members can read) + `PATCH` (30 req/min, requires `MANAGE_ROLES`, partial update) + `DELETE` (10 req/min, requires `MANAGE_ROLES`). Renaming or deleting `@everyone` is rejected with 400 — it's structural, not a real role.

### Added — `apps/web` Membership API

- **`app/api/servers/[id]/members/route.ts`** — `GET` (60 req/min) lists the server's members with their role, permissions, and an `isOwner` flag. The owner is decorated with `isOwner: true` + `ADMINISTRATOR` injected, so the UI can render the badge without a second lookup.
- **`app/api/servers/[id]/members/[userId]/route.ts`** — `DELETE` (20 req/min) kicks a member. Requires `KICK_MEMBERS`, except for self-leave — the caller can always leave a server they're a member of, no permission required. The owner cannot be kicked (use server transfer or `softDeleteServer`).
- **`app/api/servers/[id]/members/[userId]/role/route.ts`** — `PUT` (20 req/min, requires `MANAGE_ROLES`) assigns or clears the member's role. The role must belong to the same server; `roleId: null` is a valid clear.

All eight sit behind `withApiSecurity(...)` (now generic over `TContext` for the `[roleId]` and `[userId]` segments).

### Updated — M11 + M12 routes get real permission checks

The M11 + M12 mutation routes are retrofitted with `authorizeServerPermission` calls. The "owner-only" / "author OR owner" rules are now data-driven (the owner's `getUserPermissions` returns `[administrator]`, which `hasPermission` accepts for any required permission).

| Route | Old rule (M11 / M12) | New rule (M13) |
|---|---|---|
| `POST /api/servers/{id}/channels` | Any member | `MANAGE_CHANNELS` |
| `PATCH /api/servers/{id}/channels/{channelId}` | Owner only | `MANAGE_CHANNELS` |
| `DELETE /api/servers/{id}/channels/{channelId}` | Owner only | `MANAGE_CHANNELS` |
| `POST /api/servers/{id}/channels/{channelId}/messages` | Any member (placeholder) | `SEND_MESSAGES` |
| `PATCH /api/servers/{id}/channels/{channelId}/messages/{messageId}` | Author OR owner | Author OR `MANAGE_MESSAGES` |
| `DELETE /api/servers/{id}/channels/{channelId}/messages/{messageId}` | Author OR owner | Author OR `MANAGE_MESSAGES` |

The `hasPermission` placeholder in M11's `POST /channels` is replaced with the real check; M12's "author OR owner" becomes "author OR `MANAGE_MESSAGES`" (the owner still passes because of the seed). A freshly created server is still able to create + edit channels and messages; the gates are the only thing that changes.

### Added — Tests

- **`apps/web/app/api/servers/[id]/channels/__tests__/channels.test.ts`** — 2 new tests added (now 16 total). The M11 test is updated to mock `getUserPermissions` so the new permission gates are exercised:
  - `POST /channels` with a non-owner member who has `send_messages` but not `manage_channels` → **403**
  - `PATCH /channels/{id}` with a non-owner member who has `send_messages` but not `manage_channels` → **403**
- **`apps/web/app/api/servers/[id]/channels/[channelId]/messages/__tests__/messages.test.ts`** — 16 tests (no new tests, but the `mockServerAlive` helper now also mocks `getUserPermissions` to return `['administrator']`). The PATCH 403 + DELETE 403 cases now return 403 (instead of 500) because `getUserPermissions` returns the right shape; the "owner can edit" test exercises the owner-shortcut path.

The role-management + membership routes do not yet have a dedicated test file. The query helpers in `queries/roles.ts` are unit-testable (in `packages/db`); the route tests are a follow-up once M14 lands the audit-log + invite-redeem code that the role system leans on.

### Added — User-driven M14 stubs (untracked, integrated)

The user landed three routes that depend on the M13 surface: `apps/web/app/api/presence/route.ts` (Redis-backed presence — `setUserPresence(userId, serverId, channelId, status)` in `lib/redis.ts`), and two test-reset routes (`/api/test/db-reset` truncates `memberships, servers, users, invites`; `/api/test/redis-reset` calls `flushdb`). All three follow the standard `withApiSecurity` + cookie session shape; the test-reset routes guard themselves with a `process.env.NODE_ENV !== 'test'` check.

### Cross-Platform

- The new queries are pure Drizzle — no platform-specific code paths. The route handlers are Node-only (`runtime = 'nodejs'`) and work identically on Windows and Linux.
- The new endpoints sit behind `withApiSecurity`, so the standard security headers + 405 + rate limiting apply uniformly on both OSes.
- The presence + test-reset routes use `lib/redis.ts` (the singleton stashed on `globalThis`), which works identically on Windows and Linux.

### Documentation

- **`docs/ROLES.md`** — new. The 14 `CorePermission` constants, the default-role seed table, the `getUserPermissions` shortcut with code, all 8 endpoints (with body / status / rate-limit tables), the 503 contract, the permission-check migration table for M11 + M12, the query helpers, the test matrix, the relationship to M10 + M11 + M12, and the out-of-scope list (invite-redeem, bans, audit log, role reordering UI, multiple roles per member, permissions UI, permission inheritance, role-deletion cascading, distributed rate limit, per-channel permission overrides).
- **`docs/CHANGELOG.md`** — this section.
- **`docs/VERIFICATION_REPORT.md`** — refreshed to 182 tests across 30 test files and 22 routes (the M13 + user-M14 build output is the new baseline; 19 routes are the M13 milestone, +3 M14 presence/test-reset routes).
- **`docs/WEB_APP.md`** — reflects the Phase 2 surface (5 new M13 routes + 1 new query file + the 3 user-M14 routes).

### Out of Scope (intentionally deferred)

- **Invite-redeem.** The `invites` table is in the M3 schema and the `@everyone` default permissions include `CREATE_INVITE`, but there's no `POST /api/servers/{id}/invites` or `POST /api/invites/{code}/redeem` yet. M14.
- **Bans.** The `server_bans` table is in the M3 schema. The `BAN_MEMBERS` permission is seeded on `@admin`, but no route writes to it. M14.
- **Audit log.** The `audit_logs` table is in the M3 schema. Every M13 mutation (role create / update / delete, member kick, role assignment) should land a row; the wiring is M14.
- **Role reordering UI.** `PATCH` accepts a new `position` but doesn't renumber siblings (same shape as the M11 channel reordering). The "move and shift" helper is M14.
- **Multiple roles per member.** The `memberships.roleId` column is a single FK, not a join table. A user can be in at most one role per server today. The "many roles" expansion is M14 if a server needs nuanced capability sets.
- **Permissions UI.** The role management routes exist; a UI to assign permissions through checkboxes is M15+ (the `@lobbyforge/ui` design system).
- **Permission inheritance.** `@everyone` grants a default set; specific roles add on top. The "union of role permissions" semantics is the M13 model. A "deny" flag or per-channel overrides is out of scope.
- **Role deletion cascading.** `deleteRole` clears the `roleId` on memberships but doesn't tell the user "this role was deleted, these N members lost the role". A follow-up audit-log entry lands with M14.
- **Distributed rate limit / Redis-backed presence productionization.** The `app/api/presence/route.ts` route (M14, added by the user) leans on `lib/redis.ts` to set a 90-second-TTL presence key. The route is gated by `withApiSecurity` and a real session check, but the rate-limit identifier is shared across all users (the `presence-update` rate-limit is in-process). The Redis-backed limit lands with M14's full moderation pass.
- **Per-channel permission overrides.** Today the role's permissions apply to every channel the member can see. Discord's "this channel denies @everyone read access" is a future feature.
- **Role-management + membership route tests.** A dedicated test file for the 5 role + 3 membership routes is a follow-up once the audit-log + invite-redeem code (which the role system leans on) lands with M14. The query helpers in `queries/roles.ts` are unit-testable in `packages/db` for the same reason.

### Added — `@lobbyforge/db`

- **`queries/messages.ts`** — `createMessage`, `listMessagesForChannel`, `getMessageById`, `updateMessage`, `softDeleteMessage`. Every helper filters out soft-deleted parents (`channels` + `servers`) so a soft-deleted server automatically hides its messages. `createMessage` validates the `replyToId` is in the same channel; `updateMessage` always stamps `editedAt`; `softDeleteMessage` is idempotent (deleting an already-deleted row throws).
- **`src/index.ts`** — re-exports `./queries/messages.js`. The package surface is now `queries/{users,servers,memberships,channels,messages}.ts`.

### Added — `apps/web` Messages API

- **`app/api/servers/[id]/channels/[channelId]/messages/route.ts`** — `GET` (list, 60 req/min, supports `?before=ISO` cursor and `?limit=N`) + `POST` (create, 30 req/min). Both require the caller to be a member of the server. Body validation uses `MessageContentSchema` (1-4000 chars) from `@lobbyforge/core` plus an optional `replyToId` (uuid) and a free-form `metadata` blob. The `hasPermission` + `CorePermission.SEND_MESSAGES` placeholder is in the route; the real permission check lands with M13's role system.
- **`app/api/servers/[id]/channels/[channelId]/messages/[messageId]/route.ts`** — `GET` (60 req/min), `PATCH` (30 req/min, always stamps `editedAt`), `DELETE` (10 req/min, soft-delete). Reads are member-or-owner; mutations are **author OR server owner** (the owner override is for moderation; it's replaced by a `MANAGE_MESSAGES` check once M13 ships). The "message belongs to a different channel" case returns 404.
- **`api/servers/[id]/route.ts` + `api/servers/[id]/channels/route.ts`** — no change. M11 already exposes the membership check; M12 leans on it.

### Added — Tests

- **`apps/web/app/api/servers/[id]/channels/[channelId]/messages/__tests__/messages.test.ts`** — 16 tests, five `describe` blocks (list, create, get-single, patch, delete). Mocks `@lobbyforge/db` (all five new query functions + the M10 + M11 helpers the routes lean on) and `@/lib/security-headers` (pass-through wrapper). The cookie sent in each request is a real signed `lf_guest` (built via `buildGuestSessionCookie`) so `readGuestSession` sees the production code path. Highlights:
  - The "PATCH by the server owner of a message they did not author" test exercises the owner-override path.
  - The "GET for a message in a different channel" test confirms the 404-not-403 invariant.

### Cross-Platform

- The new queries are pure Drizzle — no platform-specific code paths. The route handlers are Node-only (`runtime = 'nodejs'`) and work identically on Windows and Linux.
- The new endpoints sit behind `withApiSecurity`, so the standard security headers + 405 + rate limiting apply uniformly on both OSes.

### Documentation

- **`docs/MESSAGES.md`** — new. The auth model (member-or-owner for reads, author-or-owner for mutations), all five endpoints (with body / status / rate-limit tables), the soft-delete story, the `replyToId` semantics, the `metadata` blob, the query helpers, the test matrix, the relationship to M10 + M11, and the out-of-scope list (reactions, attachments, search, plugins, real-time, audit log, edit history, mentions).
- **`docs/CHANGELOG.md`** — this section.
- **`docs/VERIFICATION_REPORT.md`** — refreshed to 180 tests across 30 test files and 13 routes (the M12 build output is the new baseline).
- **`docs/WEB_APP.md`** — reflects the Phase 2 surface (5 new routes, 1 new query file).

### Out of Scope (intentionally deferred)

- **Reactions.** The `reactions` table is in the M3 schema; the route layer lands with M14. Today's `metadata` blob is the only way a UI can attach a reaction count, and no route writes to it.
- **Attachments / file uploads.** The `attachments` table is in the M3 schema; the upload pipeline (S3-compatible storage, presigned URLs, MIME validation) is M15.
- **Message search.** Full-text search across a server is a Postgres `tsvector` index + a `GET /api/servers/{id}/messages?q=…` endpoint. M16+.
- **Real-time delivery.** Today's read path is "client polls `GET /api/messages?before=…`". The real-time layer (WebSocket / SSE / LiveKit data channels) is M17.
- **Audit logging for moderation actions.** "Owner X deleted user Y's message at T" is in the design notes; the `audit_log` table writes land with M14.
- **Edit history.** A `PATCH` is destructive. The "see older versions" feature requires a `message_edits` table; M14+.
- **@-mentions / notifications.** Parsing `@username` out of the content, resolving it to a user, and dispatching a notification is M16. The content is stored as-is today.
- **Cross-channel replies.** Today rejected by the helper. The schema allows it; the route layer is the gate. M15 if Discord's pattern is worth copying.
- **Bulk fetch.** "Give me the last 50 messages from 5 channels" is not in scope; the UI does N round-trips. M15 if the latency hurts.
- **Rate-limit namespacing.** Today the per-channel limit is shared across all channels. A future iteration namespaces by `(channelId, action)`.
- **Author anonymization on user delete.** The schema has `ON DELETE SET NULL` on `user_id`; the route layer renders `userId: null` as "Deleted User" once the M14 user-delete flow ships.

---

## [Unreleased] — M12: Messages API — 2026-06-10

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |
| M8 | Next.js 15 web app + Doctor subsystem | done | `apps/web` is a real App Router project; Doctor lives in `@lobbyforge/core` |
| M9 | Guest auth + LiveKit token endpoint | done | HMAC-signed `lf_guest` cookie + `/api/auth/guest` + `/api/livekit/token`; delivers the Phase 1 "two-browser voice test" success criterion (server-side) |
| M10 | Servers API + DB wiring | done | The first Phase 2 surface — `users` rows are materialized from the guest cookie, and `/api/servers` is wired to a real Drizzle/Postgres backend |
| M11 | Channels API + membership check | done | The second Phase 2 surface — five endpoints (`GET`/`POST` list+create, `GET`/`PATCH`/`DELETE` single), membership-based auth, and a position-aware channel ordering |
| M12 | Messages API | done | The third Phase 2 surface — five endpoints (list/create/get/patch/delete), author-or-owner mutation rule, soft-delete, and a `replyToId` self-FK for in-channel replies |

### Added — `@lobbyforge/db`

- **`queries/messages.ts`** — `createMessage`, `listMessagesForChannel`, `getMessageById`, `updateMessage`, `softDeleteMessage`. Every helper filters out soft-deleted parents (`channels` + `servers`) so a soft-deleted server automatically hides its messages. `createMessage` validates the `replyToId` is in the same channel; `updateMessage` always stamps `editedAt`; `softDeleteMessage` is idempotent (deleting an already-deleted row throws).
- **`src/index.ts`** — re-exports `./queries/messages.js`. The package surface is now `queries/{users,servers,memberships,channels,messages}.ts`.

### Added — `apps/web` Messages API

- **`app/api/servers/[id]/channels/[channelId]/messages/route.ts`** — `GET` (list, 60 req/min, supports `?before=ISO` cursor and `?limit=N`) + `POST` (create, 30 req/min). Both require the caller to be a member of the server. Body validation uses `MessageContentSchema` (1-4000 chars) from `@lobbyforge/core` plus an optional `replyToId` (uuid) and a free-form `metadata` blob. The `hasPermission` + `CorePermission.SEND_MESSAGES` placeholder is in the route; the real permission check lands with M13's role system.
- **`app/api/servers/[id]/channels/[channelId]/messages/[messageId]/route.ts`** — `GET` (60 req/min), `PATCH` (30 req/min, always stamps `editedAt`), `DELETE` (10 req/min, soft-delete). Reads are member-or-owner; mutations are **author OR server owner** (the owner override is for moderation; it's replaced by a `MANAGE_MESSAGES` check once M13 ships). The "message belongs to a different channel" case returns 404.
- **`api/servers/[id]/route.ts` + `api/servers/[id]/channels/route.ts`** — no change. M11 already exposes the membership check; M12 leans on it.

### Added — Tests

- **`apps/web/app/api/servers/[id]/channels/[channelId]/messages/__tests__/messages.test.ts`** — 16 tests, five `describe` blocks (list, create, get-single, patch, delete). Mocks `@lobbyforge/db` (all five new query functions + the M10 + M11 helpers the routes lean on) and `@/lib/security-headers` (pass-through wrapper). The cookie sent in each request is a real signed `lf_guest` (built via `buildGuestSessionCookie`) so `readGuestSession` sees the production code path. Highlights:
  - The "PATCH by the server owner of a message they did not author" test exercises the owner-override path.
  - The "GET for a message in a different channel" test confirms the 404-not-403 invariant.

### Cross-Platform

- The new queries are pure Drizzle — no platform-specific code paths. The route handlers are Node-only (`runtime = 'nodejs'`) and work identically on Windows and Linux.
- The new endpoints sit behind `withApiSecurity`, so the standard security headers + 405 + rate limiting apply uniformly on both OSes.

### Documentation

- **`docs/MESSAGES.md`** — new. The auth model (member-or-owner for reads, author-or-owner for mutations), all five endpoints (with body / status / rate-limit tables), the soft-delete story, the `replyToId` semantics, the `metadata` blob, the query helpers, the test matrix, the relationship to M10 + M11, and the out-of-scope list (reactions, attachments, search, plugins, real-time, audit log, edit history, mentions).
- **`docs/CHANGELOG.md`** — this section.
- **`docs/VERIFICATION_REPORT.md`** — refreshed to 180 tests across 30 test files and 13 routes (the M12 build output is the new baseline).
- **`docs/WEB_APP.md`** — reflects the Phase 2 surface (5 new routes, 1 new query file).

### Out of Scope (intentionally deferred)

- **Reactions.** The `reactions` table is in the M3 schema; the route layer lands with M14. Today's `metadata` blob is the only way a UI can attach a reaction count, and no route writes to it.
- **Attachments / file uploads.** The `attachments` table is in the M3 schema; the upload pipeline (S3-compatible storage, presigned URLs, MIME validation) is M15.
- **Message search.** Full-text search across a server is a Postgres `tsvector` index + a `GET /api/servers/{id}/messages?q=…` endpoint. M16+.
- **Real-time delivery.** Today's read path is "client polls `GET /api/messages?before=…`". The real-time layer (WebSocket / SSE / LiveKit data channels) is M17.
- **Audit logging for moderation actions.** "Owner X deleted user Y's message at T" is in the design notes; the `audit_log` table writes land with M14.
- **Edit history.** A `PATCH` is destructive. The "see older versions" feature requires a `message_edits` table; M14+.
- **@-mentions / notifications.** Parsing `@username` out of the content, resolving it to a user, and dispatching a notification is M16. The content is stored as-is today.
- **Cross-channel replies.** Today rejected by the helper. The schema allows it; the route layer is the gate. M15 if Discord's pattern is worth copying.
- **Bulk fetch.** "Give me the last 50 messages from 5 channels" is not in scope; the UI does N round-trips. M15 if the latency hurts.
- **Rate-limit namespacing.** Today the per-channel limit is shared across all channels. A future iteration namespaces by `(channelId, action)`.
- **Author anonymization on user delete.** The schema has `ON DELETE SET NULL` on `user_id`; the route layer renders `userId: null` as "Deleted User" once the M14 user-delete flow ships.

---

## [Unreleased] — M11: Channels API + membership check — 2026-06-10

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |
| M8 | Next.js 15 web app + Doctor subsystem | done | `apps/web` is a real App Router project; Doctor lives in `@lobbyforge/core` |
| M9 | Guest auth + LiveKit token endpoint | done | HMAC-signed `lf_guest` cookie + `/api/auth/guest` + `/api/livekit/token`; delivers the Phase 1 "two-browser voice test" success criterion (server-side) |
| M10 | Servers API + DB wiring | done | The first Phase 2 surface — `users` rows are materialized from the guest cookie, and `/api/servers` is wired to a real Drizzle/Postgres backend |
| M11 | Channels API + membership check | done | The second Phase 2 surface — five endpoints (`GET`/`POST` list+create, `GET`/`PATCH`/`DELETE` single), membership-based auth, and a position-aware channel ordering |

### Added — `@lobbyforge/db`

- **`queries/memberships.ts`** — `isServerMember(db, userId, serverId)` and `getServerMember(db, serverId, userId)`. The `isServerMember` helper joins `users` to filter out soft-deleted accounts; the owner case is implicit because `createServer` auto-inserts an owner membership.
- **`queries/channels.ts`** — `createChannel`, `listChannelsForServer`, `getChannelById`, `updateChannel`, `deleteChannel`. The `createChannel` helper computes `max(position) + 1` when no `position` is supplied, so freshly created channels land at the bottom of the list (Discord / Slack semantics). The list query joins `servers` to filter out channels whose parent is soft-deleted.

### Added — `apps/web` Channels API

- **`app/api/servers/[id]/channels/route.ts`** — `GET` (list channels in a server, 60 req/min) + `POST` (create a channel, 10 req/min). Both require the caller to be a member of the server. Body validation uses `ChannelNameSchema` from `@lobbyforge/core` plus a `z.enum` for the channel `type` (one of `text / voice / activity / announcement / stage`).
- **`app/api/servers/[id]/channels/[channelId]/route.ts`** — `GET` (read a single channel, 60 req/min), `PATCH` (partial update of `name / topic / position`, 30 req/min), `DELETE` (hard-delete, 10 req/min). Reads are member-or-owner; mutations are owner-only. The "channel belongs to a different server" case returns 404 (not 403) so the route doesn't leak the existence of channels in other servers.
- **`auth/guest` route** — no change. The M10 cookie-mint path already materializes the user, so the M11 routes see a real `uid`.
- **`api/servers/[id]/route.ts`** — flipped the auth check from "owner-only" to "any member of the server" (M10's `isOwner` check replaced with `isServerMember`). The M10 test was updated in lockstep.

### Added — Tests

- **`apps/web/app/api/servers/[id]/channels/__tests__/channels.test.ts`** — 14 tests, five `describe` blocks (list, create, get-single, patch, delete). Mocks `@lobbyforge/db` (all seven new query functions) and `@/lib/security-headers` (pass-through wrapper). The cookie sent in each request is a real signed `lf_guest` (built via `buildGuestSessionCookie`) so `readGuestSession` sees the production code path.
- **Updated `apps/web/app/api/servers/__tests__/servers.test.ts`** — the M10 "non-owner → 403" test is now "non-member → 403" (with `isServerMember.mockResolvedValue(false)`), and the "owner → 200" test is now "member → 200" (with `isServerMember.mockResolvedValue(true)`).

### Cross-Platform

- The new queries are pure Drizzle — no platform-specific code paths. The route handlers are Node-only (`runtime = 'nodejs'`) and work identically on Windows and Linux.
- The new endpoints sit behind `withApiSecurity`, so the standard security headers + 405 + rate limiting apply uniformly on both OSes.

### Documentation

- **`docs/CHANNELS.md`** — new. The auth model (member-or-owner for reads, owner-only for mutations), all five endpoints (with body / status / rate-limit tables), the position semantics, the soft-delete story, the query helpers, the test matrix, the relationship to M10, and the out-of-scope list.
- **`docs/CHANGELOG.md`** — this section.
- **`docs/VERIFICATION_REPORT.md`** — refreshed to 164 tests across 29 test files and 11 routes (the M11 build output is the new baseline).
- **`docs/WEB_APP.md`** — reflects the Phase 2 surface (5 new routes, 2 new query files).

### Out of Scope (intentionally deferred)

- **Messages.** `POST /api/servers/{id}/channels/{channelId}/messages` is M12. The `messages` table is already in the schema; the route will lean on the channel's `id`.
- **Voice presence.** "Who is in this voice channel" is M13 (Redis presence layer + LiveKit `RoomServiceClient.listParticipants`). Today's `channel.type === 'voice'` is just a label.
- **Permission checks on `POST /api/servers/{id}/channels`.** Today any member can create a channel. Once roles land with M12, the route gains a `MANAGE_CHANNELS` check; the `hasPermission` call is already in the route as a placeholder.
- **Drag-and-drop reordering.** `PATCH` accepts a new `position` but doesn't renumber siblings. The "move and shift" helper is M14.
- **Audit logging.** Channel create / update / delete are not yet logged. The shape is in the route, the audit-log table writes land with M14.
- **Bulk create / bulk delete.** A `POST /api/servers/{id}/channels/bulk` endpoint is in the design notes but not implemented.
- **Topic edit history.** `topic` is overwritten in place. Discord-like "edited by X at Y" lands when the audit-log integration ships.
- **Channel-level rate limits.** The per-server limit is shared across all channels in a server. A future iteration namespaces by `(serverId, action)`.

---

## [Unreleased] — M10: Servers API + DB wiring — 2026-06-10

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |
| M8 | Next.js 15 web app + Doctor subsystem | done | `apps/web` is a real App Router project; Doctor lives in `@lobbyforge/core` |
| M9 | Guest auth + LiveKit token endpoint | done | HMAC-signed `lf_guest` cookie + `/api/auth/guest` + `/api/livekit/token`; delivers the Phase 1 "two-browser voice test" success criterion (server-side) |
| M10 | Servers API + DB wiring | done | The first Phase 2 surface — `users` rows are materialized from the guest cookie, and `/api/servers` is wired to a real Drizzle/Postgres backend |

### Added — `@lobbyforge/db`

- **Schema delta.** `users.guest_key` (text, unique, partial index `WHERE guest_key IS NOT NULL`). The column is the join key from a guest cookie to a materialized `users` row. The `servers` and `memberships` tables were already in the M3 schema; M10 just exercises them.
- **`queries/users.ts`** — `findOrCreateGuestUser(db, { guestKey, displayName, locale? })`, `getUserById(db, id)`, `softDeleteUser(db, id)`. `findOrCreateGuestUser` is idempotent: `onConflictDoNothing({ target: users.guestKey })` + a fallback select, with a custom SQLSTATE `'23505'` matcher for clients that raise on the conflict path rather than returning an empty array.
- **`queries/servers.ts`** — `createServer(db, input)` (also auto-inserts the owner membership in the same call), `getServerById(db, id)` (excludes soft-deleted), `listServersForUser(db, userId, { limit? })` (joins memberships, orders by recency, default limit 100), `softDeleteServer(db, id)`.

### Added — `apps/web` DB layer + API

- **`lib/db.ts`** — singleton Drizzle client stashed on `globalThis` (so it survives Next.js's hot-reload re-imports) + a `__setDbForTests(client)` test-only hook. `getDb()` throws if `DATABASE_URL` is missing — fail-loud at startup.
- **`app/api/servers/route.ts`** — `GET` (list caller's servers, 60 req/min) + `POST` (create a server, 10 req/min). Both go through `withApiSecurity`. `POST` requires a session whose cookie carries a materialized `uid`; otherwise 503 with `howToFix: "Re-issue POST /api/auth/guest"`.
- **`app/api/servers/[id]/route.ts`** — `GET` for a single server, **owner-only in M10**. 60 req/min. The route uses the Next.js 15 `params: Promise<{ id: string }>` shape, so `withApiSecurity` is now generic over a `TContext` argument.
- **`auth/guest` route** — extended to call `findOrCreateGuestUser` on `POST` so the very first call from a fresh browser already has a `uid`. Failures are non-fatal (the cookie is still valid for guest-only flows; the user just can't hit `/api/servers` until the DB is up).

### Added — Guest session payload upgrade

- `lib/guest-session.ts` — `GuestPayload` now carries a `uid: string | null` field. Pre-M10 cookies (no `uid`) still parse cleanly; `parseGuestPayload` normalizes the missing field to `null`. The wire format stays backward compatible.

### Added — `withApiSecurity` upgrade

- `lib/security-headers.ts` — `withApiSecurity` is now generic over `TContext` so dynamic route segments (`[id]`, future `[slug]`, etc.) can pass the Next.js 15 `ctx` through. The handler signature becomes `(req: Request, ctx: TContext) => Promise<NextResponse> | NextResponse`.

### Added — Tests

- **`apps/web/app/api/servers/__tests__/servers.test.ts`** — 9 tests, three `describe` blocks (POST, GET list, GET single). Mocks `@lobbyforge/db` (query functions) and `@/lib/security-headers` (pass-through wrapper) so the test exercises the real route logic — auth, body validation, query dispatch, owner check — without a real Postgres or a real `withApiSecurity` chain. The cookie sent in each request is a real signed `lf_guest` (built via `buildGuestSessionCookie`) so the route's `readGuestSession` sees the same code path it does in production.
- **`apps/web/lib/__tests__/db.test.ts`** — 3 tests covering `getDb()` (throws on missing `DATABASE_URL`, caches the client on the second call) and `__setDbForTests(null)` (wipes the cache).
- **Updated `lib/__tests__/guest-session.test.ts`** — adds a test that the `uid` round-trips through the cookie (and is preserved across a rebind) and one for the "pre-M10 cookie" shape (no `uid` field) to confirm `parseGuestPayload` normalizes it.
- **Updated `lib/__tests__/security-headers.test.ts`** — call sites now pass `undefined` for the new `ctx` parameter, matching the generic signature.

### Updated

- **`apps/web/package.json`** — adds `@lobbyforge/db` and `drizzle-orm@^0.31.2` to `dependencies`. `postgres` stays as a transitive dep through `@lobbyforge/db`.
- **`apps/web/vitest.config.ts`** — adds `'app/api/**/__tests__/**/*.test.ts'` to the test `include` glob.
- **`infra/docker/.env.example`** — documents `DATABASE_URL` (default points at the local docker-compose dev stack) and the optional `DATABASE_POOL_MAX` / `DATABASE_SSL` knobs.
- **`packages/db/src/queries/users.ts`** — exports `__test__` and `__sql` symbols to keep the `isUniqueViolation` / `sql` imports from being tree-shaken out before they're exercised.

### Cross-Platform

- The DB singleton uses `globalThis` (works in Node.js on Windows and Linux identically). Drizzle and `postgres.js` are platform-agnostic. No new build scripts; `pnpm -r build` still produces the same `.next/` artifact on both OSes.
- The new routes sit behind `withApiSecurity`, so the standard security headers + 405 + rate limiting apply uniformly on Windows and Linux.

### Documentation

- **`docs/SERVERS.md`** — new. The DB schema delta, the query helpers, the DB singleton, all three endpoints (with body / status / rate-limit tables), the auth-flow diagram, and the out-of-scope list (memberships, channels, audit log, distributed rate limit, slug uniqueness, icon upload).
- **`docs/CHANGELOG.md`** — this section.
- **`docs/VERIFICATION_REPORT.md`** — refreshed to 150 tests across 28 test files and 8 routes (the M10 build output is the new baseline).

### Out of Scope (intentionally deferred)

- **Membership / channel / role / invite endpoints.** The `memberships` table is exercised by the auto-add in `createServer` and by `listServersForUser`, but there are no `GET /servers/{id}/members` or invite endpoints yet. M11.
- **Real permission check on `POST /api/servers`.** The "subsequent creations need MANAGE_SERVER or START_ACTIVITY" rule is documented in `route.ts` and not yet enforced; the role system is M12.
- **Distributed rate limiting / audit logging.** Both are in the `withApiSecurity` shape already; the swap to Redis-backed limits + the audit-log table is M14.
- **Slug uniqueness at the schema level.** Two servers with the same slug will both succeed; the UI dedupes. A unique index lands with M11.
- **Server icon upload.** `iconUrl` is null; the upload pipeline is M15.
- **CSRF on the new POSTs.** The cookie is `SameSite=Lax`, sufficient for the first-party browser case. Explicit CSRF lands with the desktop app in Phase 8.
- **Real `next dev` server testing.** The tests exercise the route handlers directly; an end-to-end `next dev` integration test is the next step.

---

## [Unreleased] — M9: Guest auth + LiveKit token endpoint — 2026-06-09

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |
| M8 | Next.js 15 web app + Doctor subsystem | done | `apps/web` is a real App Router project; Doctor lives in `@lobbyforge/core` |
| M9 | Guest auth + LiveKit token endpoint | done | HMAC-signed `lf_guest` cookie + `/api/auth/guest` + `/api/livekit/token`; delivers the Phase 1 "two-browser voice test" success criterion (server-side) |

### Added — `apps/web` guest auth

- `lib/cookies.ts` — minimal HMAC-SHA256 signed-cookie helpers (`signSessionCookie`, `verifySessionCookie`, `readCookie`, `clearCookieHeader`). No third-party JWT dep; the wire format is `base64url(payload).base64url(hmac)`. Uses `crypto.timingSafeEqual` for MAC comparison.
- `lib/guest-session.ts` — `createGuestIdentity`, `buildGuestSessionCookie`, `readGuestSession`. Gid format is `g_<32 hex>`; display name is `Guest <seed-or-4hex>` with strict sanitization (`[A-Za-z0-9_- ]` only, capped at 32 chars).
- `app/api/auth/guest/route.ts` — `POST` mints a new guest identity (or rebinds the existing one) and sets the `lf_guest` cookie; `GET` is a "who am I" probe. Both pass through `withApiSecurity` (rate-limited at 30 / 120 req/min respectively).
- `app/api/livekit/token/route.ts` — `POST` requires a valid `lf_guest` cookie, validates the room name (alphanumeric / dash / underscore, ≤ 64 chars), and returns a LiveKit access token. 30 req/min.

### Added — LiveKit access token issuer

- `lib/livekit.ts` — `issueLiveKitToken(input)` and `requireLiveKitCredentials(env)`. Built on `jose` (zero-dep HS256 JWT) instead of the full `livekit-server-sdk` package, so we don't pull `protobufjs` and other unused pieces. Implements every LiveKit grant the spec calls out: `room`, `roomJoin`, `canPublish`, `canSubscribe`, `canPublishData`, `canPublishSources`, `canSubscribeSources`, `hidden`, `recorder`, plus an optional `metadata` blob.
- Default TTL: 3600 s. Configurable per call.

### Added — `/connect` demo page

- `app/connect/page.tsx` — a small client component that walks a fresh visitor through `POST /api/auth/guest` → `POST /api/livekit/token`. Two browsers pointed at `/connect` produce two distinct gids but the same room token, demonstrating the Phase 1 "two-browser voice test" success criterion. The page is removed once the real voice-room UI lands.

### Added — Tests

- `lib/__tests__/cookies.test.ts` — 16 tests: sign/verify round-trip, tampering rejection, wrong-secret rejection, expiry + clock skew, missing `exp`, malformed inputs, `readCookie` parsing, `clearCookieHeader` format.
- `lib/__tests__/guest-session.test.ts` — 12 tests: gid format, sanitization, name length cap, uniqueness, cookie round-trip, signature rejection, expiry.
- `lib/__tests__/livekit.test.ts` — 11 tests: JWT shape, all grant flags, `metadata` passthrough, `recorder` flag, error paths for missing fields, `requireLiveKitCredentials` env parsing.

### Updated

- `apps/web/package.json` — adds `jose@^5.9.6` (LiveKit JWT signing) and `zod@^3.23.8` (request body validation in the new endpoints).
- `apps/web/app/layout.tsx`, `app/page.tsx` — links to the new `/connect` page in the top nav and the home page.
- `infra/docker/.env.example` — documents `LOBBYFORGE_SESSION_SECRET` (and the existing Doctor env vars that the M8 work introduced).
- `apps/web/lib/guest-session.ts` — the relative import `from './cookies.js'` is `.js`-suffix-free on purpose: `moduleResolution: Bundler` doesn't auto-strip the suffix, and Next.js's webpack build rejects it. The tests still resolve the file via Vite.

### Cross-Platform

- The cookie helpers and the LiveKit issuer are pure Node APIs (`crypto`, `jose`); no platform-specific code paths. `lib/cookies.ts` reads `process.env.NODE_ENV` via a small indirection (`readNodeEnv()`) to dodge the `@types/node` `NODE_ENV` readonly-typed assignment when tests flip it.
- The new endpoints sit behind `withApiSecurity`, so the standard security headers + 405 + rate limiting apply uniformly on Windows and Linux.

### Documentation

- `docs/GUEST_AUTH.md` — the cookie format, the two endpoints, the JWT shape, the `/connect` flow diagram, and the deferred-work list.
- `docs/CHANGELOG.md` — this section.

### Out of Scope (intentionally deferred)

- **DB-backed sessions.** A guest is anonymous; the `users` / `user_sessions` tables exist but are not written by this path. Phase 2 replaces the cookie-only mint with an insert + cookie-sign and adds a refresh endpoint.
- **Real LiveKit `connect()`.** The third step of the diagram (the LiveKit client SDK actually opening a WebSocket to the room) is not in this pass. The page stops at the token-issuance step.
- **CSRF on `POST /api/livekit/token`.** The cookie is `SameSite=Lax`, which is sufficient for the first-party browser case. Explicit CSRF lands with the desktop app in Phase 8.
- **Distributed rate limiting / audit logging.** Both are in the `withApiSecurity` shape already; the swap to Redis-backed limits + the audit-log table is the next pass.
- **Refresh tokens.** A guest whose session expires re-runs "Create guest". Real users get a refresh dance in Phase 2.
- **Server-side room service.** `livekit-server-sdk`'s `RoomServiceClient` (for kicking / listing / muting from the server side) is not added yet. When the moderation pass lands, the package dep is reconsidered.

---

## [Unreleased] — M8: Next.js 15 web app + Doctor subsystem — 2026-06-09

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |
| M8 | Next.js 15 web app + Doctor subsystem | done | `apps/web` is a real App Router project; Doctor lives in `@lobbyforge/core` |

### Added — `apps/web` (Next.js 15 App Router)

- **Next.js 15.5** wired up with `typedRoutes`, `transpilePackages: [@lobbyforge/core, @lobbyforge/i18n, @lobbyforge/ui]`, `reactStrictMode`, and `poweredByHeader: false`.
- `app/layout.tsx` — root layout with a top nav (Home, System Health).
- `app/page.tsx` — landing page that lists the planned routes from `@lobbyforge/web` (the package's own `ROUTES` constant).
- `app/admin/health/page.tsx` — server component that calls `collectDoctorReport()` and renders the summary badges + capacity card + per-check list with the spec's `✅/⚠️/🔴/💀/ℹ️` glyphs.
- `app/api/health/route.ts` — `GET` returning `buildHealthStatus({ web, started }, startedAt)`; 120 req/min.
- `app/api/doctor/route.ts` — `GET` returning `{ report, stats }` after redacting the `startedAt` Date; 12 req/min.
- `lib/doctor.ts` — `collectSystemStats()` (Node-`os`-bound), `collectDoctorReport()` (parallel HTTP probes with 1.5 s timeout), `buildChecksFromStats()` (pure).
- `lib/security-headers.ts` — `withApiSecurity(handler, options)` wrapper that applies `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`; method allowlist with 405 + `Allow`; in-memory token-bucket rate limiter.
- `tsconfig.json` — extends the workspace base, **overrides** `module` and `moduleResolution` to `ESNext` / `Bundler` so the Next App Router can resolve `next/server` and the `@/*` path alias cleanly. The override is scoped to `apps/web` and documented in-file (see `docs/WEB_APP.md`).

### Added — `@lobbyforge/core` Doctor primitive

- `DoctorCategory`, `AlertLevel`, `DoctorCheck`, `SystemStats`, `CapacityTier`, `CapacityProfile`, `DoctorReport` types.
- `recommendCapacityProfile(stats)` — pure tier picker with the Low / Medium / High profile numbers from the spec §4 and the conservative-language `guidance` string from spec §8.
- `buildDoctorReport(checks, stats, generatedAt?)` — aggregator that counts per-level, sorts by category then id (stable, diff-friendly), and bundles the capacity recommendation.
- 13 new unit tests in `packages/core/src/__tests__/doctor.test.ts` covering tier transitions, disk / load / memory demotion, NaN clamping, summary counts, and check ordering.

### Added — Tests

- `apps/web/lib/__tests__/doctor.test.ts` — 11 tests covering check ids, severity levels for every state, the null-reachability invariant, the TURN × UDP interaction, and category coverage.
- `apps/web/lib/__tests__/security-headers.test.ts` — 10 tests covering header application, method allowlist, rate limiter isolation per key, and the `withApiSecurity` wrapper end-to-end.

### Cross-Platform

- All the new code is platform-agnostic at the type level (no `node:os` in `@lobbyforge/core`). The only Node-bound bits (`lib/doctor.ts`) are behind `runtime = 'nodejs'` in the route declarations, so the same code paths run on Windows and Linux.
- No new build scripts or env-loading hacks. The `next build` / `next dev` / `next start` scripts are cross-platform by construction.

### Documentation

- `docs/WEB_APP.md` — stack, layout, the `moduleResolution: Bundler` rationale, security posture, local dev, and what's intentionally not there.
- `docs/DOCTOR.md` — data model, capacity algorithm, the full check list, web app integration, and the deferred-work list.
- `docs/CHANGELOG.md` — this section.

### Out of Scope (intentionally deferred)

- **Real TCP probes for PostgreSQL / Redis.** Today they return `true` optimistically. A real implementation opens a `pg` / `ioredis` connection; both drivers are already in the dep surface but not wired in.
- **UDP reachability probe.** Always `null` today (a STUN binding request would need a `stun` package).
- **Disk snapshot from the real filesystem.** A single env var; a future iteration shells out to `df -P` on Linux or reads `Get-PSDrive` on Windows.
- **Admin auth on `/admin/health` and `/api/doctor`.** Route is reachable today; the user/session model is Phase 2.
- **Webhook / email / banner alert delivery.** The contract is "anything reading `/api/doctor` can drive its own channel" — wiring to the alert channels from spec §3 is the next pass.
- **CSRF protection.** A `csrfProtection: true` config flag is reserved in `withApiSecurity`; the first state-changing route is what turns it on.
- **Continuous / periodic scheduling.** Doctor is on-demand today; a 60 s health / 15 min full-report cron is the next step.
- **Live LiveKit room UI.** Phase 1 of the roadmap is the "two-browser voice test" — that is the next user-visible milestone.
- **Tailwind / design system in apps/web.** Inline CSS for now; the design system lands in `@lobbyforge/ui` and is consumed from there.

---

## [Unreleased] — Cross-Platform Skeleton Pass — 2026-06-09

### Milestone Status

| # | Milestone | Status | Notes |
|---|---|---|---|
| M1 | Monorepo workspace config | done | `pnpm-workspace.yaml` + root `package.json` |
| M2 | Config + SDK scaffolding | done | `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` |
| M3 | Core & shared packages | done | `core`, `db` (drizzle-orm), `i18n` (en+tr), `ui` (Button, Card, Modal, …) |
| M4 | Plugin scaffolding | done | `hushle`, `quiz`, `vampire-village`, `watch-party` |
| M5 | Apps scaffolding | done | `web`, `desktop`, `registry` (placeholders for now) |
| M6 | Cross-platform scripts | done | All root scripts are OS-agnostic |
| M7 | Documentation & verification | done | `docs/MONOREPO.md`, `docs/CONTRIBUTING.md`, this file |

### Workspace Roster

```
14 active workspaces (1 root + 13 packages/apps/plugins)
  packages/  config, plugin-sdk, bot-sdk, core, db, i18n, ui   (7)
  apps/      web, desktop, registry                            (3)
  plugins/   hushle, quiz, vampire-village, watch-party        (4)
```

### Fixed — Root Configuration

- `package.json`: added `"type": "module"` (silences `MODULE_TYPELESS_PACKAGE_JSON` warning, lets `eslint.config.js` use ESM syntax).
- `package.json`: added `@types/node@^22.5.0` (resolves `process` global in `packages/config`).
- `package.json`: added `typescript-eslint@^8.7.0` (proper ESLint 9 flat config for TypeScript).
- `package.json`: added a `verify` aggregator script (`typecheck && lint && test`) so `pnpm verify` runs the full gate with one command.
- `eslint.config.js`: rewrote from a stub `[{ ignores: [...] }]` to a real flat config with `tseslint.configs.recommended`, proper `languageOptions.globals`, and custom rule overrides for the test harness.
- `vitest.workspace.ts`: kept (used by future direct `vitest` calls; per-package scripts go through `pnpm -r --if-present`).

### Fixed — Pre-existing Packages

These three packages were already scaffolded but had bugs that prevented `pnpm build`, `pnpm typecheck`, or `pnpm lint` from succeeding.

#### `@lobbyforge/config`
- Added `@types/node` dep (resolves `Cannot find name 'process'` in `src/index.ts:18`).
- Fixed `src/__tests__/config.test.ts:2` — `from '../index'` → `from '../index.js'` (NodeNext requires explicit `.js` suffix on relative ESM imports).

#### `@lobbyforge/plugin-sdk`
- Fixed `src/testing.ts:1` — `from './index'` → `from './index.js'`.
- Fixed `src/testing.ts:108` — dead-branch with `if (currentTimerSeconds === 0 && timerCallback)` after the `currentTimerSeconds > 0` outer check (TS narrowed `timerCallback` to `never`). Simplified by hoisting the inner check and converting `let timerCallback: … = null` (which TS narrowed to `null`) into `const timerCallback: () => Promise<void> = async () => {}` (always callable).
- Fixed `src/__tests__/plugin-sdk.test.ts:23-27` — added explicit type annotations to the mock plugin's `createInitialState` and `handleAction` arrows (was getting `implicit any` errors under strict mode).
- Renamed unused parameters in the test harness from `msg` / `topic` / `data` / `callback` / `question` / `options` / `playerId` to `_msg` / `_topic` / … to satisfy `argsIgnorePattern: '^_'`.

#### `@lobbyforge/bot-sdk`
- Fixed `src/index.ts:55` — `export interface BotClient extends Bot {}` triggers `no-empty-object-type`; replaced with `export type BotClient = Bot`.
- Fixed `src/__tests__/bot-sdk.test.ts:13` — `connect(token: string)` → `connect(_token: string)`.

### Fixed — M3 Sub-orchestrator Scaffolding

A separate sub-orchestrator expanded the M3 packages with full implementations. Those expansions had a few bugs of their own that this pass corrected.

- **`packages/core/src/validation.ts`** — `EmailSchema` was running `.email()` before `.transform(s => s.toLowerCase().trim())`, so `'  TEST@Example.com  '` failed validation. Re-ordered with `.transform(…).pipe(z.string().email(…))` so trimming happens first.
- **`packages/core/package.json`** — added `zod` runtime dep (the new validation schemas import it).
- **`packages/core/src/__tests__/core.test.ts`** + `permissions.test.ts` + `validation.test.ts` — adjusted for the new module structure (the original `core.test.ts` I had written was preserved alongside the M3 additions).
- **`packages/db/src/__tests__/schema.test.ts`** — `users._.name` was the Drizzle `< 0.31` API; switched to `getTableName(users)` which is the Drizzle 0.31 API installed by the sub-orchestrator.
- **`packages/db`** — added `drizzle-orm@^0.31.0`, `postgres@^3.4.4`, `drizzle-kit@^0.22.0` deps and `db:generate` / `db:push` scripts (Drizzle-driven schema migrations).
- **`packages/i18n/src/locales.ts`** — dropped `import type EnType from '../locales/en.json'` (TS wasn't resolving the JSON through the package's `exports` field with the `import type` keyword, surfacing as `'EnType' refers to a value, but is being used as a type`). `TranslationKey` is now `string`.
- **`packages/i18n`** — added `en.json` / `tr.json` language packs, a `validateLocale()` helper, and a `Translator` class with fallback + interpolation.
- **`packages/ui/src/Card.tsx`** — `CardProps` extended `React.HTMLAttributes<HTMLDivElement>` which has `title?: string`; our re-declaration as `title?: React.ReactNode` was a contravariance violation. Fixed with `Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>`.
- **`packages/ui`** — added React 18 + `react-dom` + `clsx` + `lucide-react` + `tailwind-merge` deps, plus `Button`, `Card`, `Modal`, `Tooltip`, `Avatar`, `Spinner` components (and a `components/` re-export alias for compatibility).
- **`packages/ui/src/__tests__/Button.test.tsx`** — added explicit `afterEach(() => cleanup())` so each `getByRole` query doesn't see DOM left over from the previous test.

### Added — M4 Plugin Scaffolding (Hushle, Quiz, Vampire Village, Watch Party)

Each plugin now has:
- `package.json` with `"@lobbyforge/plugin-sdk": "workspace:*"` dep
- `tsconfig.json` extending `@lobbyforge/config/tsconfig.base.json`
- `vitest.config.ts`
- `src/index.ts` exporting a typed `GamePlugin<TState, TAction>` constant with a manifest, `createInitialState`, `handleAction`, and a `renderClient: () => null` stub
- `src/__tests__/<name>.test.ts` exercising the plugin via `createTestHarness` from `@lobbyforge/plugin-sdk/testing`

Specific fixes during integration:
- `plugins/*/src/index.ts` — replaced `import type { …, PluginPermission }` with split imports: `import type { GamePlugin }` + `import { PluginPermission }` (the latter is a runtime const object, not a type).
- `plugins/vampire-village/src/index.ts` — `createInitialState` now reads `ctx.players.list()` and seeds full `VillagePlayer` records (the test was calling `assign-roles` and expecting non-empty `state.players`).

### Added — M5 App Scaffolding (Web, Desktop, Registry)

- Each app has a `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, and one `__tests__/<name>.test.ts`.
- Each app has a placeholder `dev` script (`echo "… dev: … not yet wired in scaffold stage"`) so `pnpm dev` doesn't error in the absence of the real framework wiring.
- Apps depend on `@lobbyforge/core` and (for `web`) `@lobbyforge/i18n` + `@lobbyforge/ui`.

### Cross-Platform Guarantees

- Root scripts use only pnpm-native features (`-r`, `--if-present`, `--parallel`). Verified to run unchanged on Windows PowerShell and on Linux Bash would behave identically.
- No `&&` chain, no `export VAR=val`, no `which` / `head` / `tail` / `sed` in any script.
- Per-package lint glob `src/**/*.ts` works on both Windows and Linux (cmd.exe passes it verbatim to ESLint; bash expands it the same way; ESLint accepts both).
- ESM relative imports use the explicit `.js` suffix that NodeNext requires.
- `.gitattributes` enforces LF for source, CRLF for `.bat`/`.cmd`/`.ps1`.
- `.editorconfig` mirrors the same rule.

### Documentation

- `docs/MONOREPO.md` — layout, cross-platform script rules, ESM `.js` rationale, dist-vs-source pointer pattern, line-ending policy, "add a new workspace member" recipe.
- `docs/CONTRIBUTING.md` — prerequisites (Node 22+, pnpm 10+), first-time setup, day-to-day commands, where things live, cross-platform rules of thumb.
- `docs/VERIFICATION_REPORT.md` — concrete numbers for the final state of this pass.
- `docs/CROSS_PLATFORM_NOTES.md` — detailed rationale for each cross-platform decision (line endings, glob, paths, scripts).
- `docs/CHANGELOG.md` — this file.

### CI

- `.github/workflows/ci.yml` — runs the full `pnpm install → typecheck → lint → test → build` chain on both `ubuntu-latest` and `windows-latest` to lock in cross-platform support.

### Out of Scope (intentionally deferred)

- Real `next dev` / `electron .` wiring — apps are scaffolding, not implementations. The next milestone (M8 or later, per `projectdetails/21_ROADMAP.md`) replaces these placeholders.
- Installer shell script (`projectdetails/05_INSTALLER_ONE_COMMAND.md`) — needs design discussion about target OS matrix.
- Public registry backend (`projectdetails/10_PUBLIC_DIRECTORY_REGISTRY.md`) — apps/registry currently just exposes a typed in-memory `createServerEntry` helper; the real backend + `createDb` integration is for a later pass.
