# Programmatic Database Migration Runner Analysis for LobbyForge

This report outlines the analysis and technical implementation plan for running database migrations programmatically on application boot inside `apps/web`.

---

## 1. Next.js Setup & Instrumentation Hook Support

### 1.1 Support in Next.js 15.0.3
The `apps/web` application runs **Next.js 15.0.3** (configured as a dependency in `apps/web/package.json`).
* **`experimental.instrumentationHook` Status**: In Next.js 15, the instrumentation hook is **stable** and enabled by default. Enabling it explicitly via `experimental: { instrumentationHook: true }` in `next.config.mjs` is **no longer required** or needed.
* **Placement**: The instrumentation file must be named `instrumentation.ts` (or `instrumentation.js`). Since the App Router `app` folder is at the root of `apps/web` (i.e. `apps/web/app`), the file should be placed at the root level: **`apps/web/instrumentation.ts`**.

### 1.2 TypeScript Configuration Requirement
In `apps/web/tsconfig.json`, the `include` block is defined as:
```json
"include": ["next-env.d.ts", "src/**/*", "app/**/*", "lib/**/*.ts", ".next/types/**/*.ts"]
```
Because `instrumentation.ts` sits at the root of the project (`apps/web/instrumentation.ts`), it falls outside of `src/**/*`, `app/**/*`, and `lib/**/*.ts`.
* **Action Needed**: Modify `apps/web/tsconfig.json` to explicitly include `"instrumentation.ts"` in the `"include"` array to prevent compile-time or typechecking errors:
```json
"include": ["next-env.d.ts", "src/**/*", "app/**/*", "lib/**/*.ts", "instrumentation.ts", ".next/types/**/*.ts"]
```

### 1.3 Execution Constraints during Build Phase
The `register()` function exported from `instrumentation.ts` is executed during **both** application startup and Next.js build (`next build`).
To prevent build failures in environments where the database is not available (like CI/CD pipelines), we must check the Next.js runtime environment and execution phase:
1. **Runtime Check**: Validate `process.env.NEXT_RUNTIME === 'nodejs'`. The instrumentation hook can execute in Edge environments, where filesystem access (`fs`) and direct database TCP socket connections are unsupported.
2. **Build-Phase Check**: Validate `process.env.NEXT_PHASE !== 'phase-production-build'`. Next.js sets `process.env.NEXT_PHASE` to `'phase-production-build'` during build compilation. Bypassing migrations here ensures compile-time builds succeed without database access.
3. **Skip-Flag Check**: Introduce an optional `SKIP_DB_MIGRATIONS` environment variable to support container configurations where migrations are run independently.

---

## 2. Programmatic Migration Execution

