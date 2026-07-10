# Handoff Report — Explorer 2 for Milestone 2

## 1. Observation
- **Root Directory Structure**: The workspace is a monorepo setup using pnpm. The workspace paths are declared in `pnpm-workspace.yaml` (lines 1-4):
  ```yaml
  packages:
    - 'apps/*'
    - 'packages/*'
    - 'plugins/*'
  ```
- **Target Directories**: The target directories `packages/config`, `packages/plugin-sdk`, and `packages/bot-sdk` currently only contain `README.md` files:
  - `packages/config/README.md` line 3: `"Shared config, lint, TypeScript, and tooling presets."`
  - `packages/plugin-sdk/README.md` line 3: `"Plugin APIs extracted from real plugin implementations."`
  - `packages/bot-sdk/README.md` line 3: `"Future bot-facing APIs and helpers."`
- **Root `package.json`**: Root scripts utilize recursive package manager commands for monorepo-wide execution (lines 9-19):
  ```json
  "scripts": {
    "build": "pnpm -r --if-present build",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    ...
  }
  ```
- **Interface Contracts & Requirements**:
  - `SCOPE.md` (lines 12-15) defines Milestone 2 as scaffolding config, plugin-sdk, and bot-sdk with their own `package.json`, `tsconfig.json`, `src/index.ts`, and unit tests.
  - `SCOPE.md` (lines 19-23) specifies the required contracts for `plugin-sdk`: `PluginManifest`, `PluginPermission`, `GamePluginContext` (players, messages, state, cache, pubsub, timer, votes, scores, voice), `GamePlugin`, and `testing/createTestHarness`.
  - `SCOPE.md` (lines 26-28) specifies the required contracts for `bot-sdk`: `BotPermission`, `BotManifest`, `BotLifecycleState`.

## 2. Logic Chain
1. Since `@lobbyforge/config` is intended to standardize TypeScript compilation settings and tools (as observed in `SCOPE.md` and `packages/config/README.md`), it should contain a base tsconfig template (`tsconfig.base.json`) that other workspaces can extend, enforcing ESM and modern strict standards (such as Node 22 NodeNext module resolution).
2. Because different workspaces require different execution environments (e.g. `@lobbyforge/ui` needs a browser-like DOM environment like `jsdom`, whereas SDKs and config utilities run directly in a lightweight node environment), a per-package `vitest.config.ts` allows target-specific optimization. Meanwhile, a global `vitest.workspace.ts` allows unified root-level execution via `pnpm test` as specified by the root `package.json` script configuration.
3. Because plugins render client UI components and communicate via the host platform, `@lobbyforge/plugin-sdk` needs a peer dependency on React (`react`) to type ReactNodes and allow compiler setups (like `"jsx": "react-jsx"`) to compile successfully.
4. Using the `createTestHarness` simulation utility specified in `SCOPE.md`, the host environment and plugin developers can easily test state transitions and event logic without spinning up full services. The recommended harness mock-interfaces fulfill this testing-stub role.
5. All three packages must have a basic unit test file inside `src/__tests__/` to fulfill the test requirement defined in `TEST_INFRA.md` ("All packages must compile and have at least 1 basic test.").

## 3. Caveats
- ESLint configuration files have not been fully drafted because no root eslint rules or plugins are present, but they can easily be added to `@lobbyforge/config` using a similar inheritance model (e.g. extending `@lobbyforge/config/eslint.config.js`).
- External API calls in bots (e.g. Discord, LiveKit servers) are assumed to be handled by wrapper applications (like `apps/desktop` or `plugins/watch-party`), while the `@lobbyforge/bot-sdk` remains a pure, high-level type contract and abstraction.

## 4. Conclusion
We recommend creating:
- A base TypeScript setup in `packages/config/tsconfig.base.json` along with Zod-based application configuration schemas.
- Types, context handlers, and a `createTestHarness` class in `packages/plugin-sdk`.
- Permission lists, manifests, and lifecycle handlers in `packages/bot-sdk`.
- Workspace-level and package-level `tsconfig.json` and `vitest.config.ts` files to structure ESM and testing correctly.

The complete detailed configurations are fully documented in `d:\livekittest\.agents\explorer_m2_2\analysis.md`.

## 5. Verification Method
An implementer can verify the correctness of this design by:
1. Creating the recommended files under `packages/config/`, `packages/plugin-sdk/`, and `packages/bot-sdk/` as detailed in `analysis.md`.
2. Running `pnpm install` at the monorepo root to link workspace dependencies and install external packages (`zod`, `typescript`, `vitest`).
3. Running `pnpm typecheck` from the root directory to ensure no compilation issues exist.
4. Running `pnpm build` to compile the TypeScript files into the `./dist` directory of each package.
5. Running `pnpm test` to run all unit tests (confirming that at least one unit test runs successfully in each package).
