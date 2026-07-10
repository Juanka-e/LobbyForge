# Scope: Milestone 1 (Monorepo Workspace Config)

## Architecture
- LobbyForge is structured as a pnpm monorepo containing three workspace groups:
  - `apps/*`
  - `packages/*`
  - `plugins/*`

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Create pnpm-workspace.yaml | Configure workspaces array with apps/*, packages/*, plugins/* | None | DONE |
| 2 | Configure root package.json | Ensure root package.json properties are correct, packageManager matches pnpm v10.12.1, and basic settings are configured | None | DONE |
| 3 | Verify with pnpm | Verify workspace recognition using `pnpm m ls` or similar command | M1, M2 | DONE |

## Interface Contracts
- N/A (Root workspace level configurations)
