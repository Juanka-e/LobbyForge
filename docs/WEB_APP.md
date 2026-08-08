# `apps/web` — Next.js 15 App Router

`apps/web` is the main LobbyForge web application. It is a Next.js 15 App Router project that ships the public landing page, the admin System Health view, the guest auth + LiveKit token flow, the Phase 2 servers + channels + messages + roles API, and the M16 activity host (the plugin SDK's HTTP runtime).

This document complements [`docs/MONOREPO.md`](./MONOREPO.md) (which covers the workspace), [`docs/DOCTOR.md`](./DOCTOR.md) (which covers the Doctor subsystem), [`docs/GUEST_AUTH.md`](./GUEST_AUTH.md) (cookie format + Phase 1 endpoints), [`docs/SERVERS.md`](./SERVERS.md) (the Phase 2 server endpoints), [`docs/CHANNELS.md`](./CHANNELS.md) (the Phase 2 channel endpoints), [`docs/MESSAGES.md`](./MESSAGES.md) (the Phase 2 message endpoints), [`docs/ROLES.md`](./ROLES.md) (the Phase 2 roles + permissions surface), [`docs/ACTIVITIES.md`](./ACTIVITIES.md) (the M16 plugin host), [`docs/PLUGIN_SDK.md`](./PLUGIN_SDK.md) (the plugin contract), and [`docs/UPDATES.md`](./UPDATES.md) (the self-host update planner).

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js 15.5 (App Router) | React Server Components, server actions, `typedRoutes` |
| UI primitives | `@lobbyforge/ui` | Local package, transpiled by Next via `transpilePackages` |
| i18n | `@lobbyforge/i18n` | The standalone `t()` helper is used in client islands; full Next.js i18n routing is a later milestone |
| Domain | `@lobbyforge/core` | Health + Doctor + roles + permissions + validation |
| Data | `@lobbyforge/db` | Drizzle 0.45.2 + `postgres.js`; thin query helpers keep values parameterized and out of SQL structure |
| Styling | Inline CSS (this pass) | Tailwind is in `@lobbyforge/ui` and will be wired in once a design system lands |
| Linting | Root ESLint flat config + app-local re-export | `@next/eslint-plugin-next` runs for App Router files alongside `typescript-eslint` |
| Tests | Vitest (server-only) | Component tests will be added with `@testing-library/react` once UI islands exist |

## Layout

```
apps/web/
├── next.config.mjs          # transpilePackages, typedRoutes
├── tsconfig.json            # extends @lobbyforge/config/tsconfig.base.json
│                            # (overrides moduleResolution to "Bundler" — see below)
├── vitest.config.ts         # @/ path alias, includes lib/__tests__/**
│                            # and app/api/**/__tests__/**
├── package.json
└── src/
    ├── index.ts             # APP_NAME, APP_VERSION, ROUTES, findRouteByPath
    └── __tests__/
        └── web.test.ts      # smoke tests for the metadata exports
└── app/
    ├── layout.tsx           # <html>, header, nav
    ├── page.tsx             # home — lists ROUTES from @lobbyforge/web
    ├── connect/page.tsx     # guest + LiveKit-token demo (developer surface since M14)
    ├── join/[code]/page.tsx # invite-redeem landing (M14)
    ├── room/[roomName]/page.tsx  # voice-room UI, livekit-client (M14)
    ├── admin/health/page.tsx  # server component, renders DoctorReport
    └── api/
        ├── health/route.ts            # GET, buildHealthStatus, 120 req/min
        ├── doctor/route.ts            # GET, collectDoctorReport, 12 req/min
        ├── auth/guest/route.ts         # POST mints a guest, GET probes the lf_guest cookie
        ├── livekit/token/route.ts      # POST exchanges the cookie for a LiveKit JWT
        ├── plugins/route.ts            # GET compiled-in app catalog summaries
        ├── presence/route.ts           # POST + GET ?serverId=…, Redis-backed presence
        ├── test/db-reset/route.ts      # POST truncates DB (test-only, NODE_ENV guard)
        ├── test/redis-reset/route.ts   # POST flushes Redis (test-only, NODE_ENV guard)
        ├── invites/[code]/route.ts              # GET public metadata (M14)
        ├── invites/[code]/redeem/route.ts       # POST redeem, 30 req/min (M14)
        └── servers/
            ├── route.ts                # GET list, POST create, 60/10 req/min
            ├── [id]/route.ts           # GET single (member-or-owner since M11), 60 req/min
            ├── [id]/access-policy/route.ts # GET/PATCH server access + auth policy
            ├── [id]/apps/route.ts      # GET/POST/DELETE installed apps for this server
            ├── [id]/bots/route.ts      # GET server bots + UI badge metadata
            ├── [id]/channels/
            │   ├── route.ts                          # GET list, POST create, 60/10 req/min
            │   ├── [channelId]/route.ts              # GET / PATCH / DELETE single, 60/30/10 req/min
            │   ├── [channelId]/messages/
            │   │   ├── route.ts                      # GET list, POST create, 60/30 req/min
            │   │   ├── [messageId]/route.ts          # GET / PATCH / DELETE single, 60/30/10 req/min
            │   │   └── __tests__/messages.test.ts
            │   ├── [channelId]/presence/route.ts     # GET channel-scoped presence (M14)
            │   └── __tests__/channels.test.ts
            ├── [id]/invites/
            │   ├── route.ts                          # GET list, POST create, 60/10 req/min (M14)
            │   └── [inviteId]/route.ts               # DELETE revoke, 10 req/min (M14)
            ├── [id]/roles/
            │   ├── route.ts                          # GET list, POST create, 60/10 req/min (M13)
            │   ├── [roleId]/route.ts                 # GET / PATCH / DELETE single, 60/30/10 req/min (M13)
            │   └── __tests__/roles.test.ts           # 15 tests (M14)
            └── [id]/members/
                ├── route.ts                          # GET list, 60 req/min (M13)
                ├── [userId]/route.ts                 # DELETE kick, 20 req/min (M13)
                ├── [userId]/role/route.ts            # PUT assign role, 20 req/min (M13)
                └── __tests__/members.test.ts         # 13 tests (M14)
            └── __tests__/servers.test.ts
└── lib/
    ├── doctor.ts            # collectSystemStats, collectDoctorReport, buildChecksFromStats
    ├── security-headers.ts  # withApiSecurity, inMemoryRateLimit (now generic over TContext)
    ├── cookies.ts           # HMAC-signed cookie helpers (lf_guest wire format)
    ├── guest-session.ts     # createGuestIdentity, build/read guest session cookies (uid in payload)
    ├── livekit.ts           # issueLiveKitToken (jose-backed HS256 JWT)
    ├── permissions.ts       # authorizeServerPermission (M13)
    ├── db.ts                # getDb() singleton (globalThis-stashed) + __setDbForTests hook
    ├── redis.ts             # ioredis singleton + set/get user presence (server + channel)
    └── __tests__/
        ├── doctor.test.ts
        ├── security-headers.test.ts
        ├── cookies.test.ts
        ├── guest-session.test.ts
        ├── livekit.test.ts
        └── db.test.ts
```

See [`docs/GUEST_AUTH.md`](./GUEST_AUTH.md) for the cookie format, the auth endpoints, the JWT shape, and the `/connect` flow. See [`docs/SERVERS.md`](./SERVERS.md) for the servers API and the DB wiring. See [`docs/CHANNELS.md`](./CHANNELS.md) for the channels API and the membership check. See [`docs/MESSAGES.md`](./MESSAGES.md) for the messages API. See [`docs/ROLES.md`](./ROLES.md) for the roles + permissions surface.

## Why we override `moduleResolution: "Bundler"` here

`packages/config/tsconfig.base.json` sets `module: "NodeNext"` + `moduleResolution: "NodeNext"`, which is correct for *libraries* — it forces explicit `.js` suffixes on relative imports and matches the way Node ESM resolves at runtime.

For the **web app** we override those two to `"ESNext"` + `"Bundler"` so:

- The Next.js App Router can resolve `next/server`, `next/navigation`, etc. cleanly.
- The `paths: { "@/*": ["./*"] }` alias works without the `.js` suffix dance.
- The bundled output (Webpack/Turbopack) handles the resolution at build time.

The override is scoped to `apps/web` only — the packages keep the stricter NodeNext contract. This is documented in `tsconfig.json` itself as a comment so the next reader doesn't undo it.

## Why `@lobbyforge/db` is in `serverExternalPackages`

`@lobbyforge/db` is consumed as a runtime `require()` (not bundled). Its query helpers lean on `postgres.js`, which uses `node:net` internally — exactly the kind of Node-only import that explodes in the edge runtime with `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins`.

`next.config.mjs` declares:

```js
serverExternalPackages: ['@lobbyforge/db'],
```

This tells Next to leave `@lobbyforge/db` as a runtime `require()` instead of bundling it into the edge build. The main entry has no `node:` built-in imports, so this is defense-in-depth — but it keeps a future regression cheap to fix (adding a `node:` import to a query helper will not blow up the build).

## Database migrations

LobbyForge uses two migration layers with different trust boundaries:

- `drizzle-orm/postgres-js/migrator` transitively imports `node:crypto` + `node:path` + `node:url`.
- The `postgres` driver adds `net` + `tls` + `stream` to that list.
- Webpack's edge-bundle resolver cannot follow any of these `node:*` imports, even with `serverExternalPackages: ['drizzle-orm', 'postgres']` set, because the dynamic `await import('postgres')` inside `db-migrate.ts` is still treated as a chunk dependency that needs to resolve at build time.
- The `Module not found: Can't resolve 'net'` error surfaces from `postgres/src/connection.js:1` no matter where the migrator lives (workspace package, subpath export, apps/web local file).

Host schema migrations are a **pre-start deployment step**. They use committed,
journaled SQL and must succeed before the new web process starts:

```sh
# after building @lobbyforge/db, before every production start:
pnpm -F @lobbyforge/db db:migrate
```

Trusted plugin/game/bot/tool **data migrations** run on their first server-side
use after the schema is current. They deliberately do not run from Next
instrumentation because its development webpack target cannot bundle
postgres.js and Node net/tls/crypto modules. The `component_migrations` ledger
records component type, stable id, contiguous
version, SHA-256 checksum and applied time. Each step runs with a PostgreSQL
transaction advisory lock; a failed step is not marked applied, and changing an
already-applied migration fails on checksum mismatch. Community packages never
receive arbitrary SQL execution through this mechanism.

## ESLint

The web app uses the monorepo root `eslint.config.js`. `apps/web/eslint.config.js`
is a tiny re-export so Next-aware linting works whether the command is launched
from the repo root or from `apps/web`.

The web-specific config enables `@next/eslint-plugin-next` recommended and
Core Web Vitals rules with `settings.next.rootDir = "apps/web/"`. The rule
`@next/next/no-html-link-for-pages` is disabled because this app is App Router
only; page-route discovery for the legacy Pages Router would be noise here.

## Security posture

`lib/security-headers.ts` provides a small `withApiSecurity(handler, options)` wrapper used by every route. As of M10 it is generic over a `TContext` argument so dynamic route segments (`[id]`, future `[slug]`, etc.) can pass the Next.js 15 `ctx` through. It applies:

- The four standard security headers (see `DOCTOR.md` for the list).
- A 405 + `Allow` header for any method not in the allowlist.
- An atomic Redis fixed-window rate limit in production, configurable per route.
- Redis-backed session revocation for authenticated cookies. Revoked sessions
  are rejected centrally before route handlers run. Login, guest sign-in and
  first-run setup explicitly bypass this check so a revoked browser can recover.

Local owner credentials are created atomically by `/api/setup/complete` using
scrypt. `/api/auth/login` uses a dummy-hash verification for unknown accounts
to reduce timing-based account discovery. `/api/auth/password` verifies the
current credential, performs an old-hash compare-and-swap update, and revokes
other tracked sessions.

What is **not** there yet:

- **Synchronizer CSRF tokens.** State-changing browser requests already enforce
  same-origin `Origin` checks and session cookies use `SameSite=Lax`; explicit
  CSRF tokens remain planned for cross-origin desktop handoff flows.
- **Proxy configuration.** Client IP headers are ignored unless
  `LOBBYFORGE_TRUSTED_PROXY=x-forwarded-for|cloudflare` is explicitly set for a
  trusted proxy that strips and replaces that header.

The implementation is a self-hosted, no-Supabase adaptation of the `secure-nextjs-api-routes` skill in `.agents/`. We did not import that skill's `lib/csrf-protection.ts` / `lib/rate-limiter.ts` verbatim because they pull in Supabase; the patterns were re-implemented to match the LobbyForge stack.

### Current Security Hardening

The latest security pass added these concrete guards:

- A global CSP denies objects and framing, restricts forms/assets/connections,
  omits `unsafe-eval` in production, and upgrades insecure production requests.
- HSTS, `nosniff`, `DENY`, strict referrer policy, and camera/microphone
  permissions are emitted for every route.
- Production dependencies are pinned to patched Drizzle/PostCSS/esbuild
  versions. On 2026-07-16 both pnpm 10.12.1 and 11.13.0 audit clients received
  HTTP 410 from npm's retired legacy audit endpoint, so this pass does not
  claim a successful advisory result.

- `/api/livekit/token` requires `serverId`, `channelId`, local `uid`, server
  membership, voice/stage channel type, and `CONNECT_VOICE`.
- `/api/presence` validates membership and channel ownership before writing.
- Activity start rejects a second active activity in the same voice/stage
  channel.
- Activity start requires the selected plugin to be installed and enabled for
  the server.
- `/api/servers/{id}/apps` gates app install/configure/delete behind
  `MANAGE_SERVER`.
- `/api/servers/{id}/access-policy` stores the server's join policy,
  official LobbyForge identity behavior, local-account policy, and
  account-linking mode. Updates require `MANAGE_SERVER`.
- Local registration honors an explicitly persisted server access policy
  before password hashing. Invite-only, local-account-disabled, and approval
  policies cannot be bypassed through the instance registration endpoint.
- `/api/servers/{id}/bots` lists server bots for members. The Server
  `bots` tab shows `BOT`, trust, enabled/disabled, token status, and
  declared permissions.
- Activity actions are gated by plugin `actionPolicies`; missing policies are
  host-only by default.
- `withApiSecurity` rate limits by route + caller IP and rejects invalid
  `Origin` headers on state-changing browser requests.
- `/api/doctor` and `/admin/health` require `LOBBYFORGE_ADMIN_TOKEN` in
  production.
- User-created message metadata cannot use reserved system/plugin keys.
- `/api/test/db-reset` and `/api/test/redis-reset` remain `NODE_ENV=test`
  only. When `LOBBYFORGE_TEST_RESET_TOKEN` is set, callers must also send
  `x-lobbyforge-test-token`.

## Settings

## First-run bootstrap

- `/setup` collects the instance name and owner display name, email, and password.
- A PostgreSQL transaction and advisory lock create or repair the owner, first
  server, membership, roles, default channels, and setup state atomically.
- Completion writes `bootstrap_version = 2`. This is an irreversible security
  lock: deleting or corrupting the owner/server does not expose `/setup` again.
  Recovery must happen through authenticated administration or the database.
- Concurrent completion requests are serialized by a per-instance PostgreSQL
  advisory lock; an integration test verifies exactly one request succeeds.
- Legacy installations with an owner but no credentials/server return to
  `/setup`; the existing owner UUID is retained and completed in place.
- Successful setup issues the owner session. Later visits use `/api/auth/login`.
- Production requires `LOBBYFORGE_SETUP_TOKEN`; `pnpm lfctl setup token` creates
  a cryptographically random token without writing it to disk.
- Visible setup fields reject HTML delimiters and control characters. Drizzle
  parameterizes accepted values, including SQL-looking text.

### Canonical settings surface

Settings routes render as one full-viewport modal surface above the lobby.
`admin/layout.tsx` and `settings/layout.tsx` own the shared `SettingsShell`; a
compatibility guard prevents legacy page-level wrappers from creating nested
dialogs while those wrappers are removed incrementally. Server settings use
the same `SettingsModalFrame` around their server-specific navigation.

The interaction contract is fixed:

- one `role="dialog"` with `aria-modal="true"` per settings route;
- an icon-only close button in the top-right corner;
- initial keyboard focus on that close button;
- both the close button and `Escape` replace the current route with `/lobby`;
- the sidebar/header stays fixed while the settings content scrolls.

`e2e/settings-modal.spec.ts` protects this contract in Chromium.

- `/settings` is the first user settings surface. It loads or creates the
  current materialized guest user's `user_settings` row through
  `/api/settings/me`.
- User settings pages use a shared sticky save footer for account-synced and
  browser-local preferences. The footer keeps save/reset actions visible while
  the full-screen settings surface scrolls.
- `/api/settings/me` returns the normalized settings object and currently
  accepts PATCH updates for privacy/activity visibility only.
- `/settings/profile` stores display name, custom status, avatar, and profile
  banner. Avatar and banner uploads are authenticated, rate-limited data URL
  endpoints for this milestone; production storage can replace the persistence
  layer without changing the profile UI contract.
- `/settings/profile` also exposes the current community nickname. Member
  lists, voice rosters, and chat author labels prefer the server nickname over
  the global display name when one is set.
- `/settings/keybinds` persists bounded shortcut data in `user_settings.keybinds`.
  Push-to-talk reads the saved key instead of hard-coding Space; other voice
  actions are modeled up front so future shortcuts can be enabled without a
  schema change.
- `/settings/appearance` stores the account theme through `/api/settings/me`
  and stores accent, density, compact chat, avatar visibility, and empty-channel
  hiding as local browser preferences. `AppearanceRuntime` runs from the root
  layout so these preferences are re-applied on navigation and reload; the page
  also previews changes immediately before save.
- `/admin/settings/members` loads real server membership data and supports
  client-side search, role filtering, and sorting. Server nicknames are shown
  beside global display names so admins can audit identity changes in context.
  The member action drawer can assign multi-role sets, kick members, and ban
  members through the guarded membership/moderation APIs. Owner and self-danger
  actions are disabled in the UI and still rechecked server-side.
- `/admin/settings/channels` is wired to the channels API. Admins can create,
  edit, reorder, and delete channels from the modal surface; every mutation is
  still authorized by the server route's session, membership, rate-limit, and
  `MANAGE_CHANNELS` checks.
- `/admin/settings/roles` is wired to the roles API. Admins can create roles,
  edit name/color/position, toggle known core permissions, and delete
  non-`@everyone` roles. Granting `administrator` shows an explicit client-side
  confirmation, while the server remains the authority for permission checks.
- `/admin/settings/authentication` is wired to instance access settings. It
  exposes open, invite-only, and closed registration modes, guest access, SEO
  indexing, title, and description with a sticky save/reset footer. The PATCH
  endpoint is admin-gated, rate-limited, schema-validated, and body-size
  limited. The page links the first community to its canonical Access policy
  tab for official identity, account linking, and first-join approval.
- `/admin/settings/invites` is wired to the invite APIs. Admins can create,
  search, filter, copy active links, and confirm revocation. Public invite
  metadata and redeem routes accept only the canonical 12-character invite
  alphabet generated by the database helper, then normalize to uppercase
  before lookup.
- `/admin/settings/voice-media` is wired to `server_voice_settings` through
  `/api/servers/{id}/voice-settings`. Mutations require the caller to be a
  server member with `MANAGE_SERVER`, use bounded zod validation, and are
  rate-limited. Camera and screen-share toggles are enforced at LiveKit token
  issuance by narrowing `canPublishSources`.
- `/admin/settings/backups` no longer shows fabricated restore points or
  successful backup status. It verifies the configured backup manifest, checks
  freshness, digest shape, and artifact existence, and reports missing backup
  worker configuration as an explicit warning.
- `/admin/settings/storage` reports real attachment usage by MIME bucket and
  reclaimable bytes. Upload quotas are labeled as not enforced until a real
  quota gate exists; the page no longer invents a placeholder quota number.
- `/admin/audit` loads the authorized community audit trail, resolves actor
  display names, and provides client-side search, category filters, sorting,
  metadata inspection, and CSV export. CSV cells are escaped and formula-like
  values are neutralized before download.
- On self-hosted instances, `/lobby` repairs a missing membership for the
  first community only when the account is the setup owner or the instance is
  in `registration_mode = open` (guest accounts also require guest access).
  Invite-only and closed instances fail closed.
- `/lobby` voice channels render server-wide voice presence, not only the
  locally joined room, so users can see who is already in each channel before
  joining. Clicking the currently connected channel opens the full voice/video
  view instead of disconnecting. Remote LiveKit audio tracks are attached to
  hidden audio elements inside `LobbyVoiceProvider`; without this attachment
  browsers can connect and publish but still not play peer audio.
- `/lobby` member sidebars group members as Online and Offline. Users currently
  in voice remain in the Online group; a separate "In Voice" sidebar section is
  intentionally not part of the canonical lobby.
- Lobby member rows and chat authors open the shared profile popover. The
  block/unblock action uses `/api/settings/me/blocks` and remains server-side
  authoritative; blocked message bodies are masked before they reach the
  client.
- The lobby composer posts text messages through
  `/api/servers/{id}/channels/{channelId}/messages`. Attachment, gift, and GIF
  controls remain disabled until those feature-specific upload/picker flows are
  implemented.
- Privacy defaults are intentionally conservative: profile, online status, and
  activity visibility default to `server_members`; server name in public
  activity text defaults to off.
- The activity switches cover current game, music/listening status, watch
  party status, and whether to include the server name.
- Presence readers apply these settings before returning public snapshots:
  hidden online status becomes `status: "hidden"` and disallowed activity
  kinds are omitted from the response.

## Updates

- `/admin/updates` renders the guarded self-host update plan for admins.
- `/api/admin/updates?action=check|plan` exposes the same planner as JSON.
- `POST /api/admin/updates` supports dry-run, backup verification, and gated
  apply/rollback. Live execution requires both update execution environment
  flags, explicit request confirmation, maintenance mode, a verified signed
  manifest, a verified backup, and an allowlisted no-shell worker plan.

## Voice streams and profiles

- Remote screen shares are opt-in. The LiveKit client connects with
  `autoSubscribe: false`, automatically subscribes to microphone/camera, and
  subscribes to screen-share video/audio only after `Join stream`. Leaving a
  stream unsubscribes both tracks and stops downstream media delivery.
- Community admins set the maximum screen-share resolution and frame rate.
  Members may choose the configured maximum or a lower value; capture
  constraints are clamped client-side to the policy returned with the signed
  room token.
- Voice-only full-screen tiles use a compact fixed layout. Camera and joined
  screen-share tracks retain the responsive stage/filmstrip layout.
- The full-screen call dock groups connection state, microphone, deafen,
  camera, screen share/quality, Voice & Video settings, and disconnect in one
  compact bottom control surface. Opening Voice & Video settings does not leave
  the active room.
- Text-only lobby sessions refresh their Redis presence every 30 seconds; the
  5-second voice heartbeat takes over while connected. Visibility/focus also
  triggers a refresh, so an open lobby does not fall offline after the 90-second
  Redis TTL.
- Camera and screen share are independent media surfaces. A publisher first
  sees a compact local stream preview; joining the stream promotes it to the
  stage. When the same participant also has a camera track, desktop renders the
  two sources side by side and narrow viewports stack them. The participant is
  removed from the auxiliary filmstrip to avoid a third duplicate tile.
- The Voice View participant order is a persisted local preference: default,
  camera first, or alphabetical. Voice-channel member rows expose camera and
  screen-share icons without subscribing the viewer to screen media. Those
  indicators are derived from unmuted, live LiveKit publications and are
  removed after publication teardown completes.
- Disconnect is optimistic and idempotent: it clears the local call UI and
  presence state even if the LiveKit room reference was already lost, then
  finishes transport cleanup when a room still exists.
- Member popovers expose a separate bio, short status, all assigned roles,
  and a local per-participant volume slider while that member is in voice.
- Role icons use a fixed Material Symbols allowlist validated by both Zod and
  a PostgreSQL check constraint. Role color values remain strict six-digit
  hex colors.

## Deployment shell

- Official deployments render the global instance rail and add-community
  entry points.
- Self-host deployments render a single-community shell: the community
  channel sidebar starts at the left edge and official instance switching is
  absent. A desktop client may provide its own native account/instance switcher.

## Local development

```sh
# From the repo root
pnpm install
pnpm -r build                       # rebuild dist-pointer packages (@lobbyforge/core, …)
pnpm --filter @lobbyforge/web dev   # next dev on :3000
```

The web app reads from `infra/docker/docker-compose.dev.yml` for PostgreSQL / Redis / LiveKit. The Doctor HTTP probes target `localhost:<port>` by default; override with `LIVEKIT_URL`, `POSTGRES_URL`, `REDIS_URL`, `NEXT_PUBLIC_BASE_URL` in a `.env.local` if you point at another host.

Required env:

- `LOBBYFORGE_SESSION_SECRET` — HMAC key for the `lf_guest` cookie (32+ chars).
- `DATABASE_URL` — Postgres connection string for `@lobbyforge/db` (default points at the docker-compose dev stack).
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — credentials for the LiveKit token endpoint.

The full env list is in `infra/docker/.env.example`.

`next build` produces:

```
Route (app)                                                         Size  First Load JS
┌ ○ /                                                              170 B         102 kB
├ ○ /_not-found                                                    993 B         103 kB
├ ƒ /admin/health                                                  170 B         102 kB
├ ƒ /api/auth/guest                                                170 B         102 kB
├ ƒ /api/doctor                                                    170 B         102 kB
├ ƒ /api/health                                                    170 B         102 kB
├ ƒ /api/livekit/token                                             170 B         102 kB
├ ƒ /api/presence                                                  170 B         102 kB
├ ƒ /api/servers                                                   170 B         102 kB
├ ƒ /api/servers/[id]                                              170 B         102 kB
├ ƒ /api/servers/[id]/channels                                     170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]                         170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]/messages                170 B         102 kB
├ ƒ /api/servers/[id]/channels/[channelId]/messages/[messageId]    170 B         102 kB
├ ƒ /api/servers/[id]/members                                      170 B         102 kB
├ ƒ /api/servers/[id]/members/[userId]                             170 B         102 kB
├ ƒ /api/servers/[id]/members/[userId]/role                        170 B         102 kB
├ ƒ /api/servers/[id]/roles                                        170 B         102 kB
├ ƒ /api/servers/[id]/roles/[roleId]                               170 B         102 kB
├ ƒ /api/test/db-reset                                             170 B         102 kB
├ ƒ /api/test/redis-reset                                          170 B         102 kB
└ ○ /connect                                                     1.69 kB         103 kB
```

`○` = static, `ƒ` = dynamic (server-rendered on demand).

## What is intentionally not here

- **A custom design system / Tailwind config in apps/web.** Styling is inline for now. Once the design pass lands, `@lobbyforge/ui` will host the tokens and `apps/web` will import them.
- **A live LiveKit room UI.** The Phase 1 success criterion is the two-browser voice test; the `/connect` page stops at token issuance, the SDK `connect()` lands with M11.
- **Messages.** `POST /api/servers/{id}/channels/{channelId}/messages` is **M12 (done)**. The five endpoints landed with M12; reactions, attachments, search, and real-time are the follow-ups.
- **Roles & permissions.** **M13 (done).** The 5 role-management + 3 membership routes are wired; the M11 + M12 mutation routes are gated by `authorizeServerPermission`. Invite-redeem, bans, audit log, role reordering UI, and multiple-roles-per-member are M14.
- **Voice presence.** "Who is in this voice channel" is **M14**. The `app/api/presence/route.ts` stub (user-added) wires the Redis-backed presence layer; the productionization (Redis-backed rate limit, integration with the channel UI) lands with M14's full moderation pass.
- **A production Dockerfile.** Lives under `infra/docker/` and ships in the Installer phase (Phase 5).

These are tracked in [`docs/CHANGELOG.md`](./CHANGELOG.md) under the "Out of Scope" section for the most recent milestone.
