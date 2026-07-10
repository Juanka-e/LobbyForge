# LobbyForge Workspace Config Analysis & Recommendations

This report contains recommendations for configuring the root workspace files (`pnpm-workspace.yaml` and `package.json`) for the LobbyForge monorepo.

---

## 1. Recommendations for `pnpm-workspace.yaml`

To define the monorepo workspace boundaries, the following content is recommended for the `pnpm-workspace.yaml` file in the root directory:

```yaml
packages:
  # End-user applications (desktop, registry, web)
  - 'apps/*'
  # Shared internal packages and SDKs (bot-sdk, config, core, db, i18n, plugin-sdk, ui)
  - 'packages/*'
  # Activity plugins that run inside voice channels (hushle, quiz, vampire-village, watch-party)
  - 'plugins/*'
```

### Rationale:
- **Workspace Discovery:** This configuration ensures that `pnpm` automatically discovers and links all current and future sub-projects within `apps/`, `packages/`, and `plugins/`.
- **Topological Resolution:** `pnpm` resolves inter-dependencies (e.g. plugins depending on `@lobbyforge/plugin-sdk`) by linking them locally.

---

## 2. Recommendations for `package.json`

To support cross-platform task orchestration without relying on Unix-specific shell features (such as `&&` or environment variables `export VAR=val`), the root `package.json` should be modified to use `pnpm`'s native recursive workspace capabilities.

### Recommended `package.json` Content:

```json
{
  "name": "lobbyforge",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@10.12.1",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "build": "pnpm -r --if-present build",
    "dev": "pnpm -r --if-present --parallel dev",
    "lint": "pnpm -r --if-present lint",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "test:unit": "pnpm -r --if-present test:unit",
    "test:integration": "pnpm -r --if-present test:integration",
    "test:e2e": "pnpm -r --if-present test:e2e",
    "test:coverage": "pnpm -r --if-present test:coverage"
  }
}
```

### Script-by-Script Breakdown & Cross-Platform Mechanics:

1. **`build` (`pnpm -r --if-present build`)**
   - Runs `build` in all workspace packages.
   - **Topological Sorting:** `pnpm` automatically parses inter-dependency relations (e.g. apps depending on packages) and builds dependencies before consumers.
   - **Graceful Skipping:** The `--if-present` flag prevents crashes on packages without a `build` script.

2. **`dev` (`pnpm -r --if-present --parallel dev`)**
   - Runs development servers concurrently across all workspace packages.
   - **Parallelism:** The `--parallel` flag runs the tasks concurrently and streams output, ignoring topological order (essential for long-running watch/dev tasks that never exit).

3. **`lint` (`pnpm -r --if-present lint`)**
   - Runs the linter on all workspace packages.

4. **`typecheck` (`pnpm -r --if-present typecheck`)**
   - Invokes TypeScript compiler checks across all workspaces.

5. **`test` / `test:*` (`pnpm -r --if-present test:*`)**
   - Targets the different testing suites (unit, integration, e2e, coverage) utilizing Vitest or Playwright at the package level, coordinated from the root workspace level.

---

## 3. Verification Method

To verify the setup, future implementing agents or CI should run the following commands:

1. **Workspace recognition:**
   ```bash
   pnpm m ls
   ```
   *Expected result:* `pnpm` lists all packages in the `apps/`, `packages/`, and `plugins/` folders (once they have their individual `package.json` files scaffolded).

2. **Workspace-wide builds:**
   ```bash
   pnpm build
   ```
   *Expected result:* Runs the `build` script of all workspace packages topologically.

3. **Workspace-wide typechecking, linting, testing:**
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
   *Expected result:* Runs their respective scripts cleanly across the monorepo on both Windows (PowerShell/CMD) and Linux (Bash).
