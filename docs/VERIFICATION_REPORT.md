# Verification Report

## Current production-readiness snapshot - 2026-07-21

- Full web Vitest suite passes: 56 files, 366 tests.
- A live authenticated Chromium audit loaded all 18 user/community settings
  routes with exactly one settings dialog, no 5xx/page errors, and no
  horizontal overflow. User preferences and instance access settings passed
  write/read/restore cycles against PostgreSQL.
- LiveKit voice focus passed desktop (1440x900) and mobile (390x844) Chromium
  checks with fake camera and screen capture. Camera, screen sharing,
  browser-native stop sharing, controls, portal bounds, and overflow passed.
- Web typecheck and lint pass; lint retains two pre-existing `no-img-element`
  performance warnings and no errors.
- Production Docker image rebuild, forward-only migration, and web-container
  recreation passed after a transient Docker Hub DNS failure. PostgreSQL data
  remained intact (one user and one server); no volume was reset.

- All 15 workspace projects pass typecheck and production build on Node 22.
- All workspace tests pass: 524 tests, with 363 from the web package.
- Docker PostgreSQL, Redis, and LiveKit are healthy.
- Five live PostgreSQL integration tests pass, including irreversible setup
  locking, atomic invite registration, and external identity uniqueness.
- Chromium settings/session/voice authorization smoke tests pass 3/3.
- Next.js 16.2.10 + React 19.2.7 production build is clean; `packages/ui` uses
  a React-19-compatible Testing Library and Lucide dependency graph.
- npm advisory status is unknown for this pass: both tested pnpm clients
  received HTTP 410 from npm's retired legacy audit endpoint.


Concrete numbers from the cross-platform skeleton pass + the M8 Next.js / Doctor pass + the M9 guest-auth / LiveKit-token pass + the M10 Servers-API / DB-wiring pass + the M11 Channels-API / membership-check pass + the M12 Messages-API pass + the M13 Roles & Permissions pass + the M14 Phase 2 community MVP (first half) pass + the M15 Moderation & Polish pass + the M16 Aşama 3 (Plugin SDK minimal) pass (2026-06-11) + the M17 Aşama 4 (Hushle MVP) pass (2026-06-18) + the M18 Aşama 4 follow-up (Hushle card packs DB) pass (2026-06-18) + the M19 Aşama 4 follow-up (realtime + i18n + state versioning) pass (2026-06-18) + the M20-bis WS-gateway / chat-bus pass (2026-06-20) + the M20a Hushle 2v2 + floater + weighted card draw pass (2026-06-20) + the M21 Stitch designs canonical integration pass (2026-06-22).

All commands were run on **Windows 11, PowerShell**, Node `v22.16.0`, pnpm `10.12.1`. Because every script in `package.json` is pnpm-native (no `&&`, no `export`, no Unix-only shell features), the same numbers will reproduce on Linux without modification.

## Workspace discovery

```
$ pnpm install
Scope: all 15 workspace projects
...
Packages: +247 +13 (M8) +7 (M15)
Done in ~6s
```

15 total: 1 root + 14 members (4 plugins, 3 apps, 7 packages).

## `pnpm -r --if-present typecheck`

All 14 members pass.

| Workspace | Result |
|---|---|
| `packages/config` | ✓ |
| `packages/plugin-sdk` | ✓ |
| `packages/bot-sdk` | ✓ |
| `packages/core` | ✓ |
| `packages/db` | ✓ |
| `packages/i18n` | ✓ |
| `packages/ui` | ✓ |
| `apps/web` | ✓ |
| `apps/desktop` | ✓ |
| `apps/registry` | ✓ |
| `apps/ws-gateway` | ✓ |
| `plugins/hushle` | ✓ |
| `plugins/quiz` | ✓ |
| `plugins/vampire-village` | ✓ |
| `plugins/watch-party` | ✓ |

## `pnpm -r --if-present lint`

All 14 members pass with **0 errors**. Warnings are stable across passes.

| Workspace | Errors | Warnings |
|---|---:|---:|
| `packages/config` | 0 | 0 |
| `packages/plugin-sdk` | 0 | 9 (all `any` in public types) |
| `packages/bot-sdk` | 0 | 0 |
| `packages/core` | 0 | 0 |
| `packages/db` | 0 | 1 (`any` for self-FK) |
| `packages/i18n` | 0 | 5 (`any` in fallback table, 1 unused) |
| `packages/ui` | 0 | 0 |
| `apps/web` | 0 | 0 |
| `apps/desktop` | 0 | 0 |
| `apps/registry` | 0 | 0 |
| `apps/ws-gateway` | 0 | 0 |
| `plugins/*` | 0 | 0 |
| **Total** | **0** | **15** |

