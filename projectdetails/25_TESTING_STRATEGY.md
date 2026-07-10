# 25 — Testing Strategy

## Overview

LobbyForge uses a multi-layer testing strategy. Tests are a first-class concern — no feature is complete without appropriate test coverage.

## Test Stack

| Layer | Tool | Purpose |
|---|---|---|
| Unit tests | **Vitest** | Pure functions, utilities, schemas, state logic |
| Component tests | **Vitest + React Testing Library** | UI components in isolation |
| Integration tests | **Vitest + Testcontainers** | API routes with real PostgreSQL/Redis |
| E2E tests | **Playwright** | Full user flows in browser |
| Load tests | **k6** (future) | Performance under concurrent users |

### Why Vitest over Jest?

- Native ESM support (Next.js App Router uses ESM)
- Vite-based — faster HMR during test development
- Compatible with Jest API (easy migration)
- Built-in TypeScript support without transform config
- Workspace mode for monorepo

## Test Directory Structure

```
apps/web/
  src/
    __tests__/              # Integration tests for API routes
      api/
        auth.test.ts
        channels.test.ts
        servers.test.ts
        activities.test.ts
    components/
      __tests__/            # Component tests co-located
        Button.test.tsx
        ChannelList.test.tsx
  e2e/                      # Playwright E2E tests
    auth.spec.ts
    voice-room.spec.ts
    hushle-game.spec.ts
    text-chat.spec.ts

packages/core/
  src/
    __tests__/
      permissions.test.ts
      validators.test.ts

packages/db/
  src/
    __tests__/
      schema.test.ts        # Schema validation
      queries.test.ts       # Query builders

plugins/hushle/
  src/
    __tests__/
      game-logic.test.ts
      state-machine.test.ts
      card-validation.test.ts
```

## Unit Tests

### What to Unit Test

- Permission calculation logic (`packages/core`)
- Input validation schemas (Zod schemas)
- Plugin game logic (state transitions, scoring)
- i18n key resolution and fallback
- Utility functions (formatting, parsing)
- Redis key generation
- LiveKit token generation (with mocked LiveKit SDK)

### Example

```ts
// packages/core/src/__tests__/permissions.test.ts
import { describe, it, expect } from 'vitest';
import { hasPermission, Permission } from '../permissions';

describe('hasPermission', () => {
  it('server owner has all permissions', () => {
    const member = { isOwner: true, roles: [] };
    expect(hasPermission(member, Permission.MANAGE_CHANNELS)).toBe(true);
  });

  it('checks role permissions', () => {
    const member = {
      isOwner: false,
      roles: [{ permissions: { manage_channels: true } }],
    };
    expect(hasPermission(member, Permission.MANAGE_CHANNELS)).toBe(true);
    expect(hasPermission(member, Permission.MANAGE_ROLES)).toBe(false);
  });
});
```

## Integration Tests

### Approach: Real Database with Testcontainers

```ts
// apps/web/src/__tests__/setup.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { beforeAll, afterAll } from 'vitest';

let pgContainer, redisContainer;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
  redisContainer = await new RedisContainer('redis:7-alpine').start();

  process.env.DATABASE_URL = pgContainer.getConnectionUri();
  process.env.REDIS_URL = redisContainer.getConnectionUri();

  // Run migrations
  await runMigrations();
}, 60000); // 60s timeout for container startup

afterAll(async () => {
  await pgContainer?.stop();
  await redisContainer?.stop();
});
```

### What to Integration Test

- Auth flow: register → login → session → logout
- Server CRUD: create → update → delete
- Channel operations with permission checks
- Message send with rate limiting
- Invite create → join → max uses enforcement
- Game session lifecycle: create → lobby → start → end
- LiveKit token generation (with real token, mocked LiveKit server)

### Database Seeding

```ts
// apps/web/src/__tests__/fixtures.ts
export async function seedTestData(db) {
  const user = await db.insert(users).values({
    email: 'test@example.com',
    displayName: 'Test User',
    passwordHash: await hashPassword('testpass123'),
  }).returning();

  const server = await db.insert(servers).values({
    name: 'Test Server',
    slug: 'test-server',
    ownerUserId: user[0].id,
  }).returning();

  // ... channels, roles, memberships
  return { user: user[0], server: server[0] };
}
```

## E2E Tests (Playwright)

### Setup

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'pnpm dev',
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:3000',
    permissions: ['microphone'],  // for voice tests
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
```

### E2E Test Scenarios

```ts
// e2e/auth.spec.ts
import { test, expect } from '@playwright/test';

