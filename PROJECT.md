# Project: LobbyForge Monorepo Configuration

## Architecture
- LobbyForge is structured as a pnpm monorepo.
- Workspaces:
  - `apps/*`: End-user applications (desktop, registry, web).
  - `packages/*`: Shared internal packages and SDKs (bot-sdk, config, core, db, i18n, plugin-sdk, ui).
  - `plugins/*`: Activity plugins that run inside the voice channels (hushle, quiz, vampire-village, watch-party).
- Dependencies:
  - Plugins depend on `@lobbyforge/plugin-sdk`.
  - Apps depend on packages (`@lobbyforge/config`, `@lobbyforge/core`, `@lobbyforge/db`, `@lobbyforge/i18n`, `@lobbyforge/ui`).
  - Shared packages may depend on `@lobbyforge/config`.

### MVP Architecture Extensions
- **Stateless Session Validation**: Next.js auth utilizes encrypted/signed session cookies (`lf_guest`) to authenticate room requests.
- **WebRTC Voice Stream Topology**: Next.js serves tokens using `jose`. The client connects directly to the LiveKit server with `livekit-client`.
- **Ephemeral Store**: User presence status is stored in Redis under short-lived keys, maintaining a real-time list of who is in what voice channel.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Monorepo Workspace Config | Configure `pnpm-workspace.yaml` and root `package.json` | None | DONE |
| M2 | Config & SDK Scaffolding | Scaffold `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, `@lobbyforge/bot-sdk` | M1 | DONE |
| M3 | Core & Shared Packages Scaffolding | Scaffold `@lobbyforge/core`, `@lobbyforge/db`, `@lobbyforge/i18n`, `@lobbyforge/ui` | M2 | DONE |
| M4 | Plugins Scaffolding | Scaffold `@lobbyforge/hushle`, `@lobbyforge/quiz`, `@lobbyforge/vampire-village`, `@lobbyforge/watch-party` | M2 | DONE |
| M5 | Apps Scaffolding | Scaffold `@lobbyforge/desktop`, `@lobbyforge/registry`, `@lobbyforge/web` | M3, M4 | DONE |
| M6 | Cross-Platform Scripts | Setup platform-independent scripts (`build`, `dev`, `lint`, `typecheck`, `test`) in root `package.json` | M5 | DONE |
| M7 | Documentation & Verification | Create documentation in `docs/` and run verify commands | M6 | DONE |
| M8 | Automated Database Migrations & API Integration (R1) | Configure migrations, boot-time execution, and connect API routes | M7 | PLANNED |
| M9 | Redis Real-time Presence (R4) | Implement user presence tracking and status synchronization using Redis | M8 | PLANNED |
| M10 | LiveKit Audio Streaming (R3) | Implement WebRTC audio streaming, mute controls, and speaker indicators | M8 | PLANNED |
| M11 | Next.js Dashboard UI Layout (R2) | Build dashboard layout with server dock, channel list, and room view | M8 | PLANNED |
| M12 | Integration, Verification & Documentation (R5) | End-to-end testing, validation, and documentation updates under `docs/` | M8, M9, M10, M11 | PLANNED |

## Interface Contracts
### @lobbyforge/plugin-sdk ↔ Plugins
- `packages/plugin-sdk` exports plugin lifecycle definitions and testing utilities.
- Plugins implement the SDK's lifecycle and exports.

### @lobbyforge/db ↔ Apps
- `packages/db` exports database schema and clients.
- Apps import and query database through `@lobbyforge/db`.

## Code Layout
- Root directory: `d:\livekittest`
- Workspace packages:
  - `apps/desktop`
  - `apps/registry`
  - `apps/web`
  - `packages/bot-sdk`
  - `packages/config`
  - `packages/core`
  - `packages/db`
  - `packages/i18n`
  - `packages/plugin-sdk`
  - `packages/ui`
  - `plugins/hushle`
  - `plugins/quiz`
  - `plugins/vampire-village`
  - `plugins/watch-party`
