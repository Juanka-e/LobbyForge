# Original Prompt for sub_orch_m3_gen2

## 2026-06-10T00:32:00Z

You are a Sub-Orchestrator for Milestone 3 (Core & Shared Packages Scaffolding).
Your mission is to scaffold the `@lobbyforge/core`, `@lobbyforge/db`, `@lobbyforge/i18n`, and `@lobbyforge/ui` packages under packages/.
Please:
1. Create your working directory at d:\livekittest\.agents\sub_orch_m3_gen2.
2. Follow the Sub-Orchestrator procedure to initialize BRIEFING.md, progress.md, and SCOPE.md.
3. Manage the implementation lifecycle by dispatching subtasks to specialists (e.g. explorer, worker, reviewer) to create:
   - `packages/core` package with tsconfig.json, package.json, and index.ts (exporting core types, permissions).
   - `packages/db` package with tsconfig.json, package.json, and index.ts (exporting db helpers).
   - `packages/i18n` package with tsconfig.json, package.json, and index.ts (exporting i18n key resolution helpers).
   - `packages/ui` package with tsconfig.json, package.json, and index.ts (exporting ui component placeholders).
4. Ensure each package has valid build, typecheck, lint, and test scripts (inheriting the TypeScript base configuration from `@lobbyforge/config`), and at least one passing unit test using Vitest.
5. Report back when M3 is completed and verified.
Your parent is 3262fa76-23fd-4cd5-b2a7-c319246f6ca7 (Project Orchestrator). Use send_message to report progress and completion.

## 2026-06-10T00:32:55Z

You are the Sub-Orchestrator for Milestone 3 (Core & Shared Packages Scaffolding).
Your mission is to scaffold the `@lobbyforge/core`, `@lobbyforge/db`, `@lobbyforge/i18n`, and `@lobbyforge/ui` packages under packages/.

Your working directory is d:\livekittest\.agents\sub_orch_m3_gen2.
Please:
1. Read the existing state files in d:\livekittest\.agents\sub_orch_m3_gen2\ (original_prompt.md, BRIEFING.md, progress.md, SCOPE.md).
2. Load the design plans and proposed file contents from the completed explorer reports in:
   - d:\livekittest\.agents\explorer_m3_1\analysis.md
   - d:\livekittest\.agents\explorer_m3_2\analysis.md
   - d:\livekittest\.agents\explorer_m3_3\analysis.md
3. Manage the implementation lifecycle by dispatching subtasks to specialists (e.g. worker, reviewer, challenger, auditor) to scaffold:
   - packages/core
   - packages/db
   - packages/i18n
   - packages/ui
   Ensure all package.json, tsconfig.json, vitest.config.ts, index.ts, source files, and tests are created according to the design.
4. Ensure each package builds, compiles, typechecks, lints, and has at least one passing unit test using Vitest.
5. Once all 4 packages are scaffolded, verify that the root monorepo scripts (build, test, lint, typecheck) work successfully across the monorepo.
6. Run the Forensic Auditor on these packages to ensure integrity and clean reports.
7. Update progress.md frequently.
8. Report back when Milestone 3 is completed and fully verified by sending a message to your parent conversation ID: 3262fa76-23fd-4cd5-b2a7-c319246f6ca7. Use send_message.

MANDATORY INTEGRITY WARNING to forward to all workers:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

