# Tailwind CSS 4 migration notes

Status: **deferred** (2026-10-10). The web app stays on Tailwind CSS 3.4.19,
and `.github/dependabot.yml` ignores major versions of `tailwindcss` (and of
`tailwind-merge`) until this migration is done. This deferral supersedes
Dependabot PR #75 (3.4.19 → 4.3.3).

These notes are a static assessment. There was no trial upgrade: Tailwind 4
is a new engine, and bumping the package on its own breaks the CSS build,
because the PostCSS plugin moved to a separate package.

## Where Tailwind is used

- **Only `apps/web`.** `tailwind.config.ts` also scans `packages/ui/src`. The
  plugins under `plugins/*` use the `--lf-*` CSS variables, not Tailwind
  classes, so they need no change.
- **One stylesheet:** `app/globals.css`, 438 lines. The one CSS module,
  `hub-tones.module.css`, uses plain CSS with no `@apply` and no `theme()`.
- **Nothing reads the config from JavaScript.** There is no `resolveConfig`,
  and no `theme()` call in CSS.

## What changes

### Config (`apps/web/tailwind.config.ts`, 207 lines)

Tailwind 4 no longer loads a JS config on its own. It can be kept with
`@config`, but it should move into CSS:

- **Colours (60 tokens) become `--color-*` entries in `@theme inline`.**
  For example, `--color-surface: var(--lf-surface, #111722)`.
  - The `themed()` helper goes away. It exists only to build the alpha forms
    (`bg-surface-dim/80`) from the theme variable. Tailwind 4 builds every
    opacity modifier with `color-mix()` from the variable itself.
  - Use `inline`, so each utility keeps reading the `--lf-*` variable where
    it is used, as it does today.
- **Other tokens:**
  - `borderRadius.mockup` becomes `--radius-mockup`;
  - `spacing.*` becomes `--spacing-*`. Check that `max-w-container-max`
    still resolves: Tailwind 4 reads `max-w-*` from `--container-*`;
  - `fontFamily.*` and `fontSize.*` become `--font-*` and `--text-*`. The
    line-height, letter-spacing and weight settings move to
    `--text-*--line-height` and the matching keys;
  - `boxShadow` becomes `--shadow-*`;
  - `backgroundImage` becomes a custom utility, or an arbitrary value;
  - `animation` and `keyframes` become `--animate-*`, with `@keyframes`
    inside `@theme`.
  - `borderRadius` `DEFAULT`, `lg`, `xl` and `full` repeat the Tailwind 3
    defaults and can be dropped.
- **`darkMode: 'class'`** becomes
  `@custom-variant dark (&:where(.dark, .dark *));`. The root layout always
  sets `class="dark"`. `dark:` is used 39 times in 9 files.
- **`content`** becomes `@source` lines. Automatic detection only scans
  `apps/web`, so `packages/ui/src` needs `@source "../../packages/ui/src"`.
  To mirror today's globs, use `@import "tailwindcss" source(none)` with
  explicit `@source` entries. That also keeps `e2e/` and the generated
  developer docs out of the scan.

### PostCSS (`apps/web/postcss.config.mjs`)

- Replace `tailwindcss: {}` and `autoprefixer: {}` with
  `'@tailwindcss/postcss': {}`. Tailwind 4 adds vendor prefixes itself.
- In devDependencies, move `tailwindcss` to 4.x, add `@tailwindcss/postcss`,
  and drop `autoprefixer`.
- The root `postcss` override (8.5.23) still applies.

### `globals.css`

- Replace the three `@tailwind` lines with `@import "tailwindcss";`, then add
  `@theme inline`, `@custom-variant` and `@source`.
- **`@apply`:** used once, in `.auth-input` (6 call sites). It works
  unchanged under `@layer components`. Move it to `@utility auth-input` only
  if it needs variants.
- **Theme blocks:** the `:root`, `.lf-theme-dim` and `.lf-theme-light`
  variable blocks stay as they are. `@layer base` and `@layer components`
  become native cascade layers, in the same order as today.
