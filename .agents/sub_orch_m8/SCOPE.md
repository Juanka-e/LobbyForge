# Scope: Milestone 8: Database & Migrations

## Architecture
- `packages/db` exports the database schema, client, and migrations configuration.
- `apps/web` connects to the database via `@lobbyforge/db` using `DATABASE_URL`.
- `apps/web` runs programmatic migrations on boot (e.g. via Next.js instrumentation or custom boot hook).
- API routes `/api/auth/guest`, `/api/servers`, and the Postgres doctor probe query the real database.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Migrations Config & Generation | Drizzle config setup, migrations generation in packages/db | None | PLANNED |
| 2 | Programmatic Migration Runner | Setup apps/web startup hooks/instrumentation to auto-apply migrations on boot | 1 | PLANNED |
| 3 | API Integration & Testing | Hook up pg probe, guest auth, and servers APIs to real database + write unit/integration tests | 2 | PLANNED |

## Interface Contracts
### @lobbyforge/db ↔ apps/web
- `@lobbyforge/db` exports database schema, helpers, and client instance.
- `apps/web` calls exported helper functions instead of using mock data.
