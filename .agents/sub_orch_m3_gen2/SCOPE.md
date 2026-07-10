# Scope: Milestone 3 — Core & Shared Packages Scaffolding

## Architecture
- lobbyforge is structured as a pnpm monorepo.
- The shared packages to be scaffolded are located in `packages/`:
  - `@lobbyforge/core`: Core domain types, system permissions, and validation rules.
  - `@lobbyforge/db`: Prisma-based database helpers, client scaffolding, and repository patterns.
  - `@lobbyforge/i18n`: Internationalization helpers, key resolution utilities.
  - `@lobbyforge/ui`: Reusable UI components (like Buttons, Modals, placeholders).
- Base configurations:
  - Extend TypeScript configuration from `@lobbyforge/config` (`@lobbyforge/config/tsconfig.base.json`).
  - Unit tests run using Vitest.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration & Analysis | Analyze requirements, verify tsconfig.base, and draft scaffolding details | None | DONE |
| 2 | `@lobbyforge/core` Scaffolding | Create tsconfig.json, package.json, src/index.ts, and tests | M1 | DONE |
| 3 | `@lobbyforge/db` Scaffolding | Create tsconfig.json, package.json, src/index.ts, and tests | M1 | DONE |
| 4 | `@lobbyforge/i18n` Scaffolding | Create tsconfig.json, package.json, src/index.ts, and tests | M1 | DONE |
| 5 | `@lobbyforge/ui` Scaffolding | Create tsconfig.json, package.json, src/index.ts, and tests | M1 | DONE |
| 6 | Unified Verification & Audit | Run pnpm build, test, lint, and typecheck at the monorepo root; run Forensic Auditor | M2, M3, M4, M5 | DONE |

## Interface Contracts
### @lobbyforge/core
- Exports core types (e.g. `User`, `Lobby`, `Session`) and permission guards.

### @lobbyforge/db
- Exports database client initialization helper (`getDbClient`) or prisma client wrapper.

### @lobbyforge/i18n
- Exports i18n key resolution function (e.g., `t(key: string, variables?: Record<string, string>): string`).

### @lobbyforge/ui
- Exports UI components and design tokens placeholders.
