## 2026-06-10T05:38:13Z
You are worker_m3_verify. Your role is teamwork_preview_worker.
Your working directory is d:\livekittest\.agents\worker_m3_verify.
Your mission is to perform the runtime verification of Milestone 3.

Please perform the following tasks:
1. Initialize your progress.md and BRIEFING.md in your working directory.
2. Run the following verification commands at the monorepo root (d:\livekittest). Set a high timeout or wait for execution to complete so the user has time to approve the command:
   - `pnpm install`
   - `pnpm build`
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - `pnpm --filter @lobbyforge/i18n i18n:check`
3. Document the full console output, success/failure status, and logs of each command in your handoff report.
4. Verify that the output files (e.g. dist directories and files) follow the expected code layout and exist.
5. Create a handoff report at d:\livekittest\.agents\worker_m3_verify\handoff.md.
6. Notify your parent orchestrator (Conversation ID: fb629d0f-f427-4c50-91f6-eed1c03effc7) using send_message.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
