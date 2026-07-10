# LobbyForge Monorepo Context

## Directory Structure
* **`apps/`**:
  * `desktop` (Electron app wrapper)
  * `registry` (Public directory server)
  * `web` (Next.js Web UI/API)
* **`packages/`**:
  * `bot-sdk` (SDK for building bots)
  * `config` (Shared configurations)
  * `core` (Core business logic/interfaces)
  * `db` (Database access layer/Prisma/drizzle)
  * `i18n` (Internationalization)
  * `plugin-sdk` (Plugin SDK framework)
  * `ui` (Shared UI components)
* **`plugins/`**:
  * `hushle` (Word game plugin)
  * `quiz` (Quiz game plugin)
  * `vampire-village` (Werewolf-like role-playing game plugin)
  * `watch-party` (Watch party synchronization plugin)

## Core Requirements
* Use `pnpm` workspaces.
* All projects must compile, lint, type-check, and test.
* Scripts must be platform-independent (run on Windows and Linux).
* Create a documentation file in `docs/` describing choices.
