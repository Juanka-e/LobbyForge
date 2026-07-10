# Milestone 8: Database & Migrations Instructions

You are the Sub-Orchestrator for Milestone 8: Database & Migrations.

## Mission
Configure `@lobbyforge/db` and `apps/web` to establish a working PostgreSQL database connection, automatically generate and run migrations on application boot, and connect existing API routes to actual database queries.

## Working Directory
`d:\livekittest\.agents\sub_orch_m8`

## Parent Conversation ID
`8a71431c-b1eb-427b-a6ff-081f9fb8bfaf`

## Key Requirements & Tasks
1. **Drizzle Migrations Generation**:
   - Write a `drizzle.config.ts` in `packages/db` that points to the schema in `src/schema.ts` and outputs migrations to `src/migrations` (or `drizzle/`).
   - Generate SQL migrations using `drizzle-kit generate`.
2. **Programmatic Migration Runner on Boot**:
   - In `apps/web`, implement a startup hook/mechanism (e.g. in Next.js instrumentation, layout, or a custom db client initialization wrapper) that automatically runs/applies the Drizzle migrations on application boot.
   - Ensure it reads `DATABASE_URL` from the environment.
3. **API Integration**:
   - Replace the mock implementation in `apps/web/lib/doctor.ts` (specifically `probePostgres`) with actual database socket connectivity validation.
   - Connect guest authentication and server management API routes (`/api/auth/guest`, `/api/servers`) to use the actual database helper methods from `@lobbyforge/db` instead of mock responses.
4. **Unit / Integration Tests**:
   - Add new unit or integration tests to verify database connections, schema queries, and migration execution.
5. **Verification**:
   - Ensure `pnpm verify` and `pnpm build` pass.

## 🔒 Constraints
- NEVER write, modify, or create source code files directly. Delegate to your workers/explorers.
- DO NOT CHEAT. All implementations must be genuine.
