# Drizzle Configuration Analysis - `@lobbyforge/db`

This report provides an analysis of how to configure `drizzle.config.ts` in the `@lobbyforge/db` package (`packages/db`). It identifies the optimal directory for migrations, explains TypeScript compiler compatibility constraints (such as `rootDir` and `NodeNext` resolution), and details package scripts and dependency considerations for integration with `drizzle-kit`.

---

## 1. Recommended `drizzle.config.ts` Configuration

With `drizzle-kit` version `^0.22.0` (as defined in `packages/db/package.json`), the configuration schema uses the new `defineConfig` utility from `drizzle-kit`.

The recommended file content for `packages/db/drizzle.config.ts` is:

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

### Key Parameters:
*   `schema`: Points directly to the Drizzle schema definition file at `./src/schema.ts`.
*   `out`: Specifies the output directory for generated migrations (`./drizzle`).
*   `dialect`: Specifies `'postgresql'` (replaces the deprecated `driver` and `dbCredentials` schema configurations from older drizzle-kit versions).
*   `dbCredentials.url`: Resolves the database connection string, defaulting to local dev configurations from `infra/docker/docker-compose.dev.yml`.

---

## 2. Migration Storage Directory: `drizzle/` vs. `src/migrations/`

We compared storing database migrations in `packages/db/drizzle/` (root-level) versus `packages/db/src/migrations/`. 

### Comparison Table

| Dimension | `packages/db/drizzle/` (Recommended) | `packages/db/src/migrations/` |
| :--- | :--- | :--- |
| **Separation of Concerns** | **Excellent.** Non-source code files (.sql files, JSON schema snapshots, journals) reside outside the source directory. | **Poor.** Developer source files are mixed with auto-generated tooling artifacts. |
| **TypeScript Compilation (`tsc`)** | **No Impact.** Files are outside the `./src` folder, so they are not scanned or processed by TS compilation. | **Risk of issues.** TS compiler scans files within `src/` but ignores non-TS files (e.g. `.sql` and `.json`), meaning they are not copied to `dist/`. |
| **Build Directory Consistency** | **Consistent.** Neither source nor output has migrations in the build directories. Runtime resolution happens by traversing paths relative to the package root. | **Inconsistent.** The `.sql` migrations folder exists in `src/migrations` but will be missing from `dist/migrations/` after `tsc` compiles, causing runtime file-not-found errors if run from `dist/`. |
| **Drizzle Conventions** | **Standard.** Root-level `./drizzle` is the default output folder for drizzle-kit migrations. | **Non-standard.** Requires explicit custom script overrides or bundling solutions to copy static assets. |

### Justification:
The migrations must be stored at the package root level in **`packages/db/drizzle/`**. Storing files in `src/` requires adding file-copy operations (e.g., `copyfiles` or custom build step) to ensure migration `.sql` files are copied to `dist/` because the TypeScript compiler (`tsc`) does not copy static assets. Keeping it in `drizzle/` ensures clean compilation.

---

## 3. TypeScript Compiler and Exports Compatibility

### Exclude `drizzle.config.ts` from `tsconfig.json`
`packages/db/tsconfig.json` contains:
```json
{
  "extends": "@lobbyforge/config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```
*   **The Constraint:** The `rootDir` is configured to `./src`.
*   **The Issue:** If `drizzle.config.ts` (located at `packages/db/drizzle.config.ts`) were added to the `include` glob patterns, `tsc` would attempt to compile it and fail with the compiler error:
    ```
    error TS6059: File 'packages/db/drizzle.config.ts' is not under 'rootDir' 'src'. 'rootDir' must contain all source files.
    ```
*   **The Resolution:** Keep `drizzle.config.ts` excluded from `tsconfig.json` compilation by keeping `"include": ["src/**/*"]`.
*   **Tooling Execution:** `drizzle-kit` compiles and runs `drizzle.config.ts` using its own internally-bundled `tsx`/`esbuild` environment. It does not invoke or rely on the local `tsc` workspace build. It only reads the TS config to find paths, and will ignore rootDir constraints when evaluating the config.

### Module and Resolution Compatibility (`NodeNext`)
*   `packages/config/tsconfig.base.json` defines `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`.
*   In ESM modules (`"type": "module"` in `package.json`), all runtime relative imports in code files must include a `.js` extension (e.g., `import * as schema from './schema.js'`).
*   This rule is already correctly followed in `packages/db/src/client.ts` and `packages/db/src/index.ts`.
*   For `drizzle.config.ts`, importing from `./src/schema.ts` inside a configuration file parsed by `drizzle-kit`'s custom bundler is fully supported (using the path `./src/schema.ts` or `./src/schema.js`).

---

## 4. `package.json` Scripts and Dependencies Analysis

### Defined scripts:
```json
"scripts": {
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "db:generate": "drizzle-kit generate",
  "db:push": "drizzle-kit push"
}
```
*   When executing `pnpm --filter @lobbyforge/db db:generate`, the current working directory for the process is `packages/db`. `drizzle-kit` automatically loads the config file located at `packages/db/drizzle.config.ts`.
*   `db:push` allows developers to push schema changes directly to the database in development environments without generating migration files.

### Dependencies:
*   `drizzle-orm` is at `^0.31.0` and `drizzle-kit` is at `^0.22.0`.
*   No additional bundlers or devDependencies are required since `drizzle-kit` handles the TS compilation of its config file out-of-the-box.

---

## 5. Running Migrations Programmatically at Runtime

Since migrations are stored at `packages/db/drizzle/`, consumer applications (like `apps/web`) need to know where the `.sql` migration files are located when starting up. 

A programmatic migration function can be exported from `@lobbyforge/db` (e.g., in `src/client.ts` or `src/index.ts`) so that consumers don't have to guess or hardcode relative paths.

### Recommended Helper Implementation:
```typescript
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'url';
import path from 'path';
import { type DbClient } from './client.js';

/**
 * Runs pending Drizzle migrations against the database.
 * Resolves the path of the 'drizzle' directory relative to the compiled package in 'dist'.
 */
export async function runMigrations(db: DbClient) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  
  // Since this code compiles to 'packages/db/dist/index.js',
  // and migrations are in 'packages/db/drizzle/',
  // the migrations folder is located at '../drizzle'.
  const migrationsFolder = path.resolve(__dirname, '../drizzle');
  
  await migrate(db, { migrationsFolder });
}
```

This ensures that regardless of where the monorepo workspace package is executing, the migrations path will resolve correctly relative to the build artifacts inside the package's folder structure.
