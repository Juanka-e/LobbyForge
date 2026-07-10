# E2E Test Infra: LobbyForge Monorepo

## Test Philosophy
- Ensure that all workspaces (apps, packages, plugins) can be built, typechecked, linted, and tested.
- Methodology: Verify that vitest runs successfully in all workspaces and linting rules are respected.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Workspace Recognition | R1 | ✓ | ✓ | ✓ |
| 2 | Compilability | R2 | ✓ | ✓ | ✓ |
| 3 | Cross-Platform Scripts | R3 | ✓ | ✓ | ✓ |

## Test Architecture
- Test runner: `pnpm test` invoking Vitest across all workspace packages.
- Directory layout: tests located in `src/__tests__/` or `__tests__/` under each workspace package.

## Coverage Thresholds
- All packages must compile and have at least 1 basic test.

## MVP Integration Testing Framework
The MVP integration testing framework validates connections, data integrity, and real-time state synchronization across internal systems.

### Feature Testing Scope
1. **Database & Migrations**: Test programmatic migrator resilience and database queries.
2. **Redis Presence Service**: Unit tests checking setting, getting, and expiry of presence keys (e.g. using a mock Redis or local Redis).
3. **LiveKit Integration**: Token generation verification and error handling.

### E2E Testing Scenarios
- **Multi-Session Presence Synchronization**: Multiple concurrent browser sessions creating guest sessions, joining same rooms, and asserting presence synchronization.
- **Database Migrations on Boot**: Validate `TEST_DATABASE_URL` connectivity and ensure schema definitions are created on app startup.
- **Next.js Dashboard UI**: Render and test `[data-testid="server-dock"]`, `[data-testid="channel-list"]`, and `[data-testid="room-view"]` visibility and interactions.
- **LiveKit Voice Multi-Session**: Two browser contexts join the same channel using Chromium fake media flags, verify `participant-list` and connection status sync.

### E2E Testing Architecture (Playwright)
- Runner: `@playwright/test` invoked via `pnpm test:e2e` in `apps/web`.
- Directory Layout: All test specs are in `apps/web/e2e/`.
- Test Environment:
  - `playwright.config.ts` handles browser contexts, Chromium fake media stream flags for voice simulation.
  - `webServer` automatically manages the Next.js `dev` process for tests on `http://localhost:3000`.
  - Database and Redis states are isolated and wiped before each test via dedicated `test-only` reset endpoints (`/api/test/db-reset` and `/api/test/redis-reset`).
