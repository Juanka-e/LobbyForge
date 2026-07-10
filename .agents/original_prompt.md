## 2026-06-09T19:36:15Z

Configure the LobbyForge monorepo skeleton so that all workspace members are correctly linked and can be built, linted, type-checked, and tested seamlessly on both Windows (PowerShell/CMD) and Linux (Bash) environments.

Working directory: d:/livekittest
Integrity mode: development

## Requirements

### R1. Monorepo and Workspace Configuration
Set up the root `pnpm-workspace.yaml` and configure package.json dependencies and settings to support the multi-project workspace.

### R2. Sub-Project Skeleton Setup
Initialize all existing placeholder directories in `apps/`, `packages/`, and `plugins/` with valid, minimal `package.json`, `tsconfig.json`, and entry-point source files (e.g. `index.ts` or `index.js`). Ensure they import/export correctly between packages.

### R3. Cross-Platform Scripts
Implement monorepo-level scripts for `dev`, `build`, `lint`, `typecheck`, and `test` in `package.json` that run natively on Windows (PowerShell/CMD) and Linux (Bash) without relying on Unix-specific shell features (like `export VAR=val` or `&&`).

### R4. Documentation
Document all structural choices, configuration details, and workspace scripts in a new or existing document inside the `docs/` directory.

## Acceptance Criteria

### Execution & Integration
- [ ] Running `pnpm build` at the root successfully compiles all packages and applications.
- [ ] Running `pnpm typecheck` at the root successfully checks TypeScript types across all workspaces.
- [ ] Running `pnpm lint` and `pnpm test` at the root runs successfully on both Windows and Linux without syntax errors.
- [ ] All workspaces (`apps/*`, `packages/*`, `plugins/*`) are correctly recognized by pnpm.
- [ ] Documentation of all configurations and changes is created inside the `docs/` folder.

## 2026-06-10T08:59:27Z

Implement the Core Community MVP features for LobbyForge, enabling a working PostgreSQL database connection with migrations, a rich Next.js dashboard UI layout, live audio streaming using LiveKit, and real-time presence using Redis.

Working directory: d:/livekittest
Integrity mode: development

## Requirements

### R1. Database Integration and Migration Automation
Configure `apps/web` to read environment variables (PostgreSQL URL) and automatically run/apply Drizzle database migrations on boot or via a dedicated build step. Connect mock API routes to the actual database helpers.

### R2. Next.js Dashboard UI Layout
Build the main dashboard frame using `@lobbyforge/ui` components. It must include a left-side server navigation dock, a server channel list sidebar (separating voice and text channels), and a central chat/room section.

### R3. LiveKit Audio Streaming Integration
Hook the client-side voice channel selection to join a real LiveKit session. The UI must support toggling the microphone (mute/unmute), listing voice participants, showing audio activity indicators (who is speaking), and disconnecting.

### R4. Redis Real-time Presence
Implement state tracking using Redis so that user presence (which server/channel they are currently in) is synchronized and updated dynamically.

### R5. Documentation
Document all new API routes, UI components, environment variables, and state flows in the `docs/` directory.

## Acceptance Criteria

### Integration & Execution
- [ ] Running `pnpm verify` (typecheck, lint, and test) succeeds at the root.
- [ ] The Next.js production build (`pnpm build`) succeeds.
- [ ] New unit or integration tests are added to verify database connections and presence logic.
- [ ] Detailed documentation of the implementation is updated under `docs/`.