test('user can register and login', async ({ page }) => {
  await page.goto('/register');
  await page.fill('[name="email"]', 'newuser@test.com');
  await page.fill('[name="password"]', 'securepass123');
  await page.fill('[name="displayName"]', 'New User');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/servers');
  await expect(page.locator('[data-testid="user-menu"]')).toContainText('New User');
});
```

### Voice/LiveKit Testing Challenge

Testing voice functionality in E2E is difficult:

1. **Mock approach (recommended for CI):**
   - Mock LiveKit client SDK in test environment
   - Verify: token requested, room joined, UI updated
   - Don't verify: actual audio transmission

2. **Real approach (manual/local):**
   - Two browser profiles with different users
   - Both join same voice channel
   - Use Playwright's `page.evaluate()` to check LiveKit connection state
   - Chrome's `--use-fake-device-for-media-stream` flag for fake audio

```ts
// e2e/voice-room.spec.ts
test('user joins voice channel and sees participants', async ({ browser }) => {
  const context1 = await browser.newContext();
  const context2 = await browser.newContext();
  const page1 = await context1.newPage();
  const page2 = await context2.newPage();

  // Login as two different users
  await loginAs(page1, 'user1@test.com');
  await loginAs(page2, 'user2@test.com');

  // Both join voice channel
  await page1.click('[data-testid="voice-channel-general"]');
  await page2.click('[data-testid="voice-channel-general"]');

  // Verify both see each other
  await expect(page1.locator('[data-testid="participant-list"]')).toContainText('User 2');
  await expect(page2.locator('[data-testid="participant-list"]')).toContainText('User 1');
});
```

### Plugin/Game Testing

```ts
// plugins/hushle/src/__tests__/game-logic.test.ts
import { describe, it, expect } from 'vitest';
import { createInitialState, handleAction } from '../game-logic';

describe('Hushle Game Logic', () => {
  it('creates initial state with teams', () => {
    const state = createInitialState({
      players: ['p1', 'p2', 'p3', 'p4'],
      settings: { roundTime: 60, rounds: 3 },
    });
    expect(state.phase).toBe('team_setup');
    expect(state.teams).toHaveLength(2);
  });

  it('handles correct answer', () => {
    const state = { /* running state */ };
    const newState = handleAction(state, {
      type: 'correct',
      playerId: 'p1',
    });
    expect(newState.scores.teamA).toBe(1);
    expect(newState.currentCard).not.toBe(state.currentCard);
  });

  it('rejects action from wrong player', () => {
    const state = { currentExplainer: 'p1' };
    expect(() => handleAction(state, {
      type: 'correct',
      playerId: 'p2', // not the explainer
    })).toThrow('NOT_YOUR_TURN');
  });
});
```

## Coverage Targets

| Package | Target | Priority |
|---|---|---|
| `packages/core` | 90%+ | Critical — business logic |
| `packages/db` | 80%+ | High — data integrity |
| `plugins/hushle` | 85%+ | High — game logic correctness |
| `plugins/vampire-village` | 85%+ | High — game logic correctness |
| `apps/web` (API routes) | 75%+ | High — auth, permissions |
| `apps/web` (components) | 60%+ | Medium — key UI components |
| `packages/ui` | 70%+ | Medium — shared components |
| `packages/i18n` | 80%+ | Medium — fallback logic |

## Test Commands

```bash
# Root level
pnpm test              # Run all unit + integration tests
pnpm test:unit         # Unit tests only
pnpm test:integration  # Integration tests (needs Docker)
pnpm test:e2e          # Playwright E2E tests
pnpm test:coverage     # Generate coverage report

# Package level
pnpm --filter @lobbyforge/core test
pnpm --filter @lobbyforge/web test
pnpm --filter @lobbyforge/hushle test
```

## CI Integration

See `28_CI_CD_PIPELINE.md` for the full pipeline. Tests run on every PR:
1. Lint + typecheck (fast, parallel)
2. Unit tests (fast, no Docker)
3. Integration tests (needs Docker-in-Docker or service containers)
4. E2E tests (needs browser, runs on merge to main only)

## Test Data & Fixtures

- **Never use production data in tests**
- Fixtures in `__tests__/fixtures/` directories
- Factory functions for generating test data
- Hushle card packs: test deck with known words
- Vampire Village: test scenario with known roles

## Mocking Strategy

| Dependency | Mock In | Real In |
|---|---|---|
| PostgreSQL | ❌ Never mock | Unit (via Testcontainers), Integration, E2E |
| Redis | Unit tests | Integration, E2E |
| LiveKit SDK | Unit, Component, E2E (CI) | Integration (local), E2E (local) |
| File storage | Unit, Component | Integration, E2E |
| Email/SMTP | Always mock in tests | Never real in tests |
| External APIs | Always mock | Never real in tests |
