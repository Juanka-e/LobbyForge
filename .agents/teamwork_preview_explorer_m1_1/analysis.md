# E2E Testing Infrastructure Analysis (Milestone M1)

This report details the layout, configuration, and implementation strategy for setting up the End-to-End (E2E) testing infrastructure for LobbyForge's Core Community MVP features.

---

## 1. Directory Placement of E2E Tests

### Observation
- The codebase is structured as a `pnpm` monorepo (see `docs/MONOREPO.md` & `pnpm-workspace.yaml`).
- Root `package.json` contains a placeholder script for E2E tests:
  ```json
  "test:e2e": "pnpm -r --if-present test:e2e"
  ```
- The living testing specification (`projectdetails/25_TESTING_STRATEGY.md` § "Test Directory Structure") outlines the test layout, identifying `apps/web/e2e` as the location for Playwright spec files:
  ```
  apps/web/
    e2e/                      # Playwright E2E tests
      auth.spec.ts
      voice-room.spec.ts
  ```

### Reasoning
- **Next.js Integration:** The web application (`apps/web`) acts as the user interface and coordinates routes, guest session cookies, API endpoints (`/api/auth/guest`, `/api/livekit/token`, `/api/servers`), and client-side WebRTC connections. Keeping the E2E tests inside `apps/web/e2e` matches standard Next.js practices.
- **Simplicity:** Creating a separate root-level workspace (e.g., `apps/e2e`) would introduce monorepo configuration complexity, whereas placing tests under `apps/web/e2e` ensures all dependencies, UI elements, and API route definitions reside within the same package.
- **Topological execution:** Placing tests under `apps/web/` allows us to define the `test:e2e` script locally in `apps/web/package.json`. When running `pnpm test:e2e` from the root, `pnpm` automatically delegates execution to the web workspace.

### Setup Strategy
1. **Directory Location:** Create `apps/web/e2e/` for Playwright test spec files (e.g., `dashboard.spec.ts`, `voice.spec.ts`).
2. **Configuration Location:** Place the `playwright.config.ts` file in `apps/web/playwright.config.ts` so that configuration is scoped specifically to the Next.js application.

---

## 2. Test Runner Configuration & CLI Scripts

### Observation
- The root `package.json` executes tests recursively:
  ```json
  "test:e2e": "pnpm -r --if-present test:e2e"
  ```
- Current `apps/web/package.json` lacks any `test:e2e` script.
- The default `vitest.config.ts` in `apps/web` is set to run in a `node` environment, targeting `src/__tests__`, `lib/__tests__`, and `app/api/**/__tests__`:
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

### Reasoning
- **Playwright vs. Vitest:** Vitest is well-suited for fast unit and mock-based integration tests. However, full-browser interaction, WebRTC media streaming, and multi-browser session concurrency are best handled by Playwright (`@playwright/test`), which starts a real headless browser (Chromium, Firefox) to execute user scenarios.
- **Root Delegation:** Adding the `test:e2e` script to the web package connects Playwright to the monorepo's universal verify process.

### Setup Strategy
1. **Workspaces Script Mapping:**
   In `apps/web/package.json`, add the following scripts:
   ```json
   "test:e2e": "playwright test",
   "test:e2e:ui": "playwright test --ui"
   ```
2. **Playwright Scoping in Vitest:**
   Keep `apps/web/vitest.config.ts` unchanged so it ignores the `e2e/` folder. This keeps unit tests fast and independent from the browser automation tests.
3. **Playwright Config (`apps/web/playwright.config.ts`):**
   ```ts
   import { defineConfig, devices } from '@playwright/test';

   export default defineConfig({
     testDir: './e2e',
     fullyParallel: true,
     forbidOnly: !!process.env.CI,
     retries: process.env.CI ? 2 : 0,
     workers: process.env.CI ? 1 : undefined,
     reporter: 'html',
     use: {
       baseURL: 'http://localhost:3000',
       trace: 'on-first-retry',
     },
     webServer: {
       command: 'pnpm --filter @lobbyforge/web dev',
       url: 'http://localhost:3000',
       reuseExistingServer: !process.env.CI,
       stdout: 'ignore',
       stderr: 'pipe',
       timeout: 60000,
     },
     projects: [
       {
         name: 'chromium',
         use: {
           ...devices['Desktop Chrome'],
           launchOptions: {
             args: [
               '--use-fake-ui-for-media-stream',
               '--use-fake-device-for-media-stream',
             ],
           },
         },
       },
     ],
   });
   ```

---

## 3. Integration & Interaction with Services (R1 - R4)

### R1: Database Integration & Migration Automation

#### Observation
- `packages/db/package.json` contains CLI commands for migrations:
  ```json
  "db:generate": "drizzle-kit generate",
  "db:push": "drizzle-kit push"
  ```
