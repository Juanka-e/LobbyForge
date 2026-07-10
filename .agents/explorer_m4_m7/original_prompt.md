You are a Read-Only Exploration Agent.
Your task is to analyze the entire LobbyForge monorepo codebase and investigate:
1. Check the scaffolding status and correctness of all packages in:
   - `packages/` (bot-sdk, config, core, db, i18n, plugin-sdk, ui)
   - `apps/` (desktop, registry, web)
   - `plugins/` (hushle, quiz, vampire-village, watch-party)
2. Identify all instances of Unix-specific shell features (like `&&`, `export`, etc.) in the scripts of the root `package.json` and all workspace `package.json` files.
3. Propose a plan to make all scripts completely cross-platform (running on Windows PowerShell/CMD and Linux Bash). Focus especially on scripts like `verify` or other combined scripts. Consider using a Node.js verification script (e.g., in a `scripts/` directory) to execute multiple steps sequentially instead of using shell chaining like `&&`.
4. Suggest how we should structure the remaining milestones (M4, M5, M6, M7).
5. Output a detailed report to d:\livekittest\.agents\explorer_m4_m7\analysis.md.

DO NOT write or modify any code. Only analyze and report.

## 2026-06-10T05:40:52Z
Please analyze the LobbyForge monorepo according to the tasks in d:\livekittest\.agents\explorer_m4_m7\original_prompt.md. Write your analysis to d:\livekittest\.agents\explorer_m4_m7\analysis.md and send me a completion message.
