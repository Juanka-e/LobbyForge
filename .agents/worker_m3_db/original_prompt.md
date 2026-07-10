## 2026-06-10T00:35:49Z
You are a teamwork_preview_worker. Please scaffold `@lobbyforge/db` in packages/db.
First, make sure the directory packages/db exists.
Then, create the following files under packages/db/ matching the specification in the exploration report:
1. `package.json`
2. `tsconfig.json` (inherits from `@lobbyforge/config/tsconfig.base.json`)
3. `vitest.config.ts`
4. `src/schema.ts` (maps the 21 tables in the database schema)
5. `src/client.ts` (helper to create database client)
6. `src/index.ts`
7. `src/__tests__/db.test.ts`

Make sure the files inherit from @lobbyforge/config/tsconfig.base.json.
Include drizzle-orm, postgres, and drizzle-kit in dependencies/devDependencies as specified in the synthesis/exploration plan.
After implementing, run "pnpm install" from the root directory to link the workspace, and run build/typecheck/test for the package to verify it builds and passes tests successfully.
Do not write or use any dummy or facade implementations.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your working directory is d:\livekittest\.agents\worker_m3_db. Save your handoff to d:\livekittest\.agents\worker_m3_db\handoff.md. Report back when complete.