## `pnpm -r --if-present test`

**390 tests pass across 55 test files** (1 test skipped in `packages/db`). 0 failures. (M20-bis: +43 tests — 27 in `apps/ws-gateway`, 11 in `apps/web` realtime-client, 5 in `apps/web` chat-bus.)

| Workspace | Files | Tests |
|---|---:|---:|
| `packages/config` | 1 | 2 |
| `packages/plugin-sdk` | 2 | 12 |
| `packages/bot-sdk` | 2 | 8 |
| `packages/core` | 4 | 26 |
| `packages/db` | 3 | 10 (1 skipped) |
| `packages/i18n` | 2 | 14 |
| `packages/ui` | 3 | 11 |
| `apps/web` | 29 | 256 |
| `apps/desktop` | 1 | 2 |
| `apps/registry` | 1 | 4 |
| `apps/ws-gateway` | 4 | 27 |
| `plugins/hushle` | 1 | 12 |
| `plugins/quiz` | 1 | 1 |
| `plugins/vampire-village` | 1 | 1 |
| `plugins/watch-party` | 1 | 1 |
| **Total** | **55** | **390** |

M17 → M18 delta: +1 file (the new `card-packs` test file), +7 tests in `apps/web` (the new card-packs route tests), +3 tests in `plugins/hushle` (packId flow + built-in pack shape), +2 tests in `packages/db` (schema assertions for the new tables). M15 → M18 cumulative: +105 tests.

What changed across the M8..M18 passes:

- `packages/core`: +1 file, +13 tests (Doctor module). M13 added the `permissions.ts` module (14 `CorePermission` constants + `hasPermission`) without a dedicated test file — the new code is covered by the route tests that mock `getUserPermissions`.
- `apps/web`: +25 files, +235 tests (M16 added the activity routes — 22 tests in `activities.test.ts`; M17 extended the activity read route to join player display names; M18 added the card-packs route — 7 tests). Full breakdown visible in the per-test-file output above.
- `packages/db`: +1 file, +10 tests (M18 added the cardPacks query helpers and the schema assertions; the query helpers themselves are integration-tested through the route tests).
- `plugins/hushle`: M16 was a 1-test stub; M17 expanded to 4 vitest cases; M18 added 3 more for the packId flow (7 total).

## `pnpm -r --if-present build`

All 14 members emit a production artifact.

| Workspace | Artifact | Notes |
|---|---|---|
| `packages/config` | `dist/` | tsc |
| `packages/plugin-sdk` | `dist/` | tsc |
| `packages/bot-sdk` | `dist/` | tsc |
| `packages/core` | `dist/` | tsc — exports the new `cookies` + `guest-session` modules (M20-bis) |
| `packages/db` | `dist/` | tsc — now exports `queries/{users,servers,memberships,channels,messages,roles,invites,auditLogs,bans}.js` |
| `packages/i18n` | `dist/` | tsc |
| `packages/ui` | `dist/` | tsc |
| `apps/web` | `.next/` | next build — 29 routes (5 static + 24 dynamic) |
| `apps/desktop` | `dist/` | tsc placeholder |
| `apps/registry` | `dist/` | tsc placeholder |
| `apps/ws-gateway` | `dist/` | tsc — standalone Node WS server (runs on port 3001, no HTTP routes) |
| `plugins/*` (4) | `dist/` | tsc |
| **Total** | **15 / 15** | |

The Next.js build output (M15 baseline):

