# E2E Test Readiness Report

The End-to-End (E2E) testing track infrastructure has been successfully implemented using Playwright inside `apps/web`.

## Implemented Architecture
- **Framework**: `@playwright/test`
- **Location**: `apps/web/e2e/`
- **Configuration**: `apps/web/playwright.config.ts` runs the local Next.js server automatically on `localhost:3000` and simulates media streams natively using chromium flags.
- **State Isolation Hooks**: 
  - `POST /api/test/db-reset`: Truncates PostgreSQL tables via Drizzle integration.
  - `POST /api/test/redis-reset`: Flushes local Redis test db.

## Feature Coverage Checklist (Tiers 1-4)
- [x] **Tier 1: Happy Path Coverage**:
  - `auth.spec.ts`: Guest creation API flows.
  - `dashboard.spec.ts`: Dashboard layout integration testing and component visibility checks.
  - `voice.spec.ts`: Real-time voice connectivity validation, ensuring multiple browsers can mint LiveKit tokens for the same room.
- [ ] **Tier 2: Boundary & Corner Cases**: (To be filled in M3/M4 implementations)
- [ ] **Tier 3: Cross-Feature Combinations**: (To be filled in M3/M4 implementations)
- [ ] **Tier 4: Real-World Scenarios**: (To be filled in M5 implementations)

## How to Run Tests
To run the automated E2E test suite locally:
```bash
# Verify unit/integration tests first
pnpm verify

# Ensure the local docker-compose environment is running
# (Requires Postgres and Redis running locally for the reset API endpoints)

# Execute the E2E test suite from the root workspace
pnpm --filter @lobbyforge/web test:e2e

# Or to run with UI mode for debugging
pnpm --filter @lobbyforge/web test:e2e:ui
```
