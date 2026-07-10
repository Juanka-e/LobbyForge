# Analysis: Migrations Config & Generation (Sub-milestone 1)

This report details the investigation of the `@lobbyforge/db` package structure, Drizzle configuration requirements, migration paths/commands, and database connection setup for local testing in the LobbyForge monorepo.

---

## 1. `packages/db` Structure Analysis
The `@lobbyforge/db` package is structured as follows:
- **`packages/db/package.json`**: Package configuration, scripts, and dependencies (uses `"type": "module"`, exports TypeScript modules using `./dist/index.js`).
- **`packages/db/tsconfig.json`**: Extends `@lobbyforge/config/tsconfig.base.json` and outputs compile artifacts to `./dist`.
- **`packages/db/src/`**: Source folder.
  - **`schema.ts`**: Contains all database tables and indexes definitions (e.g. `users`, `servers`, `channels`, etc.) using Drizzle ORM PostgreSQL cores.
  - **`client.ts`**: Contains the `createDb` client wrapper function which initializes Drizzle ORM using `postgres.js` (`postgres(connectionString)`).
  - **`index.ts`**: Main entrypoint exporting all tables, queries, configuration parser `parseDatabaseConfig`, and migration helpers.
  - **`queries/`**: Database queries for users, servers, memberships, and channels.
  - **`__tests__/`**: Unit tests for database clients (`db.test.ts`) and schemas (`schema.test.ts`).

### Relevant Dependencies
As specified in `packages/db/package.json`:
- `"drizzle-orm": "^0.31.0"` (ORM core)
- `"postgres": "^3.4.4"` (PostgreSQL driver)
- `"drizzle-kit": "^0.22.0"` (CLI migrations tool, devDependency)

---

## 2. Drizzle Configuration (`drizzle.config.ts`)
Since the project uses `drizzle-kit` version `^0.22.0`, the configuration must utilize the modern structure introduced in `drizzle-kit` v0.21+.

### Required Configuration Properties
1. **`schema`**: Path to the TypeScript schema file relative to the config location.
   - Value: `'./src/schema.ts'`
2. **`out`**: Directory where SQL migration scripts will be generated and stored.
   - Value: `'./migrations'` (resulting in `packages/db/migrations/` in the project structure)
3. **`dialect`**: The database engine dialect.
   - Value: `'postgresql'` (replaces the deprecated `driver` property)
4. **`dbCredentials`**: Object containing connection credentials. Since we want to use environment variables for local testing, the `url` property is used.
   - Value: `{ url: process.env.DATABASE_URL }`

### Proposed `packages/db/drizzle.config.ts` Layout
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge',
  },
});
```

---

## 3. Migration Generation CLI Commands
To generate SQL migrations using the schemas defined in `packages/db/src/schema.ts`, the following commands should be executed:

### Within the `packages/db` directory:
- CLI command to generate migrations:
  ```bash
  pnpm db:generate
  ```
  *(which runs the underlying script `drizzle-kit generate` specified in `packages/db/package.json`)*

### From the Monorepo Root Directory (`d:/livekittest`):
- Run topological workspace command:
  ```bash
  pnpm --filter @lobbyforge/db db:generate
  ```

---

## 4. Database Connection & Local Testing Configuration
Local development services are orchestrated via Docker Compose as configured in the repository.

### Default Connection Credentials (from `infra/docker/docker-compose.dev.yml`)
- **Host**: `localhost`
- **Port**: `5432` (mapped from container port `5432`)
- **Database (`POSTGRES_DB`)**: `lobbyforge` (default)
- **User (`POSTGRES_USER`)**: `lobbyforge` (default)
- **Password (`POSTGRES_PASSWORD`)**: `lobbyforge_dev` (default)

### Local Database Connection URL
Using the above credentials, the full connection URL is:
```text
postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge
```

### Environment Variables
Environment variables are parsed in `packages/db/src/index.ts` using `parseDatabaseConfig`:
- **`DATABASE_URL`** (Required): The full database connection string.
- **`DATABASE_POOL_MAX`** (Optional): Maximum database pool connection limit (defaults to `10` if omitted or invalid).
- **`DATABASE_SSL`** (Optional): A boolean string (`'true'`) to enable SSL connections.

### Local Testing Environment Setup
To run local tests or execute Next.js developer instances against this local database, developers should copy variables or configure them in:
1. **`apps/web/.env.local`** (for Next.js dev server runtime)
2. **System environment variables** (or via cross-platform shell scripting for running commands)

Example `.env.local` configuration for the web app:
```env
DATABASE_URL=postgresql://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge
DATABASE_POOL_MAX=10
DATABASE_SSL=false
```