- No automatic execution of migrations is defined at application boot-time or in test setups.
- Database tests in `apps/web/lib/__tests__/db.test.ts` and `apps/web/app/api/servers/__tests__/servers.test.ts` mock `@lobbyforge/db` entirely using Vitest spies.

#### Reasoning
- **Data Integrity:** Mocking the database in E2E tests defeats the purpose of confirming database integration. E2E tests must verify real SQL interactions, constraints, and index lookups (such as the partial index `idx_users_guest_key` added in M10).
- **Isolation:** A shared development database can lead to flaky tests due to dirty states. Using a dedicated test database (e.g. `lobbyforge_test`) is necessary.
- **Migration Sync:** Tests must ensure the database is fully up-to-date with migrations prior to the Next.js server starting.

#### Setup Strategy
1. **Dedicated Test Database:** Ensure a test database is created in Postgres (e.g., using `DATABASE_URL=postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge_test`).
2. **Programmatic Migration Script:** Create a helper file in `packages/db/src/migrate.ts` that runs migrations using Drizzle:
   ```ts
   import { migrate } from 'drizzle-orm/postgres-js/migrator';
   import { createDb } from './client.js';
   import postgres from 'postgres';

   export async function runMigrations(connectionString: string) {
     const sql = postgres(connectionString, { max: 1 });
     const db = createDb(connectionString);
     await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
     await sql.end();
   }
   ```
3. **Setup and Reset Hooks:**
   - Run migrations before E2E tests start using a Playwright `globalSetup` script.
   - To clear state between tests, expose a test-only endpoint `POST /api/test/db-reset` in `apps/web` (only enabled when `process.env.NODE_ENV === 'test'`) which truncates all tables:
     ```ts
     // apps/web/app/api/test/db-reset/route.ts
     import { NextResponse } from 'next/server';
     import { getDb } from '@/lib/db';
     import { sql } from '@lobbyforge/db';

     export async function POST() {
       if (process.env.NODE_ENV !== 'test') {
         return new NextResponse('Forbidden', { status: 403 });
       }
       const db = getDb();
       // Truncate tables to ensure isolation
       await db.execute(sql`TRUNCATE TABLE memberships, servers, users, invites CASCADE;`);
       return NextResponse.json({ ok: true });
     }
     ```
   - In Playwright's `beforeEach`, call this endpoint:
     ```ts
     test.beforeEach(async ({ request }) => {
       await request.post('/api/test/db-reset');
     });
     ```

---

### R2: Next.js Dashboard UI Layout

#### Observation
- Next.js 15 pages are structured inside `apps/web/app`.
- The dashboard UI layout contains a server dock, channel list, and room view.
- The interface routes are defined in `apps/web/src/index.ts`.

#### Reasoning
- The E2E tests should verify that the dashboard layout is rendered properly and routes function as expected.
- Specifically, they should check that clicking different servers updates the layout, triggers a channel list change, and renders the voice room view properly.

#### Setup Strategy
1. **Test Hooks:** Include unique `data-testid` attributes on core layout panels:
   - `[data-testid="server-dock"]` (server list dock)
   - `[data-testid="channel-list"]` (list of text/voice/activity channels)
   - `[data-testid="room-view"]` (main room content screen)
2. **Layout Assertions:**
   Write E2E scripts to verify routing and page presence:
   ```ts
   // apps/web/e2e/dashboard.spec.ts
   import { test, expect } from '@playwright/test';

   test('renders dashboard layout and navigates servers', async ({ page }) => {
     // 1. Create a guest session and log in
     await page.goto('/connect');
     await page.click('button:has-text("Create Guest")');
     
     // 2. Create a server
     await page.click('button:has-text("Create Server")');
     
     // 3. Verify elements are visible in layout
     await expect(page.locator('[data-testid="server-dock"]')).toBeVisible();
     await expect(page.locator('[data-testid="channel-list"]')).toBeVisible();
     await expect(page.locator('[data-testid="room-view"]')).toBeVisible();
   });
   ```

---

### R3: LiveKit Audio Streaming Integration

#### Observation
- LiveKit is configured in the docker stack on port `7880` (see `infra/docker/docker-compose.dev.yml`).
- Client connects directly to LiveKit using the `livekit-client` SDK and a token issued by the `/api/livekit/token` endpoint (see `docs/GUEST_AUTH.md` & `apps/web/lib/livekit.ts`).

#### Reasoning
- To verify the actual media streaming flow, tests must use a real LiveKit instance.
- Direct WebRTC media transmission checks require simulating microphone input on headless browsers. Playwright can inject chromium command-line arguments to simulate input from a dummy media device.

