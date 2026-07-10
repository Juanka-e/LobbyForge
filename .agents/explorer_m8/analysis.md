# LobbyForge Workspace Structure Analysis (Core Community MVP)

This report details the structural analysis of the LobbyForge workspace (`d:/livekittest`) and identifies the components, configurations, and dependencies required to support the Core Community MVP features.

---

## 1. Database Package: `@lobbyforge/db`

The database layer uses **Drizzle ORM** with a PostgreSQL driver. It is set up as a clean, stateless package that exports schemas, client initializers, and pre-defined queries.

### A. Schema Analysis (`packages/db/src/schema.ts`)
The schema defines a relational database structure designed for a real-time messaging and voice platform:
- **`users`**: Represents both registered and guest users. 
  - Tracks metadata like `email`, `displayName`, `avatarUrl`, and `locale`.
  - Includes `isGuest` (boolean flag) and `guestKey` (unique index, used for stateless guest tracking).
- **`servers`**: Top-level containers (guilds). Tracks ownership via `ownerUserId` and public visibility with `isPublic`. Supports soft-deletes (`deletedAt`).
- **`channels`**: Represents rooms inside servers.
  - Supports types: `text`, `voice`, `activity`, `announcement`, `stage`.
  - Tracks sorting `position` and references activity plugins via `pluginId`.
- **`memberships`**: Connects `users` to `servers` with unique composite constraints.
- **`messages`**: Contains text channel chat logs, referencing `channels` and `users`, support for nesting/threads via `replyToId`, and message `metadata` JSONB.
- **`roles`**: Models permissions arrays using JSONB columns.
- **`plugins_enabled`**: Map of settings/configurations per plugin in a server.
- **`game_sessions` & `game_session_players` & `plugin_events`**: Tracks state and player statistics for activity plugins.
- **`bots`**: Virtual bot accounts configured per server.
- **`registry_instances` & `instance_settings`**: Support for federated LobbyForge instances.
- **`user_sessions` & `user_settings`**: Session state tracking and user-specific configurations (themes, audio levels, keybinds).
- **`reactions`, `attachments`, `server_bans`, `audit_logs`, `telemetry_snapshots`, `invites`**: Auxiliary tables for core functionality.

### B. Client Connection (`packages/db/src/client.ts`)
- The client connection uses the `postgres` driver (postgres.js).
- `createDb(connectionString)` initiates connection pooling.
- Re-exports common query functions and operators (`sql`, `eq`, `and`, `or`, `desc`, `asc`) to avoid direct dependencies on Drizzle's subpackages in consumer packages.

### C. Queries (`packages/db/src/queries/*`)
State-free database query helpers are grouped into single-purpose modules:
- **`users.ts`**: Handles guest identification/retrieval via `findOrCreateGuestUser` (idempotent unique violation checking).
- **`servers.ts`**: Creates a server and adds the owner's membership in a single database transaction (`createServer`).
- **`memberships.ts`**: Validates server access checking both membership presence and soft-delete statuses.
- **`channels.ts`**: Handles sorting positions (`createChannel` computes the next index via `max(position) + 1`), listing, and updates.

---

## 2. UI Package: `@lobbyforge/ui`

The UI package contains the design system and UI elements.

### A. Exports (`packages/ui/src/index.ts`)
The library aggregates components and exports them from its root:
- **Core Components**: `Button`, `Modal`, `Card`, `Tooltip`, `Avatar`, `Spinner`.
- **Form/Interaction Components**: `TextInput`, `Select`, `Dropdown`, `Toast` (located in the `./components/` subdirectory).
- **Utilities**: `utils.ts` exports shared Tailwind helper classes utilizing `clsx` and `tailwind-merge` to resolve classes without style collisions.

### B. Package Configuration (`packages/ui/package.json`)
- Resolves peer dependencies for `react` and `react-dom` (supporting both React 18 and React 19).
- Main export points directly to ESM build artifact `./dist/index.js`.

---

## 3. Web Application: `apps/web`

A Next.js 15 App Router application configured for node-runtime execution.

### A. Pages & Routes Structure (`apps/web/app/*`)
- **`/` (Home)**: Shows planned application routes.
- **`/connect`**: Client-side sandbox flow verifying Step 1 (getting a guest session cookie via `/api/auth/guest`) and Step 2 (exchanging the session cookie for a LiveKit room access token via `/api/livekit/token`).
- **`/admin/health`**: Real-time diagnostic monitor that renders system capacity specifications.

