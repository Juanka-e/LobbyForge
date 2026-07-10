## 2026-06-10T05:33:52Z
You are reviewer_m3_3. Your role is teamwork_preview_reviewer.
Your working directory is d:\livekittest\.agents\reviewer_m3_3.
Your mission is to perform Unified Verification on the `@lobbyforge/core`, `@lobbyforge/db`, `@lobbyforge/i18n`, and `@lobbyforge/ui` packages.

Please perform the following tasks:
1. Initialize your progress.md and BRIEFING.md in your working directory.
2. Run the following commands in the monorepo root (d:\livekittest):
   - `pnpm install`
   - `pnpm build`
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - `pnpm --filter @lobbyforge/i18n i18n:check`
3. Verify that the build, test, lint, typecheck, and check-i18n scripts pass successfully.
4. If there are any command failures or errors, analyze them and document them.
5. Create a handoff report at d:\livekittest\.agents\reviewer_m3_3\handoff.md. Include the command outputs, status of tests, and a summary of your findings.
6. Notify your parent orchestrator (Conversation ID: fb629d0f-f427-4c50-91f6-eed1c03effc7) using send_message.
