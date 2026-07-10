# Handoff Report

## 1. Observation
- `apps/web/package.json` defines next dependency at line 30: `"next": "^15.0.3"`, `drizzle-orm` at line 28: `"drizzle-orm": "^0.31.2"`, and workspace dependency at line 24: `"@lobbyforge/db": "workspace:*"`.
- `apps/web/next.config.mjs` exports `nextConfig` which lists transpiled packages in `transpilePackages` (lines 7–11):
  ```javascript
  transpilePackages: [
    '@lobbyforge/core',
    '@lobbyforge/i18n',
    '@lobbyforge/ui',
  ],
  ```
  `@lobbyforge/db` is not included in this list, meaning Next.js consumes the compiled outputs of `@lobbyforge/db` from `packages/db/dist` directly.
- `apps/web/tsconfig.json` specifies included compilation files at line 21:
  ```json
  "include": ["next-env.d.ts", "src/**/*", "app/**/*", "lib/**/*.ts", ".next/types/**/*.ts"],
  ```
  This path selection does not include files at the root level (like `apps/web/instrumentation.ts`).
- `packages/db/package.json` defines Drizzle dependencies at lines 25–29:
  ```json
  "dependencies": {
    "@lobbyforge/config": "workspace:*",
    "@lobbyforge/core": "workspace:*",
    "drizzle-orm": "^0.31.0",
    "postgres": "^3.4.4"
  },
  "devDependencies": {
    "drizzle-kit": "^0.22.0",
  ```
  and migration/schema push scripts at lines 19–20:
  ```json
  "db:generate": "drizzle-kit generate",
  "db:push": "drizzle-kit push"
  ```
- `packages/db/src/client.ts` initializes the database wrapper at lines 1–11 using `drizzle-orm/postgres-js` and `postgres`:
  ```typescript
  import { drizzle } from 'drizzle-orm/postgres-js';
  import postgres from 'postgres';
  import * as schema from './schema.js';
  ```
- No `drizzle.config.ts` config file or `migrations` directory exists under `packages/db`.

---

## 2. Logic Chain
1. **Next.js Version Hook Requirements**:
   - Because `next` dependency is `^15.0.3` (Observation 1), the instrumentation hook is **stable** and enabled by default in Next.js 15. The experimental flag `experimental.instrumentationHook` is **not needed** in `next.config.mjs` (Observation 2).
   - Because `app/` is at the root of `apps/web` (Observation 3), Next.js looks for `instrumentation.ts` in the root of `apps/web`.
   - Because `instrumentation.ts` sits at the root, it falls outside `tsconfig.json`'s `include` array (Observation 3). Therefore, TS `include` must be updated to cover `instrumentation.ts`.
2. **Build-Time Bypassing & Environment Constraints**:
   - Next.js runs the instrumentation `register()` hook during both dev/start and `next build` time. Because the database might not be available during build time, we must verify `process.env.NEXT_PHASE !== 'phase-production-build'` and `process.env.NEXT_RUNTIME === 'nodejs'` before calling migration functions, preventing build failures.
3. **Database Migration Strategy**:
   - Because the database client in `@lobbyforge/db` is based on `postgres-js` (Observation 5), the correct migrator is `drizzle-orm/postgres-js/migrator`.
   - Because `drizzle-kit` requires a config to generate migrations (Observation 4), a `drizzle.config.ts` must be created under `packages/db`.
   - Running migrations on the shared connection pool is problematic (cannot close connection cleanly). Therefore, the migration runner should create a temporary `postgres` single-connection client, execute migrations, and close it using `client.end()`.
   - Encapsulating this migration runner under `@lobbyforge/db` (e.g. in `packages/db/src/migrator.ts` and exporting it from `index.ts`) allows reuse by other packages/apps and hides database-specific migration logic from the web app.

---

## 3. Caveats
- **Deployment Monorepo Paths**: Standalone build modes or deployment packaging must preserve `packages/db/migrations` or customize/override the folder location via the recommended `MIGRATIONS_FOLDER` environment variable.
- **Local Database Availability**: To test the migrations execution in development, a local Postgres instance must be running and matches `DATABASE_URL`.

---

## 4. Conclusion
- A programmatic migration runner can be implemented cleanly using Next.js 15 instrumentation.
- No `experimental.instrumentationHook` is required in `next.config.mjs`.
- The implementation requires creating `apps/web/instrumentation.ts` (bypassing during build compile phase), editing `apps/web/tsconfig.json` to include the root file, creating `packages/db/drizzle.config.ts`, and implementing a short-lived single-connection migration runner in `packages/db/src/migrator.ts`.

---

## 5. Verification Method
1. **TypeScript Compilation Check**:
   Run `pnpm --filter @lobbyforge/web typecheck` to verify that `apps/web/instrumentation.ts` compiles successfully without type errors.
2. **Check Migration Generation**:
   Add `packages/db/drizzle.config.ts`, run `pnpm --filter @lobbyforge/db db:generate`, and verify SQL migration files are generated under `packages/db/migrations`.
3. **Runtime Check**:
   Start the dev environment with a running PostgreSQL using `DATABASE_URL=... pnpm --filter @lobbyforge/web dev` and inspect the logs to verify that `[App Boot] Executing programmatic database migrations...` and `Migrations executed successfully` prints on start.
