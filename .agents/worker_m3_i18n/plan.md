# Implementation Plan — Scaffold @lobbyforge/i18n

This plan outlines the steps to configure, scaffold, and test the `@lobbyforge/i18n` package in the packages/i18n directory.

## Steps

### Step 1: Update package.json
- Ensure scripts, exports, and dependencies are set correctly.
- Add/update `"i18n:check": "vitest run src/__tests__/validator.test.ts"`.
- Ensure devDependencies include `typescript` and `vitest`.

### Step 2: Configure tsconfig.json and vitest.config.ts
- `tsconfig.json` must inherit from `@lobbyforge/config/tsconfig.base.json`.
- `vitest.config.ts` must configure vitest correctly.

### Step 3: Populate Locale JSON Files
- Verify and finalize `packages/i18n/locales/en.json` containing:
  ```json
  {
    "voice.join": "Join voice",
    "voice.leave": "Leave voice",
    "activity.start": "Start activity",
    "welcome.user": "Welcome, {username}!"
  }
  ```
- Verify and finalize `packages/i18n/locales/tr.json` containing:
  ```json
  {
    "voice.join": "Sese katıl",
    "voice.leave": "Sesten ayrıl",
    "activity.start": "Aktiviteyi başlat",
    "welcome.user": "Hoş geldin, {username}!"
  }
  ```

### Step 4: Create src/locales.ts
- Define and export locales object mapping `en` and `tr` JSON files.
- Export type `TranslationKey` from keys of `en.json`.
- Export type `Locale` and `SUPPORTED_LOCALES`.

### Step 5: Implement src/translator.ts
- Create function `t(key: TranslationKey | string, params?: Record<string, string | number>, userLocale?: string, serverDefaultLocale?: string): string`.
- Implement user locale -> server default -> 'en' fallback logic.
- Implement string interpolation for placeholders like `{username}` using `params`.
- Implement `Translator` class (or helper) if needed by other systems or as part of clean API.

### Step 6: Implement src/validator.ts
- Implement `validateLocale(base: Record<string, string>, target: Record<string, string>): ValidationResult`.
- Ensure it identifies missing keys, extra keys, and placeholder mismatches correctly.

### Step 7: Create src/index.ts
- Export everything from `translator.ts`, `validator.ts`, and `locales.ts`.

### Step 8: Create src/__tests__/translator.test.ts
- Add unit tests verifying fallback logic (user locale -> server default -> 'en' -> key itself).
- Add unit tests verifying parameter interpolation (e.g. `{username}`).

### Step 9: Create src/__tests__/validator.test.ts
- Add unit tests verifying `validateLocale` for valid locales, missing keys, extra keys, and placeholder mismatches.
- Ensure `vitest run src/__tests__/validator.test.ts` can be executed successfully as part of `i18n:check`.

### Step 10: Run Workspace Installation and Verification
- Run `pnpm install` at root.
- Run build/typecheck/test for `@lobbyforge/i18n` package to verify compilation and that all tests pass.
- Run `pnpm --filter @lobbyforge/i18n i18n:check`.
