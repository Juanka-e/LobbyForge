# Cross-Platform Notes

Why each design decision in this monorepo is Windows- and Linux-safe, and the specific things future contributors should *not* do.

## TL;DR for contributors

- Use `pnpm -r --if-present <script>` at the root. **Never** `&&`, **never** `export`, **never** `which`/`head`/`tail`/`sed` in `package.json` scripts.
- Use `.js` extensions on every relative ESM import. (The source is `.ts`; NodeNext requires the literal `.js`.)
- Keep `LF` line endings in source. Only `.bat`/`.cmd`/`.ps1` may be `CRLF`.
- No shell snippets — Node + pnpm are the abstraction layer.

---

## Decisions in detail

### 1. Root scripts use `pnpm -r --if-present`

```json
"build": "pnpm -r --if-present build",
"dev":   "pnpm -r --if-present --parallel dev",
"test":  "pnpm -r --if-present test"
```

- `pnpm -r` recurses with **topological order** — dependencies are visited before dependents, so a plugin's `typecheck` never runs before its `node_modules/@lobbyforge/plugin-sdk` is wired.
- `--if-present` means a package without a given script is **silently skipped** instead of erroring. This is essential for the scaffold stage: only some packages have `dev` yet.
- `--parallel` (only on `dev`) runs all dev servers concurrently. pnpm handles the lifecycle; the host shell never sees the parallel `&` or the `start /b` that `bash`/`cmd.exe` would need.

None of these options touch the host shell, so they behave identically on Windows PowerShell, Windows CMD, macOS zsh, and Linux bash.

### 2. `pnpm verify` uses a cross-platform Node.js verification script

```json
"verify": "node scripts/verify.js"
```

Instead of chaining commands with `&&` inside the shell or relying on a shell runner, the verification process runs sequentially via a cross-platform Node.js script (`scripts/verify.js`) using `spawnSync`. This is completely safe across Windows, Linux, and macOS.

If you find yourself wanting to write complex shell sequencing in scripts — stop, and write a cross-platform Node.js script in the `scripts/` directory.

### 3. Per-package `lint` glob is `"eslint \"src/**/*.ts\""`

```json
"lint": "eslint \"src/**/*.ts\""
```

- **Windows PowerShell / CMD:** the glob is passed verbatim to ESLint (PowerShell doesn't do `**` expansion; CMD doesn't do `*` expansion for arguments). ESLint resolves it.
- **Linux bash:** bash does `**` expansion as `*/*` when `globstar` is off (the default). The result is the same file list ESLint would compute. With `globstar` on, `**` matches any depth — also fine.
- ESLint accepts both literal and pre-expanded paths, so either form works.

This is why "no Unix-only shell features" still allows globs in scripts.

### 4. ESM imports use the literal `.js` suffix

```ts
// packages/config/src/__tests__/config.test.ts
import { loadConfig } from '../index.js';
```

- `tsconfig.base.json` has `module: NodeNext` and `moduleResolution: NodeNext`. Under NodeNext, **relative ESM imports must carry the extension** — TypeScript will error otherwise.
- The `.js` is a string literal. The actual filesystem file is `../index.ts` (TS resolves it). The OS never sees a path that needs separator translation.
- This works identically on Windows and Linux. The path string `'../index.js'` is exactly the same bytes in both.

### 5. Two import patterns for cross-package deps

#### Pattern A: dist pointer (existing packages)

```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
}
```

Consumers resolve to `dist/index.js` and `dist/index.d.ts`. Requires `pnpm build` to have run first. This is the standard pattern for libraries that publish to npm.

#### Pattern B: source pointer (M3+ scaffolding)

```json
{
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } }
  }
}
```

Consumers resolve directly to the TypeScript source. Vite (vitest) transforms it at test time; `tsc --noEmit` reads it for typecheck. **No `pnpm build` required.** This is what the M3+ packages use during scaffolding to keep iteration tight.

When a package graduates to a real distribution, switch the `main`/`exports` back to `./dist/...` and document a `prepublish` step that runs `pnpm build`.

Both patterns coexist today and are picked up correctly by `pnpm install` (which symlinks workspace members into `node_modules/@lobbyforge/...`).

### 6. Line endings — LF for source, CRLF for Windows scripts only

`.gitattributes`:

```
* text=auto eol=lf
*.bat text eol=crlf
*.cmd text eol=crlf
*.ps1 text eol=crlf
```

`.editorconfig`:

```ini
[*]
end_of_line = lf
insert_final_newline = true

[*.{bat,cmd,ps1}]
end_of_line = crlf
```

- Every source file is LF on disk. A Windows checkout, a Linux checkout, and a CI checkout all see the same bytes.
- Shell scripts that need CRLF (`.bat`, `.cmd`, `.ps1`) get it because Windows itself refuses to run LF `.bat` files reliably.
- The `text=auto` rule means Git will normalize EOL on commit/checkout so we never accumulate a mix.

### 7. `crypto.randomUUID()` is portable

`crypto.randomUUID()` is available in Node 22+ on every platform. We use it in `db`, `core`, `registry`, and the i18n plugin harness instead of pulling `uuid` as a dep. This keeps the dep tree small and removes a class of "works on my machine" version mismatches.

### 8. `process.env` everywhere — no `export VAR=val`

Configuration is read from `process.env` (or `.env` files once apps add a loader). There is no `export FOO=bar` line anywhere in any script. This means:

- On Windows you set vars with `$env:FOO = "bar"` (PowerShell) or `set FOO=bar` (CMD) before running `pnpm …`. The script doesn't care.
- On Linux you set them with `FOO=bar pnpm …` or `export FOO=bar && pnpm …` in your shell. The script doesn't care.

Either way, by the time pnpm starts the script, `process.env.FOO` is set.

### 9. `vercel-react-best-practices` and similar

Not applied directly to this repo (it's not a Next.js app yet). The `apps/web` placeholder will adopt those conventions when M5 is implemented for real.

---

## Anti-patterns to refuse in code review

- `cd … && …` in a `package.json` script. Use multiple scripts + an aggregator.
- `find . -name "*.ts" -exec …` in a script. Use a proper tool (vitest, tsc, eslint) with its own glob.
- `#!/bin/bash` shebangs in `*.js` / `*.ts` files. Use `tsx` or `node` directly.
- Hardcoded paths like `C:\…` or `/home/…`. Use `path.join`, `path.resolve`, or just relative paths.
- `os.platform()` to fork behavior. If a tool actually behaves differently per OS, prefer a tool that doesn't (e.g. `cross-env` is **not** needed here because we don't `export`).
