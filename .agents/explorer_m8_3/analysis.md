# Database and API Route Integration Analysis

## Executive Summary
This report analyzes the database integrations, mocks, and test infrastructure for `apps/web` and `packages/db` in the LobbyForge monorepo. 

Key findings:
1. **Mock Status**: The API routes `/api/auth/guest` and `/api/servers` are fully implemented in production, but lack live database connection verification in tests. Route tests use Vitest mocks (`vi.mock('@lobbyforge/db')`) to mock all database functions. Conversely, the `probePostgres` health/doctor probe in `apps/web/lib/doctor.ts` is purely mocked in production (returns `true` unconditionally).
2. **Missing Test Infrastructure**: There is no active test harness for live database connectivity, Drizzle schema query verification, or migration execution. Additionally, Drizzle Kit lacks a `drizzle.config.ts` file in the codebase.
3. **Proposed Solutions**:
   - Upgrade `probePostgres` from a static stub to a dynamic TCP / query probe.
   - Establish a `drizzle.config.ts` configuration.
   - Design a programmatic migration executor utilizing Drizzle's `migrate` module.
   - Implement an integration test suite under a dedicated flag (e.g. `TEST_DATABASE_URL`) to verify migrations, database queries, and connectivity against a real Postgres instance.

---

## 1. API Route Mock and Integration Status

### 1.1 `/api/auth/guest` (`apps/web/app/api/auth/guest/route.ts`)
* **Production Code**: Fully integrated. When a request is received, it invokes `findOrCreateGuestUser` from `@lobbyforge/db` (via the singleton `getDb()`) to create a user record. 
* **Mocks**: No mock logic exists in production code. If the database connection fails, the error is caught and logged, falling back to a session cookie with `uid: null` so guest-only client actions can still function.
* **Test Status**: **Completely untested**. No unit or integration tests are written for this endpoint. (Only the session cookie encryption/decryption helper `guest-session.ts` is unit-tested).

### 1.2 `/api/servers` (`apps/web/app/api/servers/route.ts` & sub-routes)
* **Production Code**: Fully integrated. Queries the database using the shared `@lobbyforge/db` functions: `listServersForUser`, `createServer`, `getServerById`, and `isServerMember`.
* **Mocks**: No mock logic exists in production.
* **Test Status**: Tested via mock-based unit tests (`apps/web/app/api/servers/__tests__/servers.test.ts`). The database module is mocked via `vi.mock('@lobbyforge/db')` and the `getDb()` function is stubbed to return `{ __mockDbClient: true }`. Consequently, these tests verify route behavior (e.g., authorization, parameter validation) but do not hit a real database.

### 1.3 `probePostgres` (`apps/web/lib/doctor.ts`)
* **Production Code**: **Mocked**. The current implementation of `probePostgres` is:
  ```typescript
  async function probePostgres(_url: string): Promise<boolean> {
    // Real postgres TCP probe is intentionally out of scope for the first cut;
    // we keep the call site here so the wiring is right when the driver lands.
    // Returning true optimistically matches the "best-effort" stance the spec asks for.
    return true;
  }
  ```
* **How to Hook Up**: To perform a real check, we can use the `postgres` client library (already imported and used by `@lobbyforge/db`) to initialize a transient connection pool with a size of 1 and a short timeout.
  ```typescript
  import postgres from 'postgres';

  async function probePostgres(url: string): Promise<boolean> {
    const sql = postgres(url, { max: 1, connect_timeout: 2 });
    try {
      await sql`SELECT 1`;
      return true;
    } catch (err) {
      console.error('[doctor] postgres probe failed:', err);
      return false;
    } finally {
      await sql.end();
    }
  }
  ```

---

## 2. Test Verification Strategies

### 2.1 Verifying Database Connections
* **Unit Testing**: Establish mock database drivers that raise network/connection errors, verifying that routes and doctor checks handle exceptions gracefully (returning 503/500/critical statuses).
* **Integration Testing**: Implement a connection check in the test environment using a configured `TEST_DATABASE_URL` environment variable:
  ```typescript
  import { describe, it, expect } from 'vitest';
  import postgres from 'postgres';

  describe('Database Connection Integration', () => {
    it('should connect and query the db', async () => {
      const url = process.env.TEST_DATABASE_URL || 'postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge';
      const sql = postgres(url, { max: 1, connect_timeout: 3 });
      try {
        const result = await sql`SELECT 1 as ok`;
        expect(result[0]?.ok).toBe(1);
      } finally {
        await sql.end();
      }
    });
  });
  ```

