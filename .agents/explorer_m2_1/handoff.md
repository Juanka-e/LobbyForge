# Handoff Report: Milestone 2 — Config & SDK Scaffolding

## 1. Observation
- **Monorepo Workspace Structure**:
  - `pnpm-workspace.yaml` (lines 1-5) defines workspaces under `apps/*`, `packages/*`, and `plugins/*`.
  - Root `package.json` (lines 9-19) defines workspace execution tasks (e.g., `"test": "pnpm -r --if-present test"`, `"build": "pnpm -r --if-present build"`).
  - Target packages (`packages/config`, `packages/plugin-sdk`, `packages/bot-sdk`) currently exist as empty folders with placeholder `README.md` files (verified via `list_dir`).
- **Plugin System Requirements**:
  - `projectdetails/11_PLUGIN_SYSTEM.md` (lines 42-56) defines `PluginManifest` and `PluginPermission` contracts.
  - `projectdetails/11_PLUGIN_SYSTEM.md` (lines 85-91, 189-199) defines `GamePlugin` and `GamePluginContext` interaction APIs.
  - `projectdetails/11_PLUGIN_SYSTEM.md` (lines 220-234) defines the simulation test harness API `createTestHarness`.
- **Bot System Requirements**:
  - `projectdetails/14_BOTS_MUSIC_WATCH_PARTY.md` (lines 50-63) defines `BotPermission` options.
  - `d:\livekittest\.agents\sub_orch_m2\SCOPE.md` (lines 25-29) defines `BotManifest` and `BotLifecycleState` contracts.

## 2. Logic Chain
- **Task Alignment**: To enable the root `pnpm -r` commands to successfully compile, check types, and run tests across all workspaces:
  - Each package must define local `tsconfig.json`, `package.json`, and `vitest.config.ts` configurations.
- **Maintainability & Sharing**:
  - Compiler options should be defined in a central `@lobbyforge/config` package as `tsconfig.base.json` and `tsconfig.react.json` and extended by local packages to avoid duplication and configuration drift.
  - Vitest settings should be defined as a base configuration object (`baseVitestConfig`) inside `@lobbyforge/config/vitest.config.ts` and merged inside local configs using Vitest's `mergeConfig` utility.
- **Contract Fidelity**:
  - Interfaces in `@lobbyforge/plugin-sdk` and `@lobbyforge/bot-sdk` are designed exactly around the manifest schemas, permissions, context APIs, and test harness APIs extracted from the project documentation to ensure integration compatibility with apps and plugins in later milestones.

## 3. Caveats
- **Read-Only Mode**: No actual files in the `packages/` directory were created or modified during this investigation. Implementation must be done by the next agent.
- **React Dependency**: React has been marked as an optional peerDependency in `@lobbyforge/plugin-sdk` because components can return React nodes, but type parameters are generic (`TNode`) to preserve flexibility.

## 4. Conclusion
- The monorepo requires standardizing shared settings inside `@lobbyforge/config` and extending them per-package.
- Concrete file templates and code implementations for `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, and `@lobbyforge/bot-sdk` have been developed and documented in `analysis.md` to guarantee they satisfy compilation, testing, and contract requirements.

## 5. Verification Method
- Code verification can be performed by implementing the recommended file structures and running:
  ```bash
  pnpm install
  pnpm --filter "@lobbyforge/*" build
  pnpm --filter "@lobbyforge/*" typecheck
  pnpm --filter "@lobbyforge/*" test
  ```
- Verify that Vitest executes tests in each package and successfully achieves the 80% coverage threshold.
