# LobbyForge Database Configuration & Migrations Analysis

## Executive Summary
This analysis details the database package structure, Drizzle config requirements, migration generation commands, and local database connection parameters needed for Sub-milestone 1 (Migrations Config & Generation). The database uses **Drizzle ORM** with **PostgreSQL** (`postgres.js` driver), and migrations should be configured to target `./src/migrations` or `./drizzle`.

---

## 1. `@lobbyforge/db` Package Structure

The `@lobbyforge/db` package is structured to act as a stateless, modular database access layer:
- **`packages/db/package.json`**: Configures package scripts, exports, and dependencies. Scripts include `"db:generate": "drizzle-kit generate"` and `"db:push": "drizzle-kit push"`.
- **`packages/db/src/schema.ts`**: Contains the full database table definitions (e.g. `users`, `servers`, `channels`, `memberships`) defined with `drizzle-orm/pg-core` schema types.
- **`packages/db/src/client.ts`**: Provides the connection logic using `postgres` (postgres.js) via the `createDb` factory function, returning a type-safe Drizzle client instance.
- **`packages/db/src/index.ts`**: Re-exports all schema definitions, query helper functions, and database clients, along with common Drizzle utility operators (`sql`, `eq`, `and`, `or`, etc.).
- **`packages/db/src/queries/`**: Module-specific directories that encapsulate queries for specific domains:
  - `users.ts`: Handles identifying or creating users (registered and guests).
  - `servers.ts`: Handles server creations inside a single Postgres transaction.
  - `channels.ts`: Manages channel sorting position indexing.
  - `memberships.ts`: Manages user access validation relative to servers.

---

## 2. Drizzle Configuration (`drizzle.config.ts`) Requirements

A `drizzle.config.ts` configuration file needs to be created at the root of `packages/db` (`packages/db/drizzle.config.ts`). 

### A. Recommended Properties
Based on `drizzle-kit` v0.22.0+ specifications, the config should contain:
- **`schema`**: Path to the TypeScript schema file. This should point to `./src/schema.ts` relative to the root of `packages/db`.
- **`out`**: Directory where generated migrations (`.sql` files and metadata) will be saved. We recommend either `./src/migrations` (so migrations are packaged with the source directory and can be copied or imported during build tasks) or `./drizzle` (standard out-of-box path).
- **`dialect`**: Specifies the target database. Since LobbyForge uses PostgreSQL, this must be `'postgresql'`.
- **`dbCredentials`**: Object containing connection details. For local generation, this should use `url: process.env.DATABASE_URL || 'postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge'`.

### B. Proposed `drizzle.config.ts` Structure

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './src/migrations', // Or './drizzle'
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge',
  },
});
```

---

## 3. Migration Generation CLI Commands

To generate SQL migration scripts in `@lobbyforge/db`, you should run the following commands.

### A. Using Package Scripts (Inside `packages/db`)
Since `packages/db/package.json` already defines a script to run Drizzle Kit generate, navigate to `packages/db` and execute:
```bash
pnpm db:generate
```
*(This is mapped to `drizzle-kit generate` under the hood).*

### B. Using Monorepo Filter (From Monorepo Root)
From the root workspace directory (`d:/livekittest`), execute:
```bash
pnpm --filter @lobbyforge/db db:generate
```

### C. Direct Execution
If executing via `drizzle-kit` CLI directly within `packages/db`:
```bash
npx drizzle-kit generate
```

---

## 4. Local Testing Database Connection details

LobbyForge has an active docker-compose environment config for local testing and development.

### A. Local Docker Database Settings (`infra/docker/docker-compose.dev.yml`)
- **Docker Image**: `postgres:16-alpine`
- **Default Port**: `5432`
- **Default Database (`POSTGRES_DB`)**: `lobbyforge`
- **Default User (`POSTGRES_USER`)**: `lobbyforge`
- **Default Password (`POSTGRES_PASSWORD`)**: `lobbyforge_dev`
- **Default Connection URL**: `postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge`

### B. Unit & Integration Test Database Details (`packages/db/src/__tests__/db.test.ts`)
The test cases verify valid configuration parsing using:
- **Test URL**: `postgresql://postgres:postgres@localhost:5432/lobbyforge`
- **Dummy Client URL**: `postgres://user:pass@localhost:5432/db`

### C. Environment Variables List
To configure or override database parameters locally, consumers (such as `apps/web` or tests) read from:
1. **`DATABASE_URL`**: Full connection string (e.g. `postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge`). **Required**.
2. **`DATABASE_POOL_MAX`**: Maximum connection pool limit (defaults to `10` inside `parseDatabaseConfig`).
3. **`DATABASE_SSL`**: Boolean flag indicating whether SSL connection mode should be active (defaults to `false`).
