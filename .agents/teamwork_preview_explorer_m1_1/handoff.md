# Handoff Report — E2E Testing Infrastructure Setup

## 1. Observation

Direct observations from the codebase investigation:
- **Root package.json scripts:** Line 18 in `package.json` contains:
  ```json
  "test:e2e": "pnpm -r --if-present test:e2e",
  ```
  But no workspace package currently implements a `test:e2e` script.
- **apps/web package.json dependencies:** Inspecting `apps/web/package.json` reveals dependencies for Vitest (`"vitest": "^1.6.0"`, `"happy-dom": "^14.12.0"`) but no dependency or configuration for Playwright.
- **Vitest configuration:** `apps/web/vitest.config.ts` shows tests are restricted to unit/integration subdirectories:
  ```ts
  test: {
    environment: 'node',
    include: [
      'src/__tests__/**/*.test.ts',
      'lib/__tests__/**/*.test.ts',
      'app/api/**/__tests__/**/*.test.ts',
    ],
  }
  ```
- **Test Strategy Specification:** `projectdetails/25_TESTING_STRATEGY.md` (lines 40-44) shows the directory layout for Playwright E2E tests:
  ```
  apps/web/
    e2e/                      # Playwright E2E tests
      auth.spec.ts
      voice-room.spec.ts
      hushle-game.spec.ts
      text-chat.spec.ts
  ```
- **Local Services Configuration:** `infra/docker/docker-compose.dev.yml` details the default stack services:
  - Postgres on port `5432` (`POSTGRES_DB: ${POSTGRES_DB:-lobbyforge}`)
  - Redis on port `6379` (`lobbyforge-redis`)
  - LiveKit on port `7880` (`lobbyforge-livekit`)

---

## 2. Logic Chain

1. **Test Placement:**
   - From `projectdetails/25_TESTING_STRATEGY.md` and the Next.js app structure, the main user flow orchestrator is `apps/web`.
   - Creating a root-level package or a different workspace for E2E testing would introduce package complexity and build orchestration overhead.
   - Therefore, E2E tests should be placed in `apps/web/e2e/` and configured locally within `apps/web/`.

2. **Test Runner Choice:**
   - From `apps/web/vitest.config.ts`, Vitest runs in a `node` environment, which is unsuitable for visual DOM assertions, WebRTC media loopbacks, and multi-session interactions.
   - Playwright (`@playwright/test`) allows multi-browser context testing, browser-specific flags for WebRTC media device simulation, and standard E2E assertions.
   - Therefore, Playwright should be the chosen E2E test runner, triggered by `"test:e2e": "playwright test"` inside `apps/web/package.json`.

3. **Service Interactions (R1 - R4):**
   - **R1 (Database):** Vitest routes tests use spies/mocks for `@lobbyforge/db`. In E2E tests, SQL schema integrity (e.g., uniqueness constraints on `guest_key`) must be verified. Thus, E2E tests must connect to a real test database. Programmatic migrations must run before testing, and a test-only reset endpoint (`POST /api/test/db-reset`) should clear database state between test runs.
   - **R2 (UI Layout):** Playwright should verify visual rendering and navigation of the dashboard panels (`server-dock`, `channel-list`, `room-view`) using `data-testid` locators.
   - **R3 (LiveKit Audio):** Connecting to a real LiveKit server is required to check real-time connection status and active speakers. To allow automated testing in CI/CD without physical hardware, Chromium must be launched with flags: `--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream`.
   - **R4 (Redis Presence):** Real-time presence relies on multi-session interaction. The test runner must spin up two parallel browser contexts to confirm state updates instantly propagate to other sessions. Redis state should be reset between tests using a test-only endpoint (`POST /api/test/redis-reset`), and keys/TTLs can be validated using `ioredis` directly in test setups.

---

## 3. Caveats

- **TURN Server Testing:** The `coturn` TURN container is optional and disabled by default. E2E tests rely on direct UDP/TCP signaling loopback on `localhost`. Real NAT traversal via TURN is not validated in automated headless browser runs and must be checked manually or in staging environments.
- **S3 / MinIO Mocking:** Media attachments and object storage integration are out of scope for this milestone (Milestone M1) E2E layout.

---

## 4. Conclusion

We conclude that the LobbyForge E2E testing infrastructure can be successfully established by:
1. Placing spec files inside `apps/web/e2e/`.
2. Registering the `"test:e2e": "playwright test"` script in `apps/web/package.json` to hook into the root `package.json` recursive scripts.
3. Launching Chromium with media stream flags to simulate WebRTC microphone input.
4. Using the real docker-compose services (Postgres, Redis, LiveKit) against a dedicated test database, automated by a `globalSetup` Drizzle migration and test-only database/Redis reset API endpoints.

---

## 5. Verification Method

To independently verify the E2E setup:
1. Confirm the existence and location of `apps/web/e2e/` (should contain test specs).
2. Inspect `apps/web/playwright.config.ts` to verify the presence of Chromium launch args (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`) and the `webServer` command configured to run Next.js.
3. Check `apps/web/package.json` to verify `test:e2e` is set to `playwright test`.
4. Run `pnpm test:e2e` from the root directory — it should execute Playwright tests inside `apps/web` (if configured and dependencies are installed).
