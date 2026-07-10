# LobbyForge Monorepo Workspace Configuration Analysis

## Workspace Overview
LobbyForge is a pnpm monorepo structure. Based on physical directory checks and configuration requirements, the structure maps to:
- **Applications (`apps/*`)**:
  - `apps/desktop`
  - `apps/registry`
  - `apps/web`
- **Shared Packages & SDKs (`packages/*`)**:
  - `packages/bot-sdk`
  - `packages/config`
  - `packages/core`
  - `packages/db`
  - `packages/i18n`
  - `packages/plugin-sdk`
  - `packages/ui`
- **Voice Channel Plugins (`plugins/*`)**:
  - `plugins/hushle`
  - `plugins/quiz`
  - `plugins/vampire-village`
  - `plugins/watch-party`

---

## Recommended `pnpm-workspace.yaml`

Create a new file `pnpm-workspace.yaml` in the repository root (`d:\livekittest\pnpm-workspace.yaml`) with the following contents. This defines the workspace directories so that pnpm correctly detects and links all applications, shared packages, and plugins.

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'plugins/*'
```

---

## Recommended `package.json`

Modify the root `package.json` (`d:\livekittest\package.json`) to implement monorepo-level recursive scripts. These scripts use pnpm's recursive engine (`pnpm -r` / `pnpm --recursive`) which natively executes target scripts in topological order, resolving internal dependencies first.

This satisfies the cross-platform requirement R3 because it relies entirely on the cross-platform pnpm CLI without resorting to Unix-specific shell features (such as `&&` or `export`).

### Full Recommended `package.json`

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
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  }
}
```

---

## Verification of Requirements

1. **R1: Monorepo and Workspace Configuration**
   - The proposed `pnpm-workspace.yaml` specifies all three package roots (`apps/*`, `packages/*`, `plugins/*`).
   - The root `package.json` configures the standard monorepo structure.

2. **R3: Cross-Platform Scripts**
   - Commands like `pnpm -r build`, `pnpm -r lint`, `pnpm -r typecheck`, and `pnpm -r test` delegate task runner execution directly to the individual packages' scripts.
   - For `dev`, `pnpm -r --parallel dev` runs all workspace dev servers concurrently, which is standard for local development.
   - No platform-specific shell operations (such as `&&` or `export`) are present, ensuring native execution in Windows PowerShell/CMD and Linux/macOS Bash/Zsh.
