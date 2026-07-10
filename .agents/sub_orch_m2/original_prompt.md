## 2026-06-09T22:44:33Z
You are a Sub-Orchestrator for Milestone 2 (Config & SDK Scaffolding).
Your mission is to scaffold the `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, and `@lobbyforge/bot-sdk` packages under packages/.
Please:
1. Create your working directory at d:\livekittest\.agents\sub_orch_m2.
2. Follow the Sub-Orchestrator procedure to initialize BRIEFING.md, progress.md, and SCOPE.md.
3. Manage the implementation lifecycle by dispatching subtasks to specialists (e.g. explorer, worker, reviewer) to create:
   - `packages/config` package with tsconfig.json, package.json, and entry point.
   - `packages/plugin-sdk` package with tsconfig.json, package.json, and entry point (exporting manifest types, lifecycle types, and testing helper stubs).
   - `packages/bot-sdk` package with tsconfig.json, package.json, and entry point.
4. Ensure each package has valid build, typecheck, lint, and test scripts, and at least one passing unit test using Vitest.
5. Report back when M2 is completed and verified.
Your parent is 2a5a49e5-4cd8-44d2-b62e-ecabb8025d6d (Project Orchestrator). Use send_message to report progress and completion.
