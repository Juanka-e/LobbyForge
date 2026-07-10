# LobbyForge Monorepo Scaffolding & Cross-Platform Analysis

## Executive Summary
This report analyzes the structural correctness of the 15 workspace modules within the LobbyForge monorepo, identifies shell-specific compatibility issues across the `package.json` configurations, and provides a concrete, platform-agnostic remediation plan. The monorepo layout is highly consistent and clean, but requires glob quoting adjustments and a Node.js verification script to ensure 100% reliable execution across Windows PowerShell/CMD and Linux Bash.

---

## 1. Scaffolding Status & Correctness of Workspaces
All 14 member packages and applications across the three workspace folders (`packages/`, `apps/`, `plugins/`) are correctly scaffolded, compile cleanly, and possess functional unit tests and config inherits. Below is the breakdown of each category:

### A. Packages (`packages/*`)
All packages extend the base compiler configuration `@lobbyforge/config/tsconfig.base.json` and export appropriate entry points:
- **`config`**: Hosts base TypeScript, ESLint, and Vitest configurations. Uses `zod` for configuration schema validation.
- **`plugin-sdk`**: Defines the lifecycle, interfaces, and testing harness for activity plugins. Declares React as a peer dependency.
- **`bot-sdk`**: Provides interfaces for internal/external automated bot integrations.
- **`core`**: Contains domain-level logic and types, including roles, health checks, validation schemas, and the recently added `doctor` module.
- **`db`**: Configures drizzle-orm and postgres clients. Possesses schemas and migration tasks via `drizzle-kit`.
- **`i18n`**: Configures multi-language lookup for `en` and `tr`. Contains a validation script `scripts/check-i18n.ts` that is correctly written in cross-platform Node.js.
- **`ui`**: Standardizes React UI components. Implements components directly in `src/` (e.g., `src/Button.tsx`) and creates re-export wrappers in `src/components/` (e.g., `src/components/Button.tsx` doing `export * from '../Button.js'`). This structure maintains backward compatibility while simplifying package imports.

*Note on Configuration:*
Shared packages resolve via their built distributions (`"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`), meaning `pnpm build` must run before dependents can build or typecheck.

### B. Apps (`apps/*`)
- **`web`**: A Next.js 15.5 App Router structure. Successfully integrates `@lobbyforge/core`, `@lobbyforge/i18n`, and `@lobbyforge/ui`. It correctly overrides the TS compiler options to `moduleResolution: "Bundler"` and `module: "ESNext"` local to the web workspace to resolve Next.js dynamic routing structures. Renders health components under `/admin/health` and JSON endpoints at `/api/health` and `/api/doctor` with API security decorators and rate limiting.
- **`desktop`**: A placeholder electron workspace. Successfully compiles from `src/index.ts` with mock tests.
- **`registry`**: A placeholder service registry. Compiles and tests cleanly.

*Note on Configuration:*
All apps target `"main": "./src/index.ts"` ("source pointer" strategy), resolving directly to TypeScript source files. This bypasses the need for builds during testing and developer iteration.

### C. Plugins (`plugins/*`)
- **`hushle`**, **`quiz`**, **`vampire-village`**, **`watch-party`**: These workspaces contain basic game states and actions that implement `@lobbyforge/plugin-sdk`. They all compile from `src/index.ts` directly, are structured consistently, and have passing smoke tests.

---

## 2. Inventory of Unix-Specific Shell Features
We analyzed the root `package.json` and all 14 workspace `package.json` scripts. The following list cataloging shell compatibility issues was found:

### A. Shell Chaining with `&&`
In the root `package.json`:
```json
"verify": "pnpm typecheck && pnpm lint && pnpm test"
```
- **Issue:** While `&&` is parsed correctly by modern versions of `pnpm` on most platforms, in standard Windows PowerShell (specifically older Windows PowerShell 5.1), `&&` is not natively supported and will fail if executed directly or if the package manager defers execution to the default shell under certain node configurations. It lacks robust cross-platform fallback mechanisms for execution logging and fine-grained error control.

### B. Unquoted Glob Patterns
In the `lint` scripts of all 14 workspaces:
- Packages & Plugins (`bot-sdk`, `config`, `core`, `db`, `i18n`, `plugin-sdk`, `hushle`, `quiz`, `vampire-village`, `watch-party`, `desktop`, `registry`):
  ```json
  "lint": "eslint src/**/*.ts"
  ```
- Package `ui`:
  ```json
  "lint": "eslint src/**/*.{ts,tsx}"
  ```
- App `web`:
  ```json
  "lint": "eslint src/**/*.{ts,tsx} app/**/*.{ts,tsx} lib/**/*.ts"
  ```
- **Issue:** The glob strings are not enclosed in quotes.
  1. On **Unix Bash/Zsh**, the shell will attempt to expand the globs (like `src/**/*.ts` or `src/**/*.{ts,tsx}`) *before* executing the `eslint` binary. If the shell has `globstar` disabled, it expands incorrectly. If there are hundreds of files, it can hit shell argument length limits.
  2. On **Windows PowerShell**, brace expansions like `{ts,tsx}` are treated as script blocks or syntax elements if unquoted, throwing a parser error or failing to expand.
  3. Quoting these globs (e.g., `"eslint \"src/**/*.ts\""` or `"eslint 'src/**/*.ts'"`) is required so that the raw glob string is passed directly to ESLint, allowing ESLint's cross-platform glob engine to handle file lookup.

### C. Escaped Quote Strings in Placeholder scripts
In `apps/desktop/package.json` and `apps/registry/package.json`:
```json
"dev": "echo \"desktop dev: Electron not yet wired in scaffold stage\""
```
- **Issue:** The use of escaped double quotes (`\"`) within the JSON script is a known point of failure when executed inside Windows CMD or PowerShell. Windows CMD retains backslashes or complains about unmatched syntax depending on quoting context.

