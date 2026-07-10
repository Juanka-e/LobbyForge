# LobbyForge Database Migrations & Drizzle Config Investigation

This analysis documents the codebase structure, Drizzle configuration requirements, and the CLI commands required to generate database migrations for **Sub-milestone 1 (Migrations Config & Generation)** of Milestone 8.

---

## 1. Structure of `packages/db`

The database logic is isolated within the `@lobbyforge/db` workspace package. Based on the directory listing, the package has the following layout:

```text
packages/db/
├── package.json         # Package configuration and dependencies
├── tsconfig.json        # TypeScript configuration (extends base TS config)
├── vitest.config.ts     # Vitest configuration for tests
├── README.md            # Brief description of the db package
└── src/
    ├── client.ts        # Database client initialization (uses postgres.js driver)
    ├── index.ts         # Main entrypoint exporting schemas, queries, and client functions
    ├── schema.ts        # Core relational database schema (22 tables)
    ├── __tests__/       # Database client and schema tests
    └── queries/         # State-free database helper queries
        ├── channels.ts
        ├── memberships.ts
        ├── servers.ts
        └── users.ts
```

### Key Highlights:
- **`src/schema.ts`**: Contains the tables modeling the relational database structure, such as `users`, `servers`, `channels`, `memberships`, `messages`, etc.
- **`src/client.ts`**: Exports the `createDb(connectionString)` factory function which uses the `postgres` NPM driver under the hood.
- **`src/index.ts`**: Re-exports all components (`schema`, `client`, queries) and generic Drizzle operators (`sql`, `eq`, `and`, `or`, `desc`, `asc`) so consumer packages (like `apps/web`) do not need direct dependencies on Drizzle internals.

---

## 2. Drizzle Configuration (`drizzle.config.ts`)

Since there is currently no `drizzle.config.ts` file in the workspace, we must configure one under `packages/db/` to enable migration generation.

### A. Core Drizzle Config Properties
Based on Drizzle Kit `^0.22.0` (as defined in `packages/db/package.json`), the properties must be structured as follows:

| Property | Value | Rationale |
| --- | --- | --- |
| **`schema`** | `./src/schema.ts` | Path to the schema file containing Drizzle table definitions. |
| **`out`** | `./migrations` | Target directory where the SQL migrations will be output. This puts them in `packages/db/migrations`. |
| **`dialect`** | `'postgresql'` | The target database database management system dialect. (Note: `'pg'` is deprecated in modern Drizzle Kit versions in favor of `'postgresql'`). |
| **`dbCredentials`** | `{ url: process.env.DATABASE_URL \|\| 'postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge' }` | Connection parameters for migrations execution. |

### B. Proposed `drizzle.config.ts` Structure
The file should be placed at `d:\livekittest\packages\db\drizzle.config.ts`. Here is the proposed structure:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge',
  },
});
```

---

## 3. Migration Generation CLI Commands

To generate the SQL migration files matching the schema definitions, Drizzle Kit CLI is utilized.

### A. From the `packages/db` directory
When inside the `packages/db` package folder, execute the following command:
```bash
pnpm drizzle-kit generate
```
*(Alternatively, using `package.json` scripts defined in `packages/db/package.json`):*
```bash
pnpm db:generate
```

### B. From the Monorepo Root Directory
To run it from the workspace root folder without switching directories, run:
```bash
pnpm --filter @lobbyforge/db db:generate
```

---

## 4. Local Testing & Database Connection Environment

No active `.env` or `.env.local` files exist in the default git-tracked workspace. However, the docker configurations and fallback values reveal the testing credentials:

1. **Docker Compose Configuration**:
   - `infra/docker/docker-compose.dev.yml` declares the Postgres database service environment:
     ```yaml
     POSTGRES_DB: ${POSTGRES_DB:-lobbyforge}
     POSTGRES_USER: ${POSTGRES_USER:-lobbyforge}
     POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-lobbyforge_dev}
     ports:
       - "5432:5432"
     ```
   - This sets up a local PostgreSQL instance listening on `localhost:5432`.

2. **Environment Variable Template File**:
   - There is a template file at `infra/docker/.env.example` that specifies the standard database connection URL for development:
     ```bash
     DATABASE_URL=postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge
     ```

3. **Fallback Values in Code**:
   - `apps/web/lib/doctor.ts` lists a fallback Postgres connection URL:
     ```typescript
     const postgresUrl = envUrl('POSTGRES_URL', 'postgres://lobbyforge:lobbyforge_dev@localhost:5432/lobbyforge');
     ```

### Testing Steps:
To run database tests or test migrations locally, developers should:
1. Copy `infra/docker/.env.example` to `.env` at the root level of the project.
2. Spin up the dev docker stack:
   ```bash
   docker compose -f infra/docker/docker-compose.dev.yml up -d
   ```
3. Run the migrations generator:
   ```bash
   pnpm --filter @lobbyforge/db db:generate
   ```
