## 2026-06-10T00:39:33Z
You are a teamwork_preview_worker. Please scaffold `@lobbyforge/i18n` in packages/i18n.
First, make sure the directory packages/i18n exists.
Then, create the following files under packages/i18n/ matching the specification in the exploration report:
1. `package.json`
2. `tsconfig.json` (inherits from `@lobbyforge/config/tsconfig.base.json`)
3. `vitest.config.ts`
4. `locales/en.json` (English translation keys)
5. `locales/tr.json` (Turkish translation keys)
6. `src/locales.ts` (locale mapping and TranslationKey types)
7. `src/translator.ts` (helper function t() with fallback logic: user locale -> server default -> 'en', and parameter interpolation)
8. `src/validator.ts` (validateLocale function matching keys and placeholders)
9. `src/index.ts`
10. `src/__tests__/translator.test.ts`
11. `src/__tests__/validator.test.ts`

Make sure the files inherit from @lobbyforge/config/tsconfig.base.json.
Include valid i18n check script "i18n:check" running "vitest run src/__tests__/validator.test.ts" in package.json.
After implementing, run "pnpm install" from the root directory to link the workspace, and run build/typecheck/test for the package to verify it builds and passes tests successfully.
Do not write or use any dummy or facade implementations.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your working directory is d:\livekittest\.agents\worker_m3_i18n. Save your handoff to d:\livekittest\.agents\worker_m3_i18n\handoff.md. Report back when complete.