### 2.1 Generating Migrations (`packages/db`)
To generate migration files, `drizzle-kit` requires a config file. Since `@lobbyforge/db` does not currently contain one, a **`packages/db/drizzle.config.ts`** must be added:
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/lobbyforge',
  },
});
```
Running `pnpm --filter @lobbyforge/db db:generate` will populate SQL migration files in `packages/db/migrations`.

### 2.2 Migrator Strategy using `drizzle-orm/postgres-js/migrator`
Since `@lobbyforge/db` uses the `postgres` (postgres.js) driver, programmatic migrations must be run using `drizzle-orm/postgres-js/migrator`.

To avoid leaking the Drizzle migrator dependency and directory structure into `apps/web`, the migration logic should be encapsulated inside a helper function in `@lobbyforge/db` and exported for client applications.

#### Dedicated Short-Lived Client vs. Shared Pool
Using the main application database client (such as the one from `getDb()`) for migrations is discouraged:
* The application pool runs multiple connections and does not end.
* Closing the application pool to clean up after migrations would break the app.
* Leaving the migration connection open consumes resources.

**Recommendation**: The migration helper should initialize a temporary single-connection client (`max: 1`), run migrations, and then terminate it using `.end()`.

```typescript
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runMigrations(connectionString: string, options: { migrationsFolder?: string } = {}) {
  // 1. Establish a temporary single-connection client
  const migrationClient = postgres(connectionString, { max: 1 });
  const db = drizzle(migrationClient);

  // 2. Resolve default migrations folder path (relative to compiled JS location)
  const defaultFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../migrations'
  );
  
  const migrationsFolder = options.migrationsFolder || defaultFolder;

  try {
    // 3. Apply migrations (internally tracks using drizzle's metadata tables)
    await migrate(db, { migrationsFolder });
  } finally {
    // 4. Clean up connection
    await migrationClient.end();
  }
}
```

---

## 3. Resolving Migration Folder Paths

In a monorepo setup, we must ensure paths resolve correctly across environments:

1. **Development Environment**:
   * Next.js executes inside `apps/web`.
   * `@lobbyforge/db` is linked from `packages/db`.
   * If `@lobbyforge/db` is imported, the compiled files are in `packages/db/dist/`.
   * In `packages/db/dist/index.js`, the relative path `../migrations` resolves to `packages/db/migrations` on the host disk, which is the correct local path.
2. **Production Environment**:
   * If using standalone output or packaged deployments, paths might vary.
   * Allowing the runner to accept a configurable `MIGRATIONS_FOLDER` environment variable ensures the directory can be overridden in container deployments (e.g. `MIGRATIONS_FOLDER=/app/migrations`).

---

## 4. Environment Variables Configuration

The following environment variables govern database connection and migration boot execution:

| Variable | Type | Description | Source / Usage |
|---|---|---|---|
| `DATABASE_URL` | String (URL) | PostgreSQL database connection string. Required for both normal operations and migrations. | `packages/config` schema, `@lobbyforge/db` parser |
| `DATABASE_POOL_MAX` | Integer | Connection pool size for the web application (default: `10`). | `@lobbyforge/db` parser |
| `DATABASE_SSL` | Boolean | Enables/disables SSL database connections. | `@lobbyforge/db` parser |
| `SKIP_DB_MIGRATIONS` | Boolean | If `'true'`, bypasses running database migrations on application boot. | `apps/web/instrumentation.ts` |
| `MIGRATIONS_FOLDER` | String | Custom file path to override the resolved location of migrations files. | `@lobbyforge/db/src/migrator.ts` |

---

## 5. Implementation Blueprints (Proposals)

### Proposal 5.1: Create `packages/db/src/migrator.ts`
```typescript
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrateOptions {
  migrationsFolder?: string;
}

export async function runMigrations(connectionString: string, options: MigrateOptions = {}) {
  const migrationClient = postgres(connectionString, { max: 1 });
  const db = drizzle(migrationClient);

  // In compiled ESM (dist/index.js), __dirname is packages/db/dist
  // default path to packages/db/migrations is ../migrations
  const defaultFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../migrations'
  );

  const migrationsFolder = options.migrationsFolder || defaultFolder;

  try {
    await migrate(db, { migrationsFolder });
    console.log(`[Database] Migrations executed successfully from: ${migrationsFolder}`);
  } catch (error) {
    console.error('[Database] Migration failed:', error);
    throw error;
  } finally {
    await migrationClient.end();
  }
}
```

### Proposal 5.2: Update `packages/db/src/index.ts`
Export `runMigrations` from the root entry point of the package:
```typescript
// Add at the bottom of packages/db/src/index.ts
export * from './migrator.js';
```

### Proposal 5.3: Update `apps/web/tsconfig.json`
Include `instrumentation.ts` in compilation:
```json
  "include": [
    "next-env.d.ts",
    "src/**/*",
    "app/**/*",
    "lib/**/*.ts",
    "instrumentation.ts",
    ".next/types/**/*.ts"
  ],
```

### Proposal 5.4: Create `apps/web/instrumentation.ts`
Implement boot-time execution logic in Next.js:
```typescript
export async function register() {
  // 1. Only run in Node.js runtime environment (Edge does not support DB drivers or fs)
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  // 2. Skip running migrations during Next.js build compilations in CI/CD pipelines
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  // 3. Allow manual bypass via environment variable
  if (process.env.SKIP_DB_MIGRATIONS === 'true') {
    console.log('[App Boot] DB migrations execution skipped via SKIP_DB_MIGRATIONS.');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn('[App Boot] WARNING: DATABASE_URL environment variable is missing. Migrations cannot run.');
    return;
  }

  try {
    console.log('[App Boot] Booting application. Executing programmatic database migrations...');
    
    // Dynamic import to avoid loading db modules in Edge/non-node environments at compile time
    const { runMigrations } = await import('@lobbyforge/db');
    
    await runMigrations(databaseUrl, {
      migrationsFolder: process.env.MIGRATIONS_FOLDER,
    });
  } catch (error) {
    console.error('[App Boot] Critical Error: Database migration runner failed on boot.', error);
    // In production, crashing the process forces orchestrators (Kubernetes/Docker) to restart and retry.
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}
```
