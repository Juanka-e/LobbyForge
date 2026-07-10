# BRIEFING — 2026-06-09T22:45:00+03:00

## Mission
Scaffold the @lobbyforge/config, @lobbyforge/plugin-sdk, and @lobbyforge/bot-sdk packages under packages/.

## 🔒 My Identity
- Archetype: teamwork
- Roles: orchestrator, user_liaison, human_reporter, successor
- Working directory: d:\livekittest\.agents\sub_orch_m2
- Original parent: Project Orchestrator
- Original parent conversation ID: 2a5a49e5-4cd8-44d2-b62e-ecabb8025d6d

## 🔒 My Workflow
- **Pattern**: Project / Iteration Loop
- **Scope document**: d:\livekittest\.agents\sub_orch_m2\SCOPE.md
1. **Decompose**: Break down Milestone 2 into subtasks for the three packages: config, plugin-sdk, and bot-sdk.
2. **Dispatch & Execute**:
   - **Direct (iteration loop)**: For each package, spawn Explorer, Worker, Reviewer, and Forensic Auditor to ensure it compiles, passes lint, passes typecheck, and has at least one passing unit test with Vitest.
   - **Delegate (sub-orchestrator)**: None (Milestone 2 is simple enough for direct iteration loop or serial workers).
3. **On failure** (in this order):
   - Retry: nudge stuck agent or re-send task
   - Replace: spawn fresh agent with partial progress
   - Skip: proceed without (only if non-critical)
   - Redistribute: split stuck agent's remaining work
   - Redesign: re-partition decomposition
   - Escalate: report to parent (sub-orchestrators only, last resort)
4. **Succession**: Self-succeed at 16 spawns, write handoff.md, spawn successor.
- **Work items**:
  1. Scaffold `@lobbyforge/config` [done]
  2. Scaffold `@lobbyforge/plugin-sdk` [done]
  3. Scaffold `@lobbyforge/bot-sdk` [done]
  4. Monorepo Verification & Linking [done]
- **Current phase**: 4
- **Current focus**: Verification & Reporting

## 🔒 Key Constraints
- Packages must be placed in packages/
- Each package must contain tsconfig.json, package.json, and entry point files
- Export manifest types, lifecycle types, and testing helper stubs in plugin-sdk
- Valid build, typecheck, lint, and test scripts
- At least one passing unit test using Vitest per package
- Never reuse a subagent after it has delivered its handoff — always spawn fresh

## Current Parent
- Conversation ID: 2a5a49e5-4cd8-44d2-b62e-ecabb8025d6d
- Updated: not yet

## Key Decisions Made
- ESM-only package output using `tsc` to avoid extra bundling dependencies.
- Root-level `vitest.workspace.ts` combined with per-package `vitest.config.ts` configs for testing.

## Team Roster
| Agent | Type | Work Item | Status | Conv ID |
|-------|------|-----------|--------|---------|
| Explorer 1 | teamwork_preview_explorer | Analyze monorepo & package config | completed | 03bf0256-2c16-43d4-b121-896986fdfa42 |
| Explorer 2 | teamwork_preview_explorer | Analyze monorepo & package config | completed | 6ef2a6fc-1af2-4da9-9e4e-665e48aa8f96 |
| Explorer 3 | teamwork_preview_explorer | Analyze monorepo & package config | completed | 51eb5a4e-c370-4bc6-973e-cfcbb53fb740 |
| Worker | teamwork_preview_worker | Implement packages & SDKs | completed | 7b6c2489-b216-426f-a33d-5b1be6b89f83 |
| Reviewer 1 | teamwork_preview_reviewer | Review package scaffolding & tests | completed | 457995ec-308f-4b5a-a11e-ba86990d03a4 |
| Reviewer 2 | teamwork_preview_reviewer | Review package scaffolding & tests | completed | 0f8314cf-8e2c-43be-b98b-9c37f859f2a9 |
| Worker 2 | teamwork_preview_worker | Fix ESLint dependencies and verify | completed | 5d4e9285-2c21-4349-9a16-ead9b917e7c1 |
| Reviewer 3 | teamwork_preview_reviewer | Verify fix and run tests/builds | completed | f619767d-fdee-4fbc-a48e-0108e8c76520 |
| Auditor 1 | teamwork_preview_auditor | Forensic integrity checks | completed | 0fd6f073-0cc7-412d-8060-cc00f08fc4c7 |

## Succession Status
- Succession required: no
- Spawn count: 9 / 16
- Pending subagents: none
- Predecessor: none
- Successor: not yet spawned

## Active Timers
- Heartbeat cron: d70ca23d-c0f2-4dc0-9ff3-0f3f43bd6d0b/task-37
- Safety timer: none
- On succession: kill all timers before spawning successor
- On context truncation: run `manage_task(Action="list")` — re-create if missing

## Artifact Index
- d:\livekittest\.agents\sub_orch_m2\progress.md — Liveness and status heartbeat
- d:\livekittest\.agents\sub_orch_m2\SCOPE.md — Milestone scope and interface contracts
