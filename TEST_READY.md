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
- [x] **Tier 2: Boundary & Corner Cases**:
  - `guest-auth-boundaries.spec.ts`: Guest auth input validation — overlong displayNameSeed (400), unknown body field via `.strict()` (400), GET without cookie (401), session round-trip after creation, non-member presence write rejected.
  - `chat-and-presence-api.spec.ts`: Chat/typing/presence/invite REST boundaries — non-member message POST rejected, typing POST rejected, channel-presence GET rejected, invite creation without permission rejected, public invite metadata 404, redeem without session gated.
- [x] **Tier 3: Cross-Feature Combinations**:
  - `chat-and-presence-api.spec.ts` (cross-cutting): Auth → membership → chat/typing/presence contract enforcement across multiple endpoints in a single session.
  - `voice.spec.ts`: Two browser contexts mint distinct sessions and enforce membership on token + presence endpoints.
- [ ] **Tier 4: Real-World Scenarios**: (Requires full docker stack: Postgres + Redis + LiveKit + ws-gateway)
  - Two-client real-time chat delivery (send in one lobby, receive in another via ws-gateway)
  - Member presence online/offline transitions across contexts
  - Typing indicator fanout to a second client
  - Full voice session with two fake-media browsers

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