### 2.2 Verifying Schema Queries
* **Goal**: Validate that Drizzle queries and schema constraints (like unique constraints or foreign key cascades) behave correctly against the database engine.
* **Verification Method**: Write integration tests under `packages/db/src/__tests__/integration/` that:
  1. Retrieve the connection string from `process.env.TEST_DATABASE_URL`. If not defined, skip the integration tests.
  2. Setup a database client (`createDb(url)`).
  3. Clean/truncate test tables before each test block (e.g. `TRUNCATE TABLE users CASCADE`).
  4. Perform data mutation queries and read operations, verifying constraints (e.g., verifying that deleting a server cascades to delete its channels).
* **Example Schema Integration Test**:
  ```typescript
  import { describe, it, expect, beforeEach } from 'vitest';
  import { createDb } from '../../client';
  import { createServer } from '../../queries/servers';
  import { createChannel, listChannelsForServer } from '../../queries/channels';
  
  describe('Queries & Cascading Integration', () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      it.skip('Skipping integration tests (TEST_DATABASE_URL is missing)', () => {});
      return;
    }
    const db = createDb(url);

    it('cascades channel deletion when parent server is deleted', async () => {
      // 1. Create owner user
      // 2. Create server
      // 3. Create channel
      // 4. Soft-delete/delete server
      // 5. Assert that listChannelsForServer returns 0 channels
    });
  });
  ```

### 2.3 Verifying Migration Execution
* **Current State**: `packages/db` defines commands `db:generate` and `db:push` in `package.json`, but no `drizzle.config.ts` exists to define schema and output paths.
* **Step 1: Configuration**: Add `packages/db/drizzle.config.ts`:
  ```typescript
  import { defineConfig } from 'drizzle-kit';

  export default defineConfig({
    schema: './src/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
      url: process.env.DATABASE_URL || 'postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge',
    },
  });
  ```
* **Step 2: Programmatic Migrations**: Add a programmatic migration executor using Drizzle's built-in migrator runner:
  ```typescript
  import { migrate } from 'drizzle-orm/postgres-js/migrator';
  import { type DbClient } from './client';

  export async function runMigrations(db: DbClient, folder = './drizzle') {
    await migrate(db, { migrationsFolder: folder });
  }
  ```
* **Step 3: Verification Test**:
  Write an integration test that runs the programmatic migrator against a temporary/clean test database and verifies table presence in PostgreSQL:
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { createDb } from '../../client';
  import { runMigrations } from '../../migrator';
  import { sql } from 'drizzle-orm';

  describe('Database Migrations', () => {
    it('executes migrations successfully and creates public tables', async () => {
      const db = createDb(process.env.TEST_DATABASE_URL!);
      
      // Run migrations
      await runMigrations(db, './drizzle');
      
      // Check tables exist in the public schema
      const tables = await db.execute(sql`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      const names = tables.map(t => t.table_name);
      expect(names).toContain('users');
      expect(names).toContain('servers');
      expect(names).toContain('channels');
    });
  });
  ```

---

## 3. Test Running Infrastructure

* **Workspace Runner**: The project uses `pnpm test` in the monorepo root which triggers vitest workspace-wide (`pnpm -r --if-present test`).
* **Existing Configs**:
  - `vitest.workspace.ts` specifies workspaces matching `packages/*/vitest.config.ts` and `apps/*/vitest.config.ts`.
  - `apps/web/vitest.config.ts` includes files matching `app/api/**/__tests__/**/*.test.ts`, `lib/__tests__/**/*.test.ts`, and `src/__tests__/**/*.test.ts`.
  - `packages/db/vitest.config.ts` includes files matching `src/__tests__/**/*.test.ts`.
* **Execution Environment**:
  - The tests run via Vitest in `node` environment (happy-dom is available for desktop UI/registry but backend/db tests run in native Node.js environment).
  - Currently, no tests run with database connectivity. All test workflows rely on Vitest mocks, meaning that database integrity and queries are not validated during the verification lifecycle.
