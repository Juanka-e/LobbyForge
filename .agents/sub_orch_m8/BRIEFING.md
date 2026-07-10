# BRIEFING — 2026-06-10T12:13:57+03:00

## Mission
Configure @lobbyforge/db and apps/web to establish a working PostgreSQL database connection, automatically generate and run migrations on application boot, and connect existing API routes to actual database queries.

## 🔒 My Identity
- Archetype: teamwork_preview_sub_orch
- Roles: orchestrator, user_liaison, human_reporter, successor
- Working directory: d:\livekittest\.agents\sub_orch_m8
- Original parent: main agent
- Original parent conversation ID: 8a71431c-b1eb-427b-a6ff-081f9fb8bfaf

## 🔒 My Workflow
- **Pattern**: Project
- **Scope document**: d:\livekittest\.agents\sub_orch_m8\SCOPE.md
1. **Decompose**: Decomposed into 3 sub-milestones (Drizzle config + migrations generation, boot-time migration runner, API integration & testing).
2. **Dispatch & Execute**:
   - **Direct (iteration loop)**: Explorer → Worker → Reviewer → gate
   - **Delegate (sub-orchestrator)**: When an item is too large, spawn a sub-orchestrator for it.
3. **On failure** (in this order):
   - Retry: nudge stuck agent or re-send task
   - Replace: spawn fresh agent with partial progress
   - Skip: proceed without (only if non-critical)
   - Redistribute: split stuck agent's remaining work
   - Redesign: re-partition decomposition
   - Escalate: report to parent (sub-orchestrators only, last resort)
4. **Succession**: self-succeed at 16 spawns, write handoff.md, spawn successor.
- **Work items**:
  1. Sub-milestone 1: Migrations Config & Generation [pending]
  2. Sub-milestone 2: Programmatic Migration Runner [pending]
  3. Sub-milestone 3: API Integration & Testing [pending]
- **Current phase**: 1
- **Current focus**: Sub-milestone 1: Migrations Config & Generation

## 🔒 Key Constraints
- NEVER write, modify, or create source code files directly. Delegate to your workers/explorers.
- DO NOT CHEAT. All implementations must be genuine.
- Never reuse a subagent after it has delivered its handoff — always spawn fresh

## Current Parent
- Conversation ID: 8a71431c-b1eb-427b-a6ff-081f9fb8bfaf
- Updated: not yet

## Key Decisions Made
- Decomposed Milestone 8 into 3 sequential sub-milestones to manage risk and verify step-by-step.

## Team Roster
| Agent | Type | Work Item | Status | Conv ID |
|-------|------|-----------|--------|---------|
| explorer_1 | teamwork_preview_explorer | DB Exploration 1 | completed | 6499af09-895e-4f22-8d84-b6883aea3329 |
| explorer_2 | teamwork_preview_explorer | DB Exploration 2 | completed | 9eddd6bc-a3d7-42d2-93e1-74e95b1e50c1 |
| explorer_3 | teamwork_preview_explorer | DB Exploration 3 | failed | 566b14e4-5f79-4a37-a83d-bcd9c0cc6ca5 |

## Succession Status
- Succession required: no
- Spawn count: 3 / 16
- Pending subagents: none
- Predecessor: none
- Successor: not yet spawned

## Active Timers
- Heartbeat cron: task-15
- Safety timer: task-69
- On succession: kill all timers before spawning successor
- On context truncation: run `manage_task(Action="list")` — re-create if missing

## Artifact Index
- d:\livekittest\.agents\sub_orch_m8\instructions.md — Milestone instructions
- d:\livekittest\.agents\sub_orch_m8\progress.md — Heartbeat progress
- d:\livekittest\.agents\sub_orch_m8\SCOPE.md — Sub-milestone decomposition