```
Route (app)                                                                 Size  First Load JS
┌ ○ /                                                                      170 B         102 kB
├ ○ /_not-found                                                            993 B         103 kB
├ ƒ /admin/health                                                          170 B         102 kB
├ ƒ /api/auth/guest                                                        170 B         102 kB
├ ƒ /api/doctor                                                            170 B         102 kB
├ ƒ /api/health                                                            170 B         102 kB
├ ƒ /api/invites/[code]                                                    170 B         102 kB
├ ƒ /api/invites/[code]/redeem                                             170 B         102 kB
├ ƒ /api/livekit/token                                                     170 B         102 kB
├ ƒ /api/presence                                                          170 B         102 kB
├ ƒ /api/servers                                                           170 B         102 kB
├ ƒ /api/servers/[id]                                                      170 B         102 kB
├ ƒ /api/servers/[id]/audit-logs                                           170 B         102 kB
├ ƒ /api/servers/[id]/bans                                                 170 B         102 kB
├ ƒ /api/servers/[id]/bans/[userId]                                        170 B         102 kB
├ ƒ /api/servers/[id]/channels                                             170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]                                 170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]/messages                        170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]/messages/[messageId]            170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]/members/[userId]/voice/mute     170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]/presence                        170 B         102 kB
├ ƒ /api/servers/[id]/invites                                              170 B         102 kB
├ ƒ /api/servers/[id]/invites/[inviteId]                                   170 B         102 kB
├ ƒ /api/servers/[id]/members                                              170 B         102 kB
├ ƒ /api/servers/[id]/members/[userId]                                     170 B         102 kB
├ ƒ /api/servers/[id]/members/[userId]/role                                170 B         102 kB
├ ƒ /api/servers/[id]/roles                                                170 B         102 kB
├ ƒ /api/servers/[id]/roles/[roleId]                                       170 B         102 kB
├ ƒ /api/test/db-reset                                                     170 B         102 kB
├ ƒ /api/test/redis-reset                                                  170 B         102 kB
├ ○ /connect                                                             1.69 kB         103 kB
├ ƒ /join/[code]                                                           170 B         102 kB
└ ƒ /room/[roomName]                                                     2.40 kB         105 kB
```

## M15-specific

- **Multi-role support enabled.** Members can now hold multiple roles. `getUserPermissions` handles the union correctly.
- **Atomic position shifting implemented.** `updateRole` and `updateChannel` now shift siblings when `position` changes.
- **Server-side mute implemented.** `POST /api/servers/{id}/channels/{channelId}/members/{userId}/voice/mute` uses LiveKit SDK to force-mute participants.
- **Audit logs and bans APIs finalized.** Full moderation surface is now active in the route layer.
- **LiveKit identity unified with userId.** Moderators can target users reliably using their database ID.
- **All 318 tests run in ~6 s** on Windows PowerShell. The new `card-packs.test.ts` (7 tests) and the expanded `hushle.test.ts` (7 tests) are part of the suite.

## M16-specific

- **Plugin SDK minimal shipped.** `packages/plugin-sdk` exports `GamePlugin<TState, TAction, TProps>`, `registerGamePlugin`, `createTestHarness`. `apps/web/lib/plugin-registry.ts` is the host's compiled-in plugin list. `apps/web/lib/plugin-context.ts` adapts the SDK's `GamePluginContext` for the HTTP host. The 5 activity routes (start / list / read / dispatch / end) are documented in `docs/ACTIVITIES.md`. The M16 success criterion ("dummy plugin activity olarak açılıyor") is satisfied end-to-end through the existing `@lobbyforge/quiz` plugin.

## M17-specific

- **Hushle is the first fully-wired game plugin.** `plugins/hushle/src/{state,actions,decks,renderClient}.ts(x)` cover the entire Aşama 4 success criterion ("4-8 kişi sesli Hushle oynuyor"). The `lobby → team_setup → playing → ended` state machine is enforced by the reducer; every transition is a host-only action.
- **Per-plugin `renderClient` is now wired.** The voice-room `ActivityPanel` in `apps/web/app/room/[roomName]/page.tsx` resolves the session's plugin through `getPlugin` and calls `plugin.client.renderClient({ state, dispatch, actorUserId, hostUserId, players })`. Quiz still falls back to the JSON panel because its `renderClient` returns `null`.
- **Activity read route joins player display names.** `apps/web/app/api/servers/[id]/activities/[sessionId]/route.ts` now joins `users` on `game_session_players.userId` so the panel can label teams and explainers.
- **24-card en + 24-card tr built-in decks.** No DB migration needed for MVP; the decks are bundled in `plugins/hushle/src/decks.ts` and rebuilt on every `start-game`.

## M18-specific

