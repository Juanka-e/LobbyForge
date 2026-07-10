# Scope: E2E Testing Track

## Architecture
- Opaque-box E2E testing using Vitest (running in `apps/web` or via a dedicated E2E command).
- Test target: `apps/web` API endpoints and UI component interfaces.
- Integrations:
  - Database: real database queries/connections via `pg` / `drizzle-orm` (or integration-level test database/mock).
  - Redis: presence state verification.
  - LiveKit: token validation and WebRTC channel integration.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Test Infrastructure & Setup | Setup E2E config, dependencies, helper scripts and mock providers in `apps/web` | None | PLANNED |
| M2 | Tier 1 Feature Coverage | Happy path tests for DB migrations, Dashboard UI, LiveKit token exchange, and Redis presence | M1 | PLANNED |
| M3 | Tier 2 Boundary & Corner | Boundary/error cases (expired sessions, invalid inputs, service outages) | M2 | PLANNED |
| M4 | Tier 3 Cross-Feature Combinations | Interactions between auth, DB, Redis presence, and LiveKit voice streaming | M3 | PLANNED |
| M5 | Tier 4 Real-World Application Scenarios | Complete multi-user workflow: join, create server, join channel, mute/unmute, speak, disconnect | M4 | PLANNED |
| M6 | Verification & Publication | Run all E2E tests, verify layout/contracts, and publish `TEST_READY.md` | M5 | PLANNED |

## Interface Contracts
### E2E Test Runner ↔ apps/web
- Runner invokes `pnpm test:e2e` to execute all tests in `apps/web/e2e`.
- Next.js environment is configured for test mode (e.g. test database URL, test Redis client, mock LiveKit server endpoints if needed).
