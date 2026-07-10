# LobbyForge Monorepo

This document describes the structure, configuration, and cross-platform usage of the LobbyForge monorepo.

## Stack

- **Package manager:** pnpm `10.12.1` (workspace mode)
- **Node.js:** `>=22.0.0`
- **Language:** TypeScript `5.4.x` (strict, ESM, `NodeNext` resolution)
- **Linting:** ESLint `9.x` (flat config) + `typescript-eslint` + `@next/eslint-plugin-next` for `apps/web`
- **Testing:** Vitest `1.6.x`
- **Build:** `tsc` (no bundler at the package level; consumers can use Vite/Turbopack at the app level)

## Layout

```
lobbyforge/
├── apps/
│   ├── web/             # Next.js main app (scaffold stage)
│   ├── desktop/         # Electron wrapper (scaffold stage)
│   └── registry/        # Public server directory (scaffold stage)
├── packages/
│   ├── config/          # Shared tsconfig base, eslint, vitest presets
│   ├── core/            # Domain primitives (roles, errors, health, validation)
│   ├── db/              # Drizzle schema, client, queries
│   ├── i18n/            # Language pack loader + validator
│   ├── plugin-sdk/      # GamePlugin contracts + test harness
│   ├── bot-sdk/         # Bot contracts
│   └── ui/              # React UI primitives
├── plugins/
│   ├── hushle/          # Taboo-style voice game
│   ├── quiz/            # Trivia/quiz
│   ├── vampire-village/ # Social deduction
│   └── watch-party/     # Synchronized media activity
├── docs/
├── projectdetails/      # Living product/architecture specs
├── .agents/             # Local skill packs (not part of the published repo)
└── pnpm-workspace.yaml
```

Each workspace package follows this internal layout:

```
<package>/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts
    └── __tests__/
        └── <name>.test.ts
```

## Workspace Configuration

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'plugins/*'
```

All workspace members are private (`"private": true`) and use `"type": "module"`.

## Cross-Platform Scripts

The root `package.json` exposes these scripts and they run identically on Windows (PowerShell/CMD) and Linux (Bash):

| Script | What it does | OS-agnostic because |
|---|---|---|
| `pnpm build` | `pnpm -r --if-present build` | `pnpm -r` recurses topologically; `--if-present` skips packages without the script |
| `pnpm dev` | `pnpm -r --if-present --parallel dev` | Same; `--parallel` is a pnpm flag, not a shell feature |
| `pnpm typecheck` | `pnpm -r --if-present typecheck` | Same |
| `pnpm lint` | `pnpm -r --if-present lint` | Same |
| `pnpm test` | `pnpm -r --if-present test` | Same |
| `pnpm verify` | typecheck → lint → test | Uses `&&` in the npm script body, which pnpm evaluates cross-platform |

### Why `pnpm -r --if-present …` and not raw shell?

- No `&&` chains, no `export VAR=val`, no `which`, no `head/tail/sed` — works in CMD, PowerShell, and Bash equally.
- `--if-present` means packages that haven't defined a script yet (e.g. apps still in scaffolding) are silently skipped instead of erroring.
- `-r` recurses with topological ordering, so a plugin's typecheck never runs before its dependency `@lobbyforge/plugin-sdk` is at least present in `node_modules`.
- pnpm's lifecycle is OS-aware: on Windows it uses `cmd.exe` (so glob arguments in `scripts` are passed through to Node tooling, not shell-expanded).

### Per-package lint glob

Each package's lint script is:

```json
"lint": "eslint src/**/*.ts"
```

The `**` glob is **not** expanded by `cmd.exe` (Windows shells pass it verbatim) and is **not** shell-expanded by `bash` in a way that breaks the pattern (the standard expansion is `src/*/*.ts` which still matches the right files). ESLint then handles the glob itself. This is why the cross-platform rule "no Unix-only shell features" still allows globs.

### Next.js lint integration

The root `eslint.config.js` is the source of truth for the monorepo. It wires
`typescript-eslint` for every workspace and applies `@next/eslint-plugin-next`
to `apps/web/**/*`, `app/**/*`, and `lib/**/*` with `settings.next.rootDir`
pointing at `apps/web/`.

`apps/web/eslint.config.js` re-exports the root config so running lint from the
web app directory and running lint from the repo root use the same rule set.
The Next plugin packages are pinned to the same major/minor line as the web
app's Next runtime to avoid rule/runtime drift.

## TypeScript Configuration

`packages/config/tsconfig.base.json` is the shared base. Every package extends it:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true
  }
}
```

