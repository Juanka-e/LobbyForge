# Scope: Milestone 2 - Config & SDK Scaffolding

## Architecture
Milestone 2 establishes the configuration and SDK foundations of LobbyForge:
1. `@lobbyforge/config`: Standardizes TS and build settings for all packages.
2. `@lobbyforge/plugin-sdk`: Defines type contracts, lifecycle hook definitions, and simulation testing utilities for official and custom activity plugins.
3. `@lobbyforge/bot-sdk`: Defines type contracts, permission lists, and basic structures for internal, plugin, and external bots.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | @lobbyforge/config | Create `packages/config` containing TypeScript, ESLint, or general configuration structures (e.g. `tsconfig.json`, `package.json`, `src/index.ts`, unit test). | None | DONE |
| 2 | @lobbyforge/plugin-sdk | Create `packages/plugin-sdk` containing manifest types, lifecycle types, and testing helper stubs (e.g. `tsconfig.json`, `package.json`, `src/index.ts`, `src/testing.ts`, unit tests). | None | DONE |
| 3 | @lobbyforge/bot-sdk | Create `packages/bot-sdk` containing bot types, permission lists, and lifecycle structures (e.g. `tsconfig.json`, `package.json`, `src/index.ts`, unit test). | None | DONE |
| 4 | Verification | Run build, typecheck, lint, and test globally at the monorepo root to verify that workspace links are correct. | 1, 2, 3 | DONE |

## Interface Contracts
### @lobbyforge/plugin-sdk ↔ Plugins
- `PluginManifest`: Defines metadata, permissions, entry points.
- `PluginPermission`: Enumerates permissions (e.g., `read_room_participants`, `send_room_message`).
- `GamePluginContext`: Context injected by the host (players, messages, state, cache, pubsub, timer, votes, scores, voice).
- `GamePlugin`: The interface plugins must implement (`manifest`, `createInitialState`, `handleAction`, `renderClient`).
- `testing/createTestHarness`: Utility to simulate plugin behavior during tests.

### @lobbyforge/bot-sdk ↔ Bots & Apps
- `BotPermission`: Enumerates bot permissions (e.g. `read_messages`, `send_messages`, `join_voice`).
- `BotManifest`: Meta info about the bot.
- `BotLifecycleState`: States (e.g. `idle`, `connecting`, `active`, `disconnected`).
