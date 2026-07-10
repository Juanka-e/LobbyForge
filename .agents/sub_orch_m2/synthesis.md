# Milestone 2 Exploration Synthesis

## Catalog of Inputs
- **Explorer 1 (03bf0256-2c16-43d4-b121-896986fdfa42)**: Recommended extensible base TS config, shared Vitest base config with local merges, separate `@lobbyforge/plugin-sdk/testing` export, and `tsc` for compilation.
- **Explorer 2 (6ef2a6fc-1af2-4da9-9e4e-665e48aa8f96)**: Recommended base TS config, hybrid Vitest setup (root `vitest.workspace.ts` + per-package configs), ESM module strategy (`"type": "module"`), `tsc` compilation to keep build tooling simple and lightweight.
- **Explorer 3 (51eb5a4e-c370-4bc6-973e-cfcbb53fb740)**: Recommended extensible base TS config, hybrid Vitest setup, `tsup` bundler for dual CJS/ESM formats.

## Consensus
1. **Shared Configuration Strategy**:
   - TS: A central `tsconfig.base.json` defined in `@lobbyforge/config` that other packages extend via `tsconfig.json`.
   - Vitest: Per-package `vitest.config.ts` running in `"node"` environment (for SDKs) paired with a root `vitest.workspace.ts` to allow monorepo-wide test runs via `pnpm test`.
2. **Package Structure**:
   - `@lobbyforge/config` standardizes environment parsing via Zod.
   - `@lobbyforge/plugin-sdk` exports `PluginManifest`, `PluginPermission` (enum), `GamePluginContext`, `GamePlugin` interface, and `createTestHarness` inside a `testing` subpath.
   - `@lobbyforge/bot-sdk` exports `BotPermission` (enum), `BotManifest`, `BotLifecycleState`, `BotClient`/`Bot` interfaces, and custom mockable structures.
3. **Target Directories**:
   - `packages/config`
   - `packages/plugin-sdk`
   - `packages/bot-sdk`

## Resolved Conflicts
- **Build Tooling (tsc vs tsup)**:
  - *Conflict*: Explorer 3 proposed `tsup` for compiling to ESM/CJS, while Explorers 1 and 2 proposed simple `tsc` targeting ESM (`"type": "module"`).
  - *Resolution*: We will use simple `tsc` compiling to ESM. Using `tsc` avoids introducing third-party bundler dependencies like `tsup` at this early skeleton stage, reducing download overhead and simplifying package configs.
- **Vitest Config Sharing**:
  - *Conflict*: Explorer 1 suggested importing a shared vitest config file, while Explorers 2 and 3 recommended simple per-package `vitest.config.ts` files with root workspace configuration.
  - *Resolution*: We will configure a root `vitest.workspace.ts` and simple local `vitest.config.ts` files in each package. This keeps vitest configuration minimal and easy to customize if UI components are introduced in future milestones.

## Output Specification (Handoff for Worker)
See `.agents/sub_orch_m2/SCOPE.md` and the synthesized file templates in this report.