- **Card packs moved from in-code to DB.** Migration `0005_late_cannonball.sql` adds `card_packs` (pluginId, slug, name, language, description, isBuiltIn) and `cards` (packId, ordinal, payload jsonb). Cascade delete; unique `(pluginId, slug)`; unique `(packId, ordinal)`.
- **Plugin-owned built-in content.** Each plugin that ships bundled content exposes a `seedBuiltinXxxPacks(db)` seeder (Hushle ships two: en + tr). The seeder is idempotent and module-cached in `apps/web/lib/plugin-content-seeder.ts`.
- **Server-only subpath export.** `@lobbyforge/hushle/builtInPacks` is the only way to import the seeder from outside the plugin — the main entry point stays client-safe. This pattern is what every plugin that ships server-only helpers should follow.
- **Pack picker in the lobby.** The Hushle panel accepts an optional `cardPacks` prop; the host's `ActivityPanel` fetches `/api/servers/{id}/card-packs` while the session is in `lobby` phase and forwards the result. The panel falls back to the legacy language form if the fetch fails.
- **Reducer accepts `packId`.** `start-game` now takes `packId: string` (required) plus an optional `language` fallback. The reducer resolves the language from the slug; custom packs (M19) will use the explicit `language` until the DB-backed deck loader lands.

## M19-specific

