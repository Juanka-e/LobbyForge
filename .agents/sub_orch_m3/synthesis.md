# Synthesis Report: Milestone 3 Exploration & Analysis

This report synthesizes the findings and design proposals of the three Explorer agents:
- **Explorer 1** (`ef0e62ec-8941-44a6-807c-aa0b2a236be9`)
- **Explorer 2** (`1d33b988-55ab-41a4-8616-6f2b6fea0c3d`)
- **Explorer 3** (`231bd9ec-5329-4f16-855e-fccff411974b`)

## Consensus
All explorers agree on the general scaffolding plan and file layout for the four packages under `packages/`:
1. **TypeScript Configurations**:
   - Each package must extend `@lobbyforge/config/tsconfig.base.json`.
   - `@lobbyforge/ui` requires `"jsx": "react-jsx"` in its `compilerOptions`.
2. **Package Configurations (`package.json`)**:
   - Must be configured as ES Modules (`"type": "module"`).
   - Must export entry points correctly (e.g. `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`).
   - Scripts: `build`, `typecheck`, `test`, `lint`.
   - Dev dependencies: `typescript`, `vitest`, and reference `@lobbyforge/config: "workspace:*"` (and `@lobbyforge/core` for other packages where needed).
3. **Vitest Configurations**:
   - Local `vitest.config.ts` must use `'node'` environment (except `@lobbyforge/ui` which needs `'happy-dom'` or similar for React testing).
   - Include test paths matching `src/__tests__/**/*.test.ts` (or `.tsx` for `@lobbyforge/ui`).

## Detailed Scaffolding Plan

### `@lobbyforge/core`
- **Location**: `packages/core`
- **Role**: Shared domain logic, types, permissions.
- **Key Files**:
  - `package.json`, `tsconfig.json`, `vitest.config.ts`
  - `src/permissions.ts`: Core permission definitions and `hasPermission` utility.
  - `src/types.ts`: Core schema type interfaces matching Postgres database schema.
  - `src/index.ts`: Entrypoint exporting permissions and types.
  - `src/__tests__/permissions.test.ts`: Vitest unit tests verifying permission checks.

### `@lobbyforge/db`
- **Location**: `packages/db`
- **Role**: Database access using Drizzle ORM.
- **Key Files**:
  - `package.json` (includes `drizzle-orm`, `postgres`, `drizzle-kit`), `tsconfig.json`, `vitest.config.ts`
  - `src/schema.ts`: Drizzle pgTable schema mapping the 21 database tables.
  - `src/client.ts`: Database client instantiation helper (`createDb`).
  - `src/index.ts`: Entrypoint exporting schema, client, and selected Drizzle helper functions.
  - `src/__tests__/db.test.ts`: Vitest unit tests verifying client construction.

### `@lobbyforge/i18n`
- **Location**: `packages/i18n`
- **Role**: Translation management, locale fallback resolution, parameter interpolation.
- **Key Files**:
  - `package.json`, `tsconfig.json`, `vitest.config.ts`
  - `locales/en.json` & `locales/tr.json`: Base translation assets.
  - `src/locales.ts`: Type and map definition of locales.
  - `src/translator.ts`: `t()` helper that resolves translation keys with fallback logic (user locale -> server default -> 'en') and supports parameter interpolation.
  - `src/validator.ts`: Translation format validator that verifies key and placeholder parity.
  - `src/index.ts`: Entrypoint exporting all translator and validator components.
  - `src/__tests__/translator.test.ts` & `src/__tests__/validator.test.ts`: Vitest unit tests.

### `@lobbyforge/ui`
- **Location**: `packages/ui`
- **Role**: React visual component library.
- **Key Files**:
  - `package.json` (includes peerDependencies for `react` and `react-dom`), `tsconfig.json`, `vitest.config.ts`
  - `src/Button.tsx`, `src/Modal.tsx`, `src/Card.tsx`, `src/Tooltip.tsx`, `src/Avatar.tsx`, `src/Spinner.tsx`: React components placeholders.
  - `src/index.ts`: Export all components.
  - `src/__tests__/Button.test.tsx`: Vitest + React Testing Library component tests.

## Verification Protocol
1. Run `pnpm install` from the root directory to install and link workspace dependencies.
2. Run `pnpm typecheck` recursively.
3. Run `pnpm build` recursively.
4. Run `pnpm test` recursively.
