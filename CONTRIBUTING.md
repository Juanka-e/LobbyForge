# Contributing

## Prerequisites

- **Node.js** `>= 22.0.0`
- **pnpm** `>= 10.0.0` (install with `corepack enable && corepack prepare pnpm@10.12.1 --activate` or `npm i -g pnpm`)
- A POSIX-y shell is **not** required. The scripts in `package.json` are designed to work in PowerShell and CMD on Windows too.

## First-time setup

```sh
git clone <repo-url>
cd lobbyforge
pnpm install
pnpm verify
```

`pnpm verify` runs `typecheck`, `lint`, and `test` across all 14 workspaces. Expect a few seconds.

## Day-to-day

```sh
# Run tests for a specific workspace
pnpm --filter @lobbyforge/plugin-sdk test

# Typecheck everything
pnpm typecheck

# Watch a single package's tests
pnpm --filter @lobbyforge/hushle exec vitest
```

## Where things live

| I want to… | Look in |
|---|---|
| Add a new SDK type that plugins consume | `packages/plugin-sdk/src/` |
| Add a new shared React component | `packages/ui/src/` |
| Add a new table to the DB schema | `packages/db/src/schema.ts` |
| Add a new language pack | `packages/i18n/locales/<lang>.json` |
| Add a new game plugin | `plugins/<name>/src/` |
| Change a root script | root `package.json` |

## Cross-platform rules of thumb

- **Never** use `&&` in a `package.json` script. Use multiple scripts and a `verify` aggregator, or use pnpm's `--parallel`/`--if-present` flags.
- **Never** use `export FOO=bar` in a script. Use `.env` files (the `dotenv` loader is added per-app) or `process.env` directly.
- **Always** include the file extension on relative ESM imports (`import { x } from './foo.js'`).
- **Always** run `pnpm verify` before pushing.
