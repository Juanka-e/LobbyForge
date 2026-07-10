## 2026-06-09T19:47:12Z
You are the Worker for Milestone 2.
Your working directory is d:\livekittest\.agents\worker_m2.

Your task is to implement the scaffolding for @lobbyforge/config, @lobbyforge/plugin-sdk, and @lobbyforge/bot-sdk packages under packages/.
Please refer to the synthesized recommendations at d:\livekittest\.agents\sub_orch_m2\synthesis.md and the explorer reports at:
- d:\livekittest\.agents\explorer_m2_2\analysis.md
- d:\livekittest\.agents\explorer_m2_3\analysis.md

Specifically, you need to create:
1. `packages/config` containing:
   - `package.json`
   - `tsconfig.base.json`
   - `tsconfig.json`
   - `vitest.config.ts`
   - `src/index.ts` (defining AppConfigSchema using zod and loadConfig)
   - `src/__tests__/config.test.ts` (with at least one passing unit test)

2. `packages/plugin-sdk` containing:
   - `package.json` (specifying peerDependency on react)
   - `tsconfig.json` (extending @lobbyforge/config/tsconfig.base.json)
   - `vitest.config.ts`
   - `src/index.ts` (defining PluginPermission enum/type, PluginManifest, GamePluginContext, and GamePlugin interfaces)
   - `src/testing.ts` (exporting createTestHarness simulation utility)
   - `src/__tests__/plugin-sdk.test.ts` (with at least one passing unit test using createTestHarness)

3. `packages/bot-sdk` containing:
   - `package.json`
   - `tsconfig.json` (extending @lobbyforge/config/tsconfig.base.json)
   - `vitest.config.ts`
   - `src/index.ts` (defining BotPermission, BotManifest, BotLifecycleState, BotClient/Bot interfaces)
   - `src/__tests__/bot-sdk.test.ts` (with at least one passing unit test)

4. Root `vitest.workspace.ts` containing the workspace configuration so that running tests from the root is supported.

Execution & Verification:
- Run `pnpm install` at the root to link the workspace packages and download all dependencies (zod, typescript, vitest, etc.).
- Ensure that each package can be built (`pnpm build`), typechecked (`pnpm typecheck`), and tested (`pnpm test`) successfully.
- Verify linting. Since there is no root ESLint config, if ESLint is required, you can create a minimal eslint.config.js at the root or configure packages to run local linting successfully.
- Provide a detailed handoff report in d:\livekittest\.agents\worker_m2\handoff.md documenting the created files, verification commands used, and their output.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
