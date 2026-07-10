# Handoff Report: Explorer M2-3

## 1. Observation
- The workspace root contains a `PROJECT.md` specifying:
  - Line 7: `packages/*`: Shared internal packages and SDKs (bot-sdk, config, core, db, i18n, plugin-sdk, ui).
  - Line 17-18: Milestone 2 "Config & SDK Scaffolding" to scaffold `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk`.
- The sub-orchestrator's `SCOPE.md` at `d:\livekittest\.agents\sub_orch_m2\SCOPE.md` specifies:
  - Line 12: `@lobbyforge/config` containing TS base configuration definitions.
  - Line 13: `@lobbyforge/plugin-sdk` containing manifest types, lifecycle types, and testing helper stubs (`src/testing.ts`).
  - Line 14: `@lobbyforge/bot-sdk` containing bot types, permissions, and lifecycle structures.
  - Line 17-29: Interface contracts specifying the required structure for `PluginManifest`, `PluginPermission`, `GamePluginContext`, `GamePlugin`, and `testing/createTestHarness` for plugins; and `BotPermission`, `BotManifest`, `BotLifecycleState` for bots.
- The `projectdetails` directory contains architectural designs:
  - `03_TECH_STACK_DECISIONS.md` indicates the use of `pnpm workspace` (Line 140) and Zod schema validations.
  - `11_PLUGIN_SYSTEM.md` defines context methods (e.g. `ctx.players.list()`, `ctx.scores.add()`) and the `createTestHarness` structure (Line 220).
  - `14_BOTS_MUSIC_WATCH_PARTY.md` defines bot lifecycle states and permissions.
  - `25_TESTING_STRATEGY.md` describes a multi-layered testing strategy targeting 90%+ code coverage for business logic using Vitest (Line 11, Line 297).
- Directory listings show `packages/config`, `packages/plugin-sdk`, and `packages/bot-sdk` only contain a template `README.md` file (all source directories are currently empty).

## 2. Logic Chain
- Since `@lobbyforge/config` is designed to standardize typescript and build configurations for all other monorepos:
  - It must export reusable JSON structures (`tsconfig.base.json` and `tsconfig.package.json`).
  - Other packages must extend these configurations by referencing `@lobbyforge/config/tsconfig.package.json` in their local `tsconfig.json`.
- Since `@lobbyforge/plugin-sdk` and `@lobbyforge/bot-sdk` require compilation before usage, standard build tasks (`tsup`) should compile TypeScript into output dual-bundles (CommonJS and ESM).
- Since `vitest` needs to run across different package configurations:
  - A hybrid workspace strategy is recommended where each package configures its own local tests, and a `vitest.workspace.ts` at the monorepo root integrates all packages into a single execution context.
- The contract definitions for plugins (manifest, permission, context) and bots (permissions, manifest, lifecycle) must match the interface descriptions inside `SCOPE.md`, `11_PLUGIN_SYSTEM.md`, and `14_BOTS_MUSIC_WATCH_PARTY.md` to ensure future compatibility with client apps and plugins.
- We have documented the exact templates for these configurations, packages, TS code interfaces, and test files inside `analysis.md` so that the Implementer agent can build these files directly.

## 3. Caveats
- Since this is a read-only investigation, the proposed files have not been physically written to the `packages/` directory. They must be created by the Implementer agent in the next phase.
- No third-party network APIs or external packaging verification has been executed locally because the agent operates in `CODE_ONLY` network mode.

## 4. Conclusion
- Standardized package boilerplate files (`package.json`, `tsconfig.json`, `src/index.ts`, and test files) for `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, and `@lobbyforge/bot-sdk` have been successfully designed.
- Using `tsup` for compilation and a root-level `vitest.workspace.ts` for unified test runner execution is the most robust strategy for these packages.
- The precise proposed templates are available at `d:\livekittest\.agents\explorer_m2_3\analysis.md`.

## 5. Verification Method
1. Ensure the folders `packages/config`, `packages/plugin-sdk`, and `packages/bot-sdk` are populated with the configurations recommended in `analysis.md`.
2. Run `pnpm install` at the monorepo root to link workspace dependencies.
3. Run `pnpm build` or `pnpm -r build` to ensure all packages successfully compile to `./dist/` using `tsup`.
4. Run `pnpm test` at the monorepo root to ensure Vitest correctly detects all unit tests across the workspaces and all tests pass.
