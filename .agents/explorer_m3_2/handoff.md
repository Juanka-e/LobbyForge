# Handoff Report: Milestone 3 Scaffolding & Analysis

This report outlines the analysis and structural recommendations for the creation and integration of four new packages in the LobbyForge monorepo: `@lobbyforge/core`, `@lobbyforge/db`, `@lobbyforge/i18n`, and `@lobbyforge/ui`.

---

## 1. Observation

- **Root Config Files**:
  - `pnpm-workspace.yaml` (lines 1-4):
    ```yaml
    packages:
      - 'apps/*'
      - 'packages/*'
      - 'plugins/*'
    ```
  - `vitest.workspace.ts` (lines 3-7):
    ```typescript
    export default defineWorkspace([
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'plugins/*/vitest.config.ts'
    ]);
    ```
  - `package.json` (lines 9-18):
    ```json
    "scripts": {
      "build": "pnpm -r --if-present build",
      "dev": "pnpm -r --if-present --parallel dev",
      "lint": "pnpm -r --if-present lint",
      "typecheck": "pnpm -r --if-present typecheck",
      "test": "pnpm -r --if-present test",
      ...
    }
    ```

- **Config & SDK Architecture**:
  - `packages/config/package.json` specifies `"type": "module"`, `"main": "./dist/index.js"`, and exports `"./tsconfig.base.json": "./tsconfig.base.json"`.
  - `packages/config/tsconfig.base.json` provides a base compiler configuration targeting `ES2022`, module resolution `NodeNext`, with declaration generation enabled.
  - `packages/bot-sdk/tsconfig.json` and `packages/plugin-sdk/tsconfig.json` both extend `@lobbyforge/config/tsconfig.base.json`.

- **Existing Placeholder Directories**:
  - `packages/core`, `packages/db`, `packages/i18n`, and `packages/ui` exist as directories containing only a basic `README.md`.

- **Milestone Specifications**:
  - `projectdetails/06_DATABASE_POSTGRESQL_SCHEMA.md` lists the tables: `users`, `servers`, `channels`, `roles`, `memberships`, `messages`, `invites`, etc.
  - `projectdetails/09_AUTH_SECURITY_PRIVACY.md` outlines the local permission requirements (`kick`, `ban`, `mute`, `deafen`, etc.).
  - `projectdetails/15_I18N_JSON.md` defines language translation keys and fallback logic.

---

## 2. Logic Chain

1. **Workspace and Test Integration**:
   - Because `pnpm-workspace.yaml` includes `packages/*` and `vitest.workspace.ts` defines `packages/*/vitest.config.ts`, pnpm and vitest automatically discover any package placed inside `packages/` that has its own `package.json` and `vitest.config.ts`.
   - Therefore, we conclude that no changes are needed to the root configurations for workspace integration of the four new packages.

2. **TypeScript & Transpilation Consistency**:
   - Both `packages/bot-sdk` and `packages/plugin-sdk` extend `@lobbyforge/config/tsconfig.base.json` and export types under standard ESM exports.
   - We must design the new packages to extend the same configuration (`@lobbyforge/config/tsconfig.base.json`) and run `tsc` for building, ensuring compiler and module output uniformity.

3. **Core Permissions & Validation (`@lobbyforge/core`)**:
   - The permission system check specified in `projectdetails/09_AUTH_SECURITY_PRIVACY.md` and `projectdetails/25_TESTING_STRATEGY.md` relies on an ownership check or matching the role permission structure.
   - Zod validation is used at boundaries. We must define schema schemas and the `hasPermission` utility function as exports of the `@lobbyforge/core` package to serve as the single source of truth.

4. **Database Helpers (`@lobbyforge/db`)**:
   - According to system details, Drizzle ORM is utilized for PostgreSQL access.
   - Therefore, `@lobbyforge/db` must implement the database tables in a `schema.ts` matching the spec tables, export connection client initializers in `client.ts` receiving configuration parameters, and declare relational schema configs.

5. **Internationalization Helpers (`@lobbyforge/i18n`)**:
   - The design spec demands language resolution fallbacks (`locale -> defaultLocale -> en`).
   - We must create a `Translator` helper class inside `@lobbyforge/i18n` with variable interpolation logic (`{param}`) and a verification script to enforce locale file key symmetry.

6. **UI Component Placeholders (`@lobbyforge/ui`)**:
   - The UI components will be built on React, which requires a compiler configured with JSX processing.
   - Setting `"jsx": "react-jsx"` in `tsconfig.json` and using `happy-dom` as the testing environment inside `@lobbyforge/ui` ensures unit testing capability of components without starting a full browser.

---

## 3. Caveats

- **Network Restrictions**: Since we are in `CODE_ONLY` network mode, external packages or tools (like external DB initializations or docker registries) were not contacted.
- **Drizzle Migrations**: Actual migration files and the drizzle configuration (e.g., database credentials setup) depend on a running PostgreSQL server, which was not executed locally during our analysis phase.
- **React version**: We assume React 18/19 compatibility as matching `@lobbyforge/plugin-sdk` dependencies list.

---

## 4. Conclusion

The monorepo workspace is fully structured to support `@lobbyforge/core`, `@lobbyforge/db`, `@lobbyforge/i18n`, and `@lobbyforge/ui` out-of-the-box. Creating the package directories with matching manifests, tsconfigs extending the base config, vitest configurations, and core code structures will seamlessly boot the packages and verify compilation and unit tests automatically in the existing monorepo.

All files to create and edit have been mapped out in detail in the `analysis.md` file located at:
`d:\livekittest\.agents\explorer_m3_2\analysis.md`.

---

## 5. Verification Method

To independently verify the plan once the implementer executes the scaffolding:

1. **Verify workspace recognition**:
   Run `pnpm install` at the root and verify the lockfile updates to register the four workspaces.
2. **Build and Typecheck verification**:
   Run `pnpm build` and `pnpm typecheck` at the root to check all packages output `dist/` compilation artifacts without errors.
3. **Execution of tests**:
   Run `pnpm test` at the root. Vitest must run all tests including:
   - `packages/core/src/__tests__/permissions.test.ts`
   - `packages/core/src/__tests__/validation.test.ts`
   - `packages/db/src/__tests__/db.test.ts`
   - `packages/i18n/src/__tests__/i18n.test.ts`
   - `packages/ui/src/components/__tests__/Button.test.tsx`
4. **CI i18n check validation**:
   Run `pnpm --filter @lobbyforge/i18n i18n:check` and verify it checks all json locales for key completeness.