Per-package `tsconfig.json`:

```jsonc
{
  "extends": "@lobbyforge/config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### ESM + NodeNext + `.js` import suffixes

`module: NodeNext` requires explicit `.js` extensions on relative imports inside source files. Even though we author `.ts`, the resolved path must end in `.js`. Example:

```ts
import { foo } from '../bar.js';   // resolves to ../bar.ts
```

This is a NodeNext requirement, not a stylistic choice, and it works identically on Windows and Linux (the extension is a string literal, never a filesystem path).

## Inter-Package Imports

Two patterns are used:

1. **Dist pointer (existing packages: `config`, `plugin-sdk`, `bot-sdk`):**
   ```json
   {
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
   }
   ```
   Consumers need `dist/` to exist — `pnpm -r build` populates it in topological order.

2. **Source pointer (newer packages in M3+):**
   ```json
   {
     "main": "./src/index.ts",
     "types": "./src/index.ts",
     "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } }
   }
   ```
   This lets Vitest and `tsc --noEmit` resolve directly to the TypeScript source without a prior `pnpm build`. Useful during early scaffolding when iteration speed matters.

   When a package eventually publishes externally, switch the `main`/`exports` back to `./dist/index.js` and `pnpm build` first.

Both patterns coexist in the monorepo today. They work cross-platform because Node, Vite, and TypeScript all treat the path as a string literal — the OS only sees it after resolution.

## Line Endings and `.editorconfig` / `.gitattributes`

We standardize on **LF** for everything except Windows-specific script files:

- `.gitattributes`:
  ```
  * text=auto eol=lf
  *.bat text eol=crlf
  *.cmd text eol=crlf
  *.ps1 text eol=crlf
  ```
- `.editorconfig`:
  ```ini
  [*]
  end_of_line = lf
  insert_final_newline = true

  [*.{bat,cmd,ps1}]
  end_of_line = crlf
  ```

This means:
- A file checked in on Linux stays LF on Windows after a `git checkout` (no spurious diff).
- `.bat`/`.cmd`/`.ps1` keep their required CRLF endings so they actually run on Windows.

## Adding a New Workspace Member

1. Create the directory under `apps/`, `packages/`, or `plugins/`.
2. Add the four files (`package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`).
3. Add at least one `src/__tests__/<name>.test.ts`.
4. Run `pnpm install` from the repo root — pnpm picks up the new member automatically.
5. Verify: `pnpm --filter @lobbyforge/<name> typecheck && pnpm --filter @lobbyforge/<name> test`.

A minimal `package.json` template:

```json
{
  "name": "@lobbyforge/<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint src/**/*.ts"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

## Local Development on Windows (without WSL)

This repo is designed to be runnable directly on Windows. The only requirement is:

- Node.js 22+ on `PATH`
- pnpm 10+ (`corepack enable` is enough)
- No Docker, no WSL, no bash required for the JS/TS toolchain.

Server-side components (PostgreSQL, Redis, LiveKit, Nginx) still need Docker or a Linux host — that's the `infra/` concern, not the monorepo.

## Verified Workspace Commands

```sh
pnpm install           # resolves and links all 15 workspaces
pnpm typecheck         # tsc --noEmit on every workspace
pnpm lint              # eslint on every workspace
pnpm test              # vitest run on every workspace
pnpm build             # tsc emit on every workspace
pnpm verify            # typecheck + lint + test in sequence
```

All of the above have been run cleanly on Windows (PowerShell) for this revision.