#### Setup Strategy
1. **Emulated Devices:**
   Configure Chromium in `playwright.config.ts` to use virtual microphone streams:
   - `--use-fake-ui-for-media-stream`: Bypasses the browser microphone permission pop-up dialog.
   - `--use-fake-device-for-media-stream`: Supplies a synthetic sine wave audio signal as the mic input.
2. **Multi-User Connection Flow:**
   Write E2E scripts simulating two browsers joining the same channel:
   ```ts
   // apps/web/e2e/voice.spec.ts
   import { test, expect } from '@playwright/test';

   test('two users can join same room and publish audio', async ({ browser }) => {
     // Create two isolated browser contexts
     const userAContext = await browser.newContext();
     const userBContext = await browser.newContext();

     const pageA = await userAContext.newPage();
     const pageB = await userBContext.newPage();

     // Log in Alice & Bob
     await pageA.goto('/connect');
     await pageA.click('button:has-text("Create Guest")');
     await pageB.goto('/connect');
     await pageB.click('button:has-text("Create Guest")');

     // Join general voice channel
     await pageA.click('[data-testid="channel-voice-general"]');
     await pageB.click('[data-testid="channel-voice-general"]');

     // Verify Alice sees Bob in participant list, and vice versa
     await expect(pageA.locator('[data-testid="participant-Bob"]')).toBeVisible();
     await expect(pageB.locator('[data-testid="participant-Alice"]')).toBeVisible();

     // Verify WebRTC Connection Status (e.g. check element showing "Connected" status)
     await expect(pageA.locator('[data-testid="voice-status"]')).toContainText('Connected');
     await expect(pageB.locator('[data-testid="voice-status"]')).toContainText('Connected');
   });
   ```

---

### R4: Redis Real-time Presence

#### Observation
- Redis is configured in the compose stack on port `6379` (see `infra/docker/docker-compose.dev.yml`).
- Ephemeral user presence will be stored in Redis under namespaces (see `projectdetails/07_REDIS_STRATEGY.md` & `projectdetails/24_REALTIME_STRATEGY.md`).

#### Reasoning
- Real-time presence updates must sync instantly across browsers. E2E tests must verify that joining/leaving servers or channels reflects in other users' browsers in real time.
- Redis key TTLs must be validated to ensure presence decays if a client crashes.

#### Setup Strategy
1. **Multi-Session Verification:**
   Use the dual-context approach outlined in R3 to assert that when Alice changes status to "online" or joins a channel:
   - Bob's UI reflects the change (e.g., green dot displays beside Alice's name in server list).
2. **Redis Reset API Route:**
   Expose an endpoint to clear Redis state between test cases to ensure isolation:
   ```ts
   // apps/web/app/api/test/redis-reset/route.ts
   import { NextResponse } from 'next/server';
   import Redis from 'ioredis';

   export async function POST() {
     if (process.env.NODE_ENV !== 'test') {
       return new NextResponse('Forbidden', { status: 403 });
     }
     const redisUrl = process.env.REDIS_URL || 'redis://:lobbyforge_dev@localhost:6379';
     const redis = new Redis(redisUrl);
     await redis.flushdb();
     await redis.quit();
     return NextResponse.json({ ok: true });
   }
   ```
   Include this reset inside Playwright's `beforeEach` hook.
3. **Key and TTL Validation (Direct Redis Probing):**
   In the E2E test script, import `ioredis` to check the Redis keys directly and verify their TTL conforms to the naming standard:
   ```ts
   import Redis from 'ioredis';

   test('updates presence in Redis with correct TTL', async ({ page }) => {
     await page.goto('/connect');
     await page.click('button:has-text("Create Guest")');
     
     // Trigger status update
     await page.click('[data-testid="status-online"]');

     // Direct redis check
     const redis = new Redis('redis://:lobbyforge_dev@localhost:6379');
     const keys = await redis.keys('lf:*:presence:*');
     expect(keys.length).toBeGreaterThan(0);
     
     const ttl = await redis.ttl(keys[0]);
     expect(ttl).toBeGreaterThan(0);
     expect(ttl).toBeLessThanOrEqual(90); // 30-90s TTL check
     await redis.quit();
   });
   ```

---

## 4. Synthesis & E2E Infrastructure Launch Checklist

To run the complete E2E verification test pipeline, the following command script sequence is recommended:

```bash
# 1. Start the docker stack with Postgres, Redis, and Livekit
docker compose -f infra/docker/docker-compose.dev.yml up -d

# 2. Wait for DB and services healthcheck
pnpm verify:services

# 3. Build workspace packages topological dependency order
pnpm build

# 4. Trigger Playwright E2E tests, which spins up Next.js app in test mode
NODE_ENV=test pnpm --filter @lobbyforge/web test:e2e
```

By adhering to this structure, the LobbyForge team guarantees robust, reliable E2E validations for all core community features without mock pollution.
