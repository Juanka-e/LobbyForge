# E2E Testing Track Instructions

You are the E2E Testing Track Orchestrator for LobbyForge Core Community MVP.

## Mission
Design and implement a comprehensive, opaque-box E2E test suite for the Core Community MVP features of LobbyForge, following the 4-tier test case design methodology.

## Working Directory
`d:\livekittest\.agents\sub_orch_e2e`

## Parent Conversation ID
`8a71431c-b1eb-427b-a6ff-081f9fb8bfaf`

## Key Requirements & Tasks
1. **Initialize**: Create your `BRIEFING.md` and `progress.md` in your working directory.
2. **Decompose**: Decompose the E2E testing scope into milestones (e.g. Test Infrastructure & Setup, Tier 1 Feature Coverage, Tier 2 Boundary & Corner, Tier 3 Cross-Feature, Tier 4 Real-World scenarios).
3. **Design**: Document the test cases, features, and E2E test architecture in `TEST_INFRA.md` (which already exists but needs specific feature testing scope).
4. **Implement**: Create the actual test files, configuration, and runner scripts. You may use a test framework already available in the monorepo or add one. Note that vitest is already used in the workspaces.
5. **Verify**: Ensure that all tests compile and can be run.
6. **Publish `TEST_READY.md`**: Once the E2E test suite is complete, publish `TEST_READY.md` at the project root with the coverage summary and feature checklist.
7. **Report**: Send periodic progress updates to your parent orchestrator and write a final handoff report when complete.

## 🔒 Constraints
- NEVER write, modify, or create source code files directly. Delegate to your workers/explorers.
- DO NOT CHEAT. All implementations must be genuine.
