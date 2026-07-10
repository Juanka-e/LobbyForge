## 2026-06-10T05:45:53Z
You are a Worker Agent.
Your mission is to complete the LobbyForge monorepo configuration by checking all package.json files for correct glob quoting, executing verification commands, fixing any errors, updating PROJECT.md milestone statuses, and ensuring a CLEAN audit status.

Your working directory is: d:\livekittest\.agents\worker_m6_m7_gen2
Please perform the following steps:
1. Load your progress from d:\livekittest\.agents\worker_m6_m7_gen2\progress.md.
2. Check that the lint scripts in all package.json files have their glob arguments wrapped in escaped double-quotes (e.g. \"src/**/*.ts\"). If not, standardise them.
3. Clean up any nested escaped quotes in dev scripts for apps/desktop and apps/registry.
4. Verify the Node.js verification script `scripts/verify.js` exists and is referenced correctly in root package.json.
5. Run the following verification commands:
   - `pnpm install`
   - `pnpm build`
   - `pnpm verify` (which executes typecheck, lint, and test tasks)
6. Fix any typescript type errors, linting issues, or unit test failures that occur.
7. Update PROJECT.md milestones: Set Milestone 6 (Cross-Platform Scripts) and Milestone 7 (Documentation & Verification) status to `DONE` after everything passes successfully.
8. Update docs/CROSS_PLATFORM_NOTES.md to accurately document configuration details and platform script choices.
9. Write your handoff.md report detailing what you did, the commands you ran, and the results.
10. Send a message to your parent conversation ID: 3262fa76-23fd-4cd5-b2a7-c319246f6ca7 when done.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
