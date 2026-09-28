# Working on LobbyForge with an agent team

LobbyForge ships a small team of Claude Code subagents in `.claude/agents/`.
Each one knows one part of the codebase; this page is the ground rules they
all share. It is written for people too — it is the shortest accurate map of
how the repo is put together.

| Agent | Use it for |
|---|---|
| `lf-plugin-engineer` | A game or activity plugin: reducer, hidden-state projection, panel UI, locales, tests |
| `lf-frontend-engineer` | Pages and components in `apps/web`: hub, lobby, settings, admin |
| `lf-bot-engineer` | Bots: tokens, permissions, the Bot API, built-in bots, `@lobbyforge/bot-sdk` |
| `lf-e2e-tester` | Running the Docker stack and Playwright specs end to end |
| `lf-translator` | Catalogue work: new strings, a new language, terminology |
| `lf-reviewer` | A read-only review of a change against the rules below |

Ask for one by name ("use lf-plugin-engineer to …"), or let Claude pick from
the descriptions. Several can run at once when their files do not overlap —
see [Parallel work](#parallel-work).

## Repo map

```
apps/web            Next.js 16 app (App Router, React 19) — every page and API route
apps/ws-gateway     realtime gateway (activity + chat bus)
apps/plugin-worker  sandbox that runs marketplace plugin reducers
apps/registry       the official directory / registry service
apps/desktop        Tauri 2 desktop shell
packages/core       shared logic used by web AND gateway (e.g. activity projection)
packages/db         Drizzle schema, queries, SQL migrations (packages/db/drizzle)
packages/plugin-sdk plugin contract, locale registry, message format, UI kit (/ui)
packages/bot-sdk    bot contract and locale helpers
plugins/*           official plugins: hushle, quiz, poll, dice-bot, vampire-village, watch-party
scripts/i18n.mjs    translation tooling (see docs/TRANSLATING.md)
projectdetails/     product specs (Turkish) — the source of truth for features
docs/               how things work today
```

## Commands (run from the repo root unless noted)

```sh
pnpm --filter <pkg> test          # vitest for one package, e.g. @lobbyforge/hushle
pnpm --filter <pkg> typecheck
pnpm --filter <pkg> lint
pnpm --filter <pkg> build         # plugins and SDKs build to dist/
cd apps/web && npx tsc --noEmit -p tsconfig.json
cd apps/web && npx vitest run <path>
node scripts/i18n.mjs status      # catalogue health — must say "No problems"
pnpm -r --if-present test         # everything (slow)
```

Windows + Git Bash is the main dev box: use `/d/livekittest` paths in bash,
and `MSYS_NO_PATHCONV=1` before `docker run -w /app/...`.

## Rules every change follows

**User-facing text is never hardcoded.** App strings live in
`apps/web/messages/<code>/<area>.json` and are read with `useT()` (client) or
`await getTranslator()` (server). Plugin strings live in
`plugins/<id>/locales/<code>.json` and are read with the SDK's `tFor`.
English and Turkish are both marked complete, so every new key needs both.
Counts use plurals (`{count, plural, one {# player} other {# players}}`), never
two keys picked with `count === 1`. A link or element inside a sentence uses
`rich()` from `apps/web/lib/i18n/rich.tsx`. Turkish terms:
`apps/web/messages/tr/GLOSSARY.md`. Full guide: `docs/TRANSLATING.md`.

**Themes are variables.** The app has dark, dim and light themes. App code
uses the themed Tailwind tokens (`bg-surface`, `text-text-primary`, …).
Plugins sit outside Tailwind's content globs: they use the UI kit
(`@lobbyforge/plugin-sdk/ui`) or inline `var(--lf-…, #fallback)` — never
hardcoded dark colours. Check light and dark when you touch UI.

**Hidden information is projected on the server.** A plugin's full state
(Hushle's deck, Vampire Village's roles, Quiz answers) never reaches a
client unfiltered: `packages/core/src/activity-projection.ts`
(`projectActivityState`) redacts it per viewer, for the web app and the
gateway alike. A new secret field needs a projection rule AND a test that a
wrong viewer cannot see it.

**Plugins validate their own input.** The host only checks `{ type }`.
Implement `validateAction`, keep reducers pure and defensive, and give every
action an `actionPolicies` entry (`host` / `player` / `member`, with
`actorFields` for fields that must equal the caller).

**Accessibility.** Real buttons and labels, `aria-label` on icon-only
controls, visible focus, text contrast 4.5:1, colour never the only cue.

**Tests.** New behaviour ships with tests next to the existing ones:
reducers and projections in the plugin's `src/__tests__`, API routes in
`apps/web/app/api/**/__tests__` (mock `@lobbyforge/db`, `@/lib/db` and
`@/lib/security-headers`; real signed cookies via `buildGuestSessionCookie`),
components under `app/**/__tests__` with `// @vitest-environment happy-dom`
and `<I18nProvider {...providerPropsFor('en')}>`.

**Database.** Schema in `packages/db/src/schema.ts`; migrations are
hand-reviewed SQL in `packages/db/drizzle/NNNN_name.sql` plus
`drizzle/meta/_journal.json`. Only one agent adds migrations at a time.

**Git.** Agents never commit, push or open PRs — the lead does, with the
maintainer's identity and no AI attribution lines.

## Parallel work

Several agents can share one working tree when each owns distinct files.
The lead gives every agent a written list of files it owns. Beyond that:

- Shared files (`apps/web/lib/plugin-registry.ts`, the projection module,
  `middleware.ts`, `package.json`s) take small, local edits only — never a
  rewrite — and each edit is listed in the agent's report.
- Nobody runs `pnpm install`, rebuilds Docker images or restarts
  containers except the agent the lead named for it; the lead adds
  dependencies up front.
- A type error in a file you do not own is someone else's work in
  progress: mention it, do not fix it.

## Local stacks

| Stack | Web | Notes |
|---|---|---|
| dev (`lobbyforge-dev`) | http://localhost:19520 | self-host mode |
| official hub (manual) | http://localhost:19530 | same image, `LOBBYFORGE_DEPLOYMENT_MODE=official` |
| e2e (`lobbyforge-e2e`) | http://localhost:19620 | used by Playwright |

The web image is rebuilt with
`docker compose -p lobbyforge-dev -f infra/docker/docker-compose.dev.yml build migrate`
(the `migrate` service owns the image) and restarted with
`… up -d --force-recreate web`. Repeated test logins hit the rate limiter:
clear `*rate-limit*` keys in Redis.

## Report format

Every agent ends with: files changed (and which shared files), what was
verified and how (exact commands and results), what was left out and why,
and anything the next person must know.