### B. API Routes (`apps/web/app/api/*`)
- **`/api/auth/guest`**: Issues/reads signed `lf_guest` session cookies using `LOBBYFORGE_SESSION_SECRET` (JWT). Inserts a backing row in the user database on creation.
- **`/api/livekit/token`**: Exchanges the signed guest identity cookie for a token with room-specific grants, signed using `LIVEKIT_API_SECRET` and the HS256 algorithm.
- **`/api/servers`**: Endpoint to GET (list) or POST (create) servers.
- **`/api/health`**: Simple health check status.
- **`/api/doctor`**: Runs automated connectivity test probes.

### C. Environment Variables Used
- **Database**: `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_SSL`.
- **LiveKit**: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`.
- **Diagnostics/Doctor**: `POSTGRES_URL`, `REDIS_URL`, `NEXT_PUBLIC_BASE_URL`.
- **System**: `LOBBYFORGE_SESSION_SECRET` (minimum 32-char cookie secret), `LOBBYFORGE_DISK_USAGE_RATIO`, `LOBBYFORGE_TURN_URL`, `LOBBYFORGE_TURN_STATIC_AUTH_SECRET`.

### D. Existing Mocks
- **Doctor connectivity**: `probePostgres` and `probeRedis` in `apps/web/lib/doctor.ts` are hardcoded stub functions returning `true` without executing actual socket network checks.
- **UI testing components**: The `/connect` page is a mock dashboard sandbox testing the token endpoints. It lacks actual WebRTC media capture/render.

---

## 4. Dependencies Analysis: Installed vs. Required

To support the Core Community MVP features, several dependencies must be added to the project.

| Feature / Domain | Already Installed | Additional Dependencies Required | Integration & Implementation Detail |
| --- | --- | --- | --- |
| **Database Migrations** | `drizzle-orm` (runtime)<br>`drizzle-kit` (dev) | None | Drizzle Kit is installed, but `drizzle.config.ts` must be written in `packages/db`. Programmatic migration execution on web app boot can be implemented using `drizzle-orm/postgres-js/migrator` directly. |
| **Redis Presence Tracking** | None | `ioredis`<br>`@types/ioredis` (dev) | A Redis driver is needed. User location (which server/channel they occupy) will write to Redis keys with a short TTL, updated on heartbeat ticks. |
| **LiveKit Voice Streaming** | `jose` (token signature) | `livekit-client`<br>`@livekit/components-react`<br>`@livekit/components-styles` | The Next.js client-side code requires the LiveKit browser client SDK to establish peer connections, toggle audio capture, and subscribe to speaker active indicators. |

---

## 5. PROJECT.md Update Proposal

The following additions should be appended to the root `PROJECT.md` to specify MVP deliverables and architectural modifications:

```markdown
## MVP Core Features Roadmap

### Core Milestones

| # | Name | Target Scope | Status |
|---|------|--------------|--------|
| M8 | Automated Database Migrations | Programmatic Drizzle migrator run on `apps/web` boot. | PLANNED |
| M9 | Dashboard UI Layout | Left sidebar navigation dock, channel panels, and central chat layout inside `apps/web`. | PLANNED |
| M10 | LiveKit Voice Integration | Client-side audio toggling, active speaker indicators, and stream capture. | PLANNED |
| M11 | Redis Presence Tracking | Ephemeral sync tracking channel participants. | PLANNED |

### MVP Architecture Extensions
- **Stateless Session Validation**: Next.js auth utilizes encrypted/signed session cookies (`lf_guest`) to authenticate room requests.
- **WebRTC Voice Stream Topology**: Next.js serves tokens using `jose`. The client connects directly to the LiveKit server with `livekit-client`.
- **Ephemeral Store**: User presence status is stored in Redis under short-lived keys, maintaining a real-time list of who is in what voice channel.
```

---

## 6. TEST_INFRA.md Update Proposal

The following updates should be appended to `TEST_INFRA.md` to align with the MVP testing requirements:

```markdown
## MVP Integration Testing Framework

### Feature Testing Scope

1. **Database & Migrations**:
   - Verify that database connection singletons handle pool limits and reconnects correctly.
   - Test that programmatic migrator doesn't block boot cycles when DB is unreachable (graceful failure).
   - Mock Postgres queries using Drizzle query mocks or testing containers (e.g. Testcontainers-node).

2. **Redis Presence Service**:
   - Create a mock Redis service using `redis-mock` or `ioredis-mock` for local vitest environment runs.
   - Verify presence keys are set, queried, and auto-expire correctly.

3. **LiveKit Integration**:
   - Mock JWT expiration times and grants parsing in unit tests.
   - Unit test that missing credentials fail gracefully with `503 Service Unavailable` instead of crashes.

### E2E Testing Scenarios
- **Multiple Browsers**: Setup Playwright tests to open two concurrent sessions, create guest sessions, fetch tokens for the same room, and assert that both appear in the participant lists.
```