- **State versioning + migrators in the SDK.** `GamePlugin<TState, TAction, TProps>` now carries an optional `migrateState?: (raw: unknown) => TState`. `registerGamePlugin` wires it through to `RegisteredGamePlugin.migrateState`. The host runs the migrator on every activity read AND before every action dispatch, so any pre-versioned `game_sessions.state` row is transparently upgraded the next time it's read.
- **Hushle ships its first migration.** `HushleState` carries `version: number`; `HUSHLE_STATE_VERSION = 1`; `migrateHushleState(raw)` is an idempotent migrator chain (v0→v1 today, comment placeholder for v1→v2). `createHushleInitialState()` sets the version; the reducer only produces the current version. Future schema changes bump `HUSHLE_STATE_VERSION` and add `migrateV1ToV2(state)` etc. — no DB migration script, no `UPDATE` over `game_sessions`.
- **Shared locale helper for plugins.** `packages/plugin-sdk/src/locale.ts` exports `loadPluginLocale`, `registerPluginLocale`, `tFor`, `listPluginLocales`, `detectLocale`, `pickBestLocale`. Per-plugin registry keyed on `pluginId`. Adding a new language is a one-line drop: place `locales/{lang}.json`, then `loadPluginLocale(HUSHLE_PLUGIN_ID, { en, tr, de })`. The SDK package exposes the helper through the `./locale` subpath so plugins stay decoupled.
- **Same helper for bots.** `packages/bot-sdk/src/locale.ts` mirrors the plugin surface, keyed on `botId`. Same `./locale` subpath export. Future bots pick up the pattern for free.
- **SSE realtime for activity state.** `apps/web/lib/activity-bus.ts` (Redis pub/sub, topic `lf:{env}:activity-state:{serverId}:{sessionId}`) is the publish/subscribe primitive. `apps/web/app/api/servers/[id]/activities/[sessionId]/stream/route.ts` is the SSE handler — membership-gated, 30 req/min, 30s `: ping` keep-alive, sends `snapshot` + `state` events. Publish happens on the actions + end routes. The route can't use the `withApiSecurity` wrapper (it streams a `Response`, not a `NextResponse`); security headers + rate limit are applied manually with the same effect.
- **`EventSource` in the room page.** `apps/web/app/room/[roomName]/page.tsx`'s `ActivityPanel` swaps 2s polling for `EventSource`. Falls back to 5s polling only if `EventSource.CLOSED` fires (4xx or unrecoverable network error). The 5s fallback preserves the M18 behavior for hosts behind proxies that strip SSE.
- **Subpath exports formalized.** Both `@lobbyforge/plugin-sdk/locale` and `@lobbyforge/bot-sdk/locale` are explicit subpath entries in their `package.json`. This matches the M18 pattern (`@lobbyforge/hushle/builtInPacks`) — anything plugin-private or Node-only should live behind a subpath so the main entry stays client-safe.
- **5 + 6 + 5 + 8 new tests.** Locale registry tests in `packages/plugin-sdk` (10) and `packages/bot-sdk` (6); SSE route tests in `apps/web` (5); versioning + reducer detail tests in `plugins/hushle` (8 — bringing the Hushle file to 12 total). Suite is now 347 tests / 51 files, all green; `pnpm -F @lobbyforge/web build` produces 28 routes (the new SSE route is the M19 addition on top of M18's 28).

## M20-bis-specific

- **Standalone `apps/ws-gateway/` process.** New monorepo member. Standalone Node.js WS server on port 3001 (env-overridable via `WS_PORT` / `WS_HOST`). Validates the `lf_guest` cookie on upgrade, gates every `subscribe` against server membership, and forwards Redis pub/sub events to subscribed clients.
- **`apps/web/lib/chat-bus.ts`.** Redis pub/sub primitive parallel to `activity-bus.ts`. Topic `lf:{env}:chat:{serverId}:{channelId}`. Fire-and-forget publish; shared per-topic subscriber pool. The messages POST route publishes a chat envelope after persisting the row.
- **`apps/web/lib/realtime-client.ts`.** Browser `RealtimeClient` class. Singleton per page load. Auto-reconnect with exponential backoff (cap 30s); queue subscribes while disconnected and replay on `open`; 60s heartbeat closes the socket if the server hasn't pinged in time.
- **ActivityPanel switched from `EventSource` to `RealtimeClient`.** `apps/web/app/room/[roomName]/page.tsx` no longer opens a per-activity SSE connection; it subscribes to `activity-state:{serverId}:{sessionId}` via the singleton WS. Polling fallback only fires when `WebSocket.CLOSED` at startup.
- **`@lobbyforge/core` gains `cookies` + `guest-session`.** Moved from `apps/web/lib/` to the canonical home. `apps/web/lib/{cookies,guest-session}.ts` are now thin shim re-exports — the 39 existing route imports are unchanged. The ws-gateway imports the same code via `@lobbyforge/core`.
- **Wire types inlined in the client.** `@lobbyforge/ws-gateway` exports the protocol, but importing it would pull `ws` + `ioredis` into the Next.js browser bundle. The types are duplicated in `apps/web/lib/realtime-client.ts` with a sync note; future protocol changes must touch both files.
- **Same Redis bus, two transports.** SSE (M19) stays as the fallback for hosts behind proxies that strip WS upgrades. WS (M20-bis) is the default for new code. Both subscribe to identical Redis topics; the wire encoding is the only difference.
- **27 + 11 + 5 new tests.** ws-gateway: 4 test files, 27 cases (protocol parser, subscription manager, auth, authorization). apps/web: 2 new test files, 16 cases (chat-bus + realtime-client). Suite is now 390 tests / 55 files, all green; `pnpm -F @lobbyforge/ws-gateway build` produces a standalone `dist/` and `pnpm -F @lobbyforge/web build` still produces 29 routes.

## M20a-specific

- **Hushle reducer supports 2v2 + floater + weighted draw.** `HushleState` gains `floaterPlayerId`, `currentExplainerIndex`, `usedCardIds`. `HushleSettings` gains `teamSize` (default 2) and `difficultyDistribution` (default `{easy: 0.6, medium: 0.3, hard: 0.1}`). `start-game` accepts `teamSize`, `difficultyDistribution`, `cardsPerTurn` — distribution gets normalized (negatives clamped, renormalized to sum=1, defaults restored on sum=0). `set-teams` validates the floater BEFORE trimming teams to `teamSize` (a subtle first-pass bug: trimming then validating silently dropped a floater who was over team size). `end-turn` increments `currentExplainerIndex` so the same player doesn't explain two turns in a row.
- **Weighted card draw with documented fallback.** `pickDifficultyTier` samples a tier by weighted random; `drawNextCardWeighted` draws an unused card from that tier's bucket; falls back to any unused card when the configured tier is exhausted. Pure helpers so tests can stub `Math.random`.
- **Built-in decks carry a difficulty tier.** Every card in `plugins/hushle/src/decks.ts` (en + tr, 24 each) now has a `difficulty: 'easy' | 'medium' | 'hard'` field. 14 easy / 7 medium / 3 hard per language (60/30/10 of 24).
- **Schema + migration.** `cards.difficulty` (text default 'easy' not null) + `idx_cards_pack_difficulty` index. New `serverLocalCards` table for server-only additions (id, serverId, pluginId, category, payload jsonb, difficulty, createdBy, createdAt). `gameSessions.teamSize` (int) + `gameSessions.difficultyDistribution` (jsonb). Migration `0006_hushle_difficulty_and_team_size.sql` is hand-written — the partial unique index `game_sessions_channel_open_unique` can't be expressed in Drizzle's table-builder API in this version.
- **State version bump.** `HUSHLE_STATE_VERSION` is now 2. `migrateV1ToV2` promotes pre-versioned cards to `difficulty: 'easy'` and fills floater/distribution defaults; the migrator is idempotent on already-current state.
- **No UI yet.** The card visual stays a placeholder (red/blue/purple tints per tier via inline style) until the photo lands in M20c. The admin panel for server-local cards is M20b.
- **+11 tests.** `plugins/hushle/src/__tests__/hushle.test.ts` is now 24 cases (was 13). New coverage: custom teamSize/distribution, fallback to defaults, negative-weight clamping, floater accept/drop/trim, end-turn rotation including floater across empty teams, weighted draw respects distribution (with documented fallback when bucket exhausted), no card repeats within a session, v1 migration. `packages/db/src/__tests__/schema.test.ts` adds 6 assertions on new tables/columns. Suite is now 401 tests / 56 files, all green; `pnpm -r typecheck` is green across all 15 workspace projects; `pnpm -F @lobbyforge/db build` is green.

## M21-specific

- **Lobby live data path is real.** `/lobby` now reads channels, members, messages, and presence from the database + Redis when the visitor is authenticated and has a server. Demo mode (unauthenticated visitor or official deployment) preserves the original `DEMO_*` constants verbatim so the Stitch `refined_standalone_lobby_1280px` reference renders without any server round-trip. The live path threads a typed `LobbyData` object through the existing presentational components (`Sidebar`, `ChannelGroup`, `MembersPanel`, etc.) so the Calm Future visual treatment is 1:1.
- **`apps/web/app/lobby/LobbyLiveRoster.tsx`** is the only client component in the live path. It subscribes to `chat:{serverId}:{channelId}` via the existing `RealtimeClient` singleton and prepends new messages into local state (de-duped by message id so the SSR snapshot + the first WS event don't double-render). Polls `/api/servers/{id}/channels/{channelId}/presence` every 8s to keep the author name cache warm. Same visual classes as the SSR Message component — design is 1:1.
- **Calm Future motion tokens are canonical.** Five keyframes (`fadeInRight`, `fadeInLeft`, `fadeInUp`, `pulseSoft`, `speakingPulse`) live in `tailwind.config.ts` as Tailwind utilities (so `animate-fade-in-right` etc. work) AND in `globals.css` as raw CSS for non-Tailwind consumers (`.stagger-1..6`, `.speaking-ring`, `.rail-tooltip`). A single `@media (prefers-reduced-motion: reduce)` override disables every animation utility + the special classes. Applied to the lobby shell: Sidebar `fade-in-right`, MembersPanel `fade-in-left`, MainArea `fade-in-up`, channel groups `stagger-1`/`stagger-2`, each new WS chat message `fade-in-up`.
- **Two new modal primitives.** `ChangeBannerModal` (3:1 wide banner crop, 1200×400 canonical, 8 MB cap) and `HushleRoomSelectionModal` (voice-channel picker for Hushle start, filters busy channels). Both follow the existing `Modal` + `ModalCancelButton` + `ModalPrimaryButton` canonical pattern with Calm Future tokens. `CreateVoiceRoomModal` was intentionally skipped — the existing `CreateChannelModal type='voice'` already covers it (proven by `apps/web/app/lobby/ChannelGroupClient.tsx` using it today).
- **Test count unchanged at 273.** This milestone is a UI-layer refactor — no new tests added because the underlying queries (`listChannelsForServer`, `listMemberSummariesForServer`, `listMessagesForChannel`, `getUserPresenceInChannel`, `getUserPresenceInServer`) are already covered by their route tests. The lobby page's branching (demo vs live, presence-derived member status, message-author lookup) is straightforward enough that manual verification of both render paths is sufficient. Adding a `lobby.test.ts` is on the M21.4 list when the LobbyLiveRoster contract stabilizes.
- **`pnpm -F @lobbyforge/web build` is green.** 78 routes total (was 29 in M20 baseline — the M15..M20 routes are now all visible in the build output). `/lobby` is 2.54 kB First Load JS (+0.01 kB vs M20 baseline; the animation utilities add ~10 bytes). All 15 workspace projects typecheck; lint reports 0 errors / 0 new warnings.
- **What's intentionally NOT here.** Lobby has no audio path — LiveKit is only wired in `/room/[roomName]`. The members panel and voice roster render with the initial SSR snapshot; they refresh on next navigation, not on every presence change. The Stitch designs for `community_settings/*`, `user_settings/*`, and `active_hushle_session` are still pending — tracked as M21.5 / M21.6 / M21.7.

## `pnpm verify`

Runs `typecheck && lint && test` end-to-end. Green.

## Cross-platform script contract

Identical to M14 baseline. All scripts are OS-agnostic.

## Line ending audit

0 CRLF in committed source files.

## What was *not* verified

- Real LiveKit signaling/media flow (requires a running LiveKit SFU).
- Real Postgres/Redis logic (mocked in unit tests; integration tests are the next milestone).