- **Unlayered rules** (`.safe-area-page`, `.material-symbols-outlined`, the
  reduced-motion block) now outrank every utility. They already won by
  source order, so nothing should change, but check it visually.

### Plugin packages

- **`@tailwindcss/forms` 0.5.11** accepts Tailwind 4 as a peer. Load it with
  `@plugin "@tailwindcss/forms";`.
- **`@tailwindcss/container-queries`** is built into Tailwind 4, and the app
  has no `@container` classes. Delete it.

### Utility renames and changed defaults

Counted over `apps/web/{app,components,src,lib}` and `packages/ui/src`, test
files excluded. The renames are mechanical, and `npx @tailwindcss/upgrade`
does them.

| Change | Occurrences | Files |
| --- | ---: | ---: |
| `rounded` → `rounded-sm`, `rounded-sm` → `rounded-xs` (incl. sides) | 91 + 19 | 33 + 16 |
| `outline-none` → `outline-hidden` | 69 | 42 |
| `flex-shrink-*` / `flex-grow-*` → `shrink-*` / `grow-*` | 47 | 25 |
| `shadow-sm` → `shadow-xs` | 12 | 12 |
| `blur` / `backdrop-blur(-sm)` scale shift | 9 | 7 |
| **Renames, total** | **247** | **95** |
| `space-x-*` / `space-y-*`: the selector moves the margin to the other side | 112 | 42 |
| bare `border` with no border colour in the same string (gray-200 → `currentColor`) | 16 | 12 |
| `ring-1` … `ring-8` (the default ring colour becomes `currentColor`) | 46 | — |
| hover-reveal (`group-hover:opacity-100` and similar): `hover` now applies only on devices that can hover | 12 | 7 |

Two Preflight changes need little or no work:

- Buttons default to `cursor: default`, but `globals.css` already sets
  `cursor: pointer`.
- The new default placeholder colour (the text colour at 50%) loses to
  `@tailwindcss/forms`, which styles text inputs' placeholders itself, and to
  the 8 `placeholder-*` classes.

### tailwind-merge 3

- tailwind-merge 3 supports only Tailwind 4. It is ignored in
  `dependabot.yml` for the same reason as Tailwind itself, and both move in
  one PR.
- `cn()` (`packages/ui/src/utils.ts`) has 12 callers.
- **A latent bug, on 2.x today:** tailwind-merge's default config does not
  know the custom font sizes (`text-label-sm`, `text-body-md`, ...). It
  treats them as text colours, so `cn('text-label-sm text-text-primary')`
  returns only `text-text-primary` (checked on 2.6.1).
  - No current `cn()` call mixes the two.
  - In the migration, configure `cn()` with `extendTailwindMerge` and the
    theme's font-size names.

### Browser floor

- **What Tailwind 4 needs:** Safari 16.4, Chrome 111 and Firefox 128
  (`@property`, `color-mix()`, cascade layers).
- **What we need today:** every themed alpha colour already uses
  `color-mix()`, so the CSS already needs Chrome 111, Safari 16.2 and
  Firefox 113. The real raise is Safari 16.2 → 16.4 and Firefox 113 → 128.
- **Desktop webviews:**
  - WebView2 on Windows is evergreen;
  - WKWebView on macOS follows the installed Safari, and
    `minimumSystemVersion` is 10.15, which already falls below today's floor;
  - on Linux, WebKitGTK must be at a Safari 16.4 level.
  - Raise the documented minimums with the migration.

## Effort

About **1.5–2 days**, most of it review and visual checks:

1. **Half a day:** run `npx @tailwindcss/upgrade` on a branch, write
   `@theme inline` by hand from the token list above, and move PostCSS and
   the plugins.
2. **2–3 hours:** review the renamed classes, then the changed defaults:
   bare borders, `ring-*` colours, `space-*` layouts, and the hover-reveal
   controls on touch.
3. **1 hour:** tailwind-merge 3 and a `cn()` check.
4. **About a day:** visual QA in the dark, dim and light themes, on desktop
   and phone widths, and the Playwright suite, to confirm the web
   production build and the desktop shell render the same.

Delete both Dependabot ignore rules (`tailwindcss` and `tailwind-merge`) in
that PR.
