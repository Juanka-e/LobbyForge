# Monorepo Workspace Configuration Recommendation

## 1. Executive Summary
This report analyzes the LobbyForge workspace root directory and presents the exact recommended configuration for the `pnpm-workspace.yaml` and updates to the root `package.json`. These configurations will correctly link all sub-projects (apps, packages, and plugins) and establish cross-platform script delegation using standard `pnpm` workspaces without relying on Unix-specific shell utilities or commands.

---

## 2. Recommended Configuration Files

### 2.1. `pnpm-workspace.yaml` (Root)
Create a new file at `d:\livekittest\pnpm-workspace.yaml` with the following content:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'plugins/*'
```

#### Rationale:
- **Comprehensive Workspace Inclusion**: Matches the target directory structure (`apps/*`, `packages/*`, and `plugins/*`) as defined in `PROJECT.md` and `03_TECH_STACK_DECISIONS.md`.
- **Targeted Package Mapping**: Includes all subdirectories containing Node.js/TypeScript packages (e.g., `apps/desktop`, `packages/core`, `plugins/hushle`).
- **Clean Separation**: Excludes non-Node folders (such as `infra/` or `docs/`) that contain configuration files, Dockerfiles, or scripts not managed by the npm package system.

---

### 2.2. `package.json` (Root)
Update the root `package.json` file at `d:\livekittest\package.json` to configure the necessary workspace-wide scripts and metadata:

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
    "dev": "pnpm -r --if-present dev",
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

#### Rationale for Scripts & Options:
- **`pnpm -r --if-present`**: This command instructs `pnpm` to execute the target script recursively across all workspaces that actually define it.
- **Cross-Platform Compatibility (R3)**: 
  - Standardizing on `pnpm -r` completely avoids shell chaining operators (like `&&` or `;`), which behave differently on Windows (PowerShell/CMD) and Linux (Bash/Zsh).
  - It also avoids setting inline environment variables (which would require Unix-specific syntax or `cross-env`).
- **Resilience**: The `--if-present` flag prevents builds or checks from failing if a specific workspace member does not implement that specific script (e.g., a simple shared package like `@lobbyforge/i18n` might not need a complex `build` script or a `test:integration` script).
- **Test Command Integration**: Maps directly to the test lifecycle outlined in `25_TESTING_STRATEGY.md` (`pnpm test`, `test:unit`, `test:integration`, `test:e2e`, and `test:coverage`), supporting standard and testcontainer/Docker environments seamlessly.

---

## 3. Design Decisions & Guidelines

### 3.1. Dependency Placement Policy
- **Root DevDependencies**: Keep root dependencies empty or minimal. Any toolings should be installed directly within sub-projects (or shared dev config packages like `@lobbyforge/config`) to maintain module isolation and version consistency.
- **Shared Configs**: If developers need common TypeScript, linting, or formatting configurations, these configurations should be housed in `packages/config` and referenced inside other workspaces using `workspace:*` protocols.

### 3.2. Cross-Platform Scripting Rules
1. **Never use inline environment variables** (e.g. `NODE_ENV=production pnpm build`) in the root `package.json` scripts. If environment variables are required, load them via `dotenv` in JavaScript/TypeScript, configure them in `compose` files, or define them directly in the CI environment (e.g. GitHub Actions).
2. **Never chain multiple shell steps with `&&`**. Instead, write a simple script file (e.g., a Node.js script run via `node scripts/do-something.js`) if multi-step actions are required at the root level.
