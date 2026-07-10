## 2026-06-10T00:33:40Z
You are a worker agent. Your working directory is d:\livekittest\.agents\worker_m3_1.
Your task is to scaffold the four shared packages under packages/ in the monorepo:
1. `@lobbyforge/core`
2. `@lobbyforge/db`
3. `@lobbyforge/i18n`
4. `@lobbyforge/ui`

Please load and follow the design specifications and proposed file contents from the three completed explorer reports:
- d:\livekittest\.agents\explorer_m3_1\analysis.md
- d:\livekittest\.agents\explorer_m3_2\analysis.md
- d:\livekittest\.agents\explorer_m3_3\analysis.md

Ensure you create or update the following for each package:
- package.json
- tsconfig.json (extending the base configuration from @lobbyforge/config)
- vitest.config.ts
- index.ts
- source files (e.g., types, permissions, validation/zod schemas for core; schemas and connection client for db; locales JSON, translator, validator, check script for i18n; React components Button, Modal, Card, Tooltip, Avatar, Spinner for ui)
- at least one passing unit test using Vitest.

Verification requirements:
1. Run pnpm install from the monorepo root to link the workspaces.
2. Verify that each package compiles, builds, typechecks, lints, and passes its unit tests.
3. Verify that the root monorepo scripts (build, test, lint, typecheck) work successfully across the monorepo.
4. Document the commands you ran and their output in your handoff report at d:\livekittest\.agents\worker_m3_1\handoff.md.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