---

## 3. Cross-Platform Script Remediation Plan
To make all package and root scripts 100% cross-platform, we propose the following changes:

### A. Proposing a Node.js-based Verification Script
Instead of using shell chaining with `&&` in the root `package.json`, we will introduce a Node.js script located at `scripts/verify.js`. This script sequentially executes the validation tasks, handles Windows shell differences automatically, inherits standard output/error formatting, and terminates on the first failure.

#### Proposed File: `scripts/verify.js`
```javascript
import { spawnSync } from 'child_process';
import os from 'os';

// Windows requires { shell: true } to locate and run batch files/cmd links like pnpm.cmd
const isWindows = os.platform() === 'win32';
const spawnOptions = {
  stdio: 'inherit',
  shell: isWindows,
};

const tasks = [
  { name: 'Typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'Lint', cmd: 'pnpm', args: ['lint'] },
  { name: 'Test', cmd: 'pnpm', args: ['test'] }
];

console.log('🚀 Starting LobbyForge Monorepo Verification...');

for (const task of tasks) {
  console.log(`\n========================================`);
  console.log(`🏃 Running Task: ${task.name} (${task.cmd} ${task.args.join(' ')})`);
  console.log(`========================================`);
  
  const result = spawnSync(task.cmd, task.args, spawnOptions);
  
  if (result.error) {
    console.error(`❌ Process Error in ${task.name}:`, result.error.message);
    process.exit(1);
  }
  
  if (result.status !== 0) {
    console.error(`\n❌ Task failed: ${task.name} with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
}

console.log('\n========================================');
console.log('✅ All verification tasks passed successfully!');
console.log('========================================');
process.exit(0);
```

And update the root `package.json` `"verify"` script to:
```json
"verify": "node scripts/verify.js"
```

### B. Standardizing Glob Quoting across Workspaces
All `eslint` glob arguments must be double-quoted. To include double quotes in JSON values, they must be escaped:
- **Root & Workspaces (Standard Packages & Plugins):**
  ```json
  "lint": "eslint \"src/**/*.ts\""
  ```
- **UI Workspace (`packages/ui`):**
  ```json
  "lint": "eslint \"src/**/*.{ts,tsx}\""
  ```
- **Web Workspace (`apps/web`):**
  ```json
  "lint": "eslint \"src/**/*.{ts,tsx}\" \"app/**/*.{ts,tsx}\" \"lib/**/*.ts\""
  ```

### C. Cleaning up Echo Commands in placeholders
Change the dev script echo statements to not use nested escaped quotes:
- **`apps/desktop/package.json`**:
  ```json
  "dev": "echo desktop dev: Electron not yet wired in scaffold stage"
  ```
- **`apps/registry/package.json`**:
  ```json
  "dev": "echo registry dev: not yet wired in scaffold stage"
  ```

---

## 4. Structure for Remaining Milestones (M4 - M7)
The structural skeletons and configurations of packages, apps, and plugins are complete. The remaining milestones should transition from **Scaffolding** to **Wiring and Integration**:

### Milestone M4: Plugins Wiring & Core Integration
- **Goal:** Transform static plugin skeletons into interactive voice channel activities.
- **Deliverables:**
  1. Implement React rendering components within each plugin (`hushle`, `quiz`, `vampire-village`, `watch-party`) in place of current `null` renderers.
  2. Implement full game loop handlers inside plugins' `handleAction` reducers (e.g., timer rules, scoring, voting rounds, media synchronization).
  3. Expand `@lobbyforge/plugin-sdk/testing` tools to provide virtualized lobby testing mocks (simulating multiple voice users in a sandbox environment).

### Milestone M5: Applications Configuration & Interoperability
- **Goal:** Implement core business features and runtime bindings for the three applications.
- **Deliverables:**
  1. **Web App (`apps/web`)**: Implement live voice room connections using LiveKit JS SDK. Build layouts with Tailwind classes referencing `@lobbyforge/ui` styles. Implement user session registration pages.
  2. **Desktop App (`apps/desktop`)**: Initialize Electron, wire main/renderer scripts, connect local microphone/camera permission gates, and configure auto-update.
  3. **Registry App (`apps/registry`)**: Develop self-hosted server ping/directory listing endpoints, enabling lobbies to register themselves globally or locally.

### Milestone M6: Cross-Platform Verification & Continuous Integration
- **Goal:** Restructure scripts to be OS-agnostic and guard against environment regressions.
- **Deliverables:**
  1. Create `scripts/verify.js` at the root and wire it to root `pnpm verify`.
  2. Apply glob quoting rules to all `package.json` lint tasks.
  3. Configure a GitHub Actions workflow (`.github/workflows/ci.yml`) targeting both `ubuntu-latest` and `windows-latest` running `pnpm install`, `pnpm build`, and `pnpm verify` on every push/pull-request.

### Milestone M7: Production Hardening, Distribution & Documentation
- **Goal:** Transition from monorepo development paths to production-grade build assets.
- **Deliverables:**
  1. Transition workspace packages from "source pointer" paths (resolving to `./src/index.ts`) back to compiled "dist pointer" paths (resolving to `./dist/index.js`), adding `prepublishOnly` compilation validations.
  2. Implement actual database connection checks for PostgreSQL and Redis inside the `apps/web/lib/doctor.ts` subsystem, replacing the current mock `true` returns.
  3. Implement network UDP ping checks using a basic STUN resolution package.
  4. Write comprehensive administrator manuals in `docs/` detailing self-hosting configuration, Nginx routing, and environment parameters.
