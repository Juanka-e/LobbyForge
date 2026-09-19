# LobbyForge

> Self-hostable, voice-first community platform with a built-in plugin SDK for live activities.

**Status: Closed beta (release candidate).** Core voice/chat/DM/plugin flows
work end-to-end. The 2026-09-19 beta-readiness review
([report](docs/BETA_READINESS_REVIEW.md)) came after 31 earlier audit rounds.
It found and fixed moderation, voice and release-pipeline defects, all
reproduced live first. Full CI/CD covers CodeQL, Trivy, RustSec, dependency
audits, production TLS E2E and a real-UI voice E2E that measures WebRTC audio.
Branch protection and digest-pinned deployment are in place. The remaining
pre-beta items are the VPS drill steps in
[docs/BETA_RELEASE.md](docs/BETA_RELEASE.md). See the
[feature status table](#feature-status) for what is still
alpha/experimental.

LobbyForge is an open-source community platform you run on your own server. It
takes the "server → channel → voice room" structure you know, and lets voice
rooms run live activities — games, quizzes, watch parties — through a typed
plugin SDK.

| | LobbyForge | Discord | TeamSpeak | Revolt |
|---|:-:|:-:|:-:|:-:|
| Voice-first | ✅ | ✅ | ✅ | ❌ |
| Plugin SDK (in-room activities) | ✅ | ❌¹ | ❌ | ❌ |
| Self-hostable | ✅ | ❌ | ✅ | ✅ |
| Guest-friendly (no account needed) | ✅ | ❌ | ❌ | ❌ |

> ¹ Discord has Activities/Embedded App SDK; LobbyForge's in-room plugin
> model is different but the "no plugin SDK" claim you may have read
> elsewhere is not accurate.

## Feature status

Honest assessment of what works today:

| Feature | Status |
|---------|--------|
| Guest access (invite → one-click join) | ✅ Available |
| Voice rooms (LiveKit audio/video/screen share) | ✅ Beta — production TLS E2E plus a real-UI voice E2E in CI (audio flow via WebRTC stats, mute/deafen, moderator server mute, PTT, listen-only fallback); TURN relay with ephemeral credentials |
| Text channels + chat | ✅ Available |
| Direct messages (instance-local) | ✅ Available — block enforcement, reply integrity |
| Multi-server lobby switching | ✅ Available (official instance) |
| Discovery directory | 🟡 Beta — account-bound proof + domain verification + key rotation; real instances needed |
| Hushle (Taboo-style game) | 🟡 Alpha |
| Quiz | 🔬 Experimental |
| Plugin SDK (bundled plugins) | ✅ Available |
| Community plugin marketplace | 🟡 Reviewed-only — artifact hash pinning + fail-closed legacy; runs in isolated child-process container (NOT hostile-code sandbox, see [ADR-001](docs/ARCHITECTURE_DECISIONS.md)) |
| Admin panel (settings, moderation, doctor) | ✅ Available |
| Self-host updates (one-click upgrade) | ✅ Available — signed release manifests pin the immutable GHCR image digest; `lfctl update check/plan/apply` verifies the signature against the committed official public key, auto-creates + strictly verifies a backup, deploys exactly the signed digest, persists deployed-version state and records a rollback pointer (`lfctl update rollback`; app-level — DB migrations are forward-only) |
| Backups (create/restore) | ✅ Available — streaming SHA-256, formatVersion:1 manifest, destructive restore drill in CI |
| Desktop app (Tauri 2) | 🟡 Alpha — builds and runs; global PTT + shortcuts fixed in the beta review (verify on each OS); code signing deferred (see [ADR-005](docs/ARCHITECTURE_DECISIONS.md)) |
| Google OAuth login | ✅ Available (opt-in via env vars) |
| TURN relay | ✅ Available — coturn 4.18.0, ephemeral REST-auth credentials, IPv6 private-range denied |

## Features

- **Voice rooms** powered by [LiveKit](https://livekit.io) — WebRTC SFU, mic/camera/screen-share, speaking indicators, per-user volume.
- **Plugin SDK** — pure reducer pattern (`State → Action → State`), declarative action policies, server-side state projection (anti-cheat), built-in test harness.
- **Bundled games** — Hushle (Taboo-style, alpha) and Quiz (experimental). Vampire Village and Watch Party are planned.
- **Guest access** — invite link → one click into a voice room. No account required.
- **Real-time** — WebSocket gateway + Redis pub/sub for presence, chat, DMs, and activity state.
- **Game integrity** — optimistic concurrency (revision CAS), per-viewer state projection, phase-based action validation.
- **Doctor** — built-in health monitoring + capacity profiling.
- **Privacy-first defaults** — SEO off, invite-only registration, no telemetry, strict security headers (CSP with nonce, HSTS, Fetch-Metadata CSRF).
- **i18n** — English + Turkish; community translations welcome.
- **Native desktop client (optional)** — the web app is fully functional on its own; the [Tauri 2](https://v2.tauri.app) shell is an **opt-in extra** for members who want a native window, tray and global push-to-talk. Nothing to enable server-side — see the [Desktop app (optional)](#desktop-app-optional) section below.

## Tech stack

- **[Next.js 16](https://nextjs.org)** (App Router) + React + TypeScript
- **[LiveKit](https://livekit.io)** for WebRTC voice/video
- **[PostgreSQL](https://www.postgresql.org)** + **[Drizzle ORM](https://orm.drizzle.team)**
- **[Redis](https://redis.io)** for presence, pub/sub, rate limiting, ephemeral state
- **[pnpm](https://pnpm.io)** monorepo workspaces
- A standalone **WebSocket gateway** (`apps/ws-gateway`) for realtime fan-out

## Quick start

### Prerequisites

- **Node.js ≥ 22**
- **pnpm ≥ 10.12.1** (`corepack enable`)
- **Docker** (for the backing services)

### 1. Start the backing services

```sh
cp infra/docker/.env.example .env
docker compose -f infra/docker/docker-compose.dev.yml up -d
```

This brings up PostgreSQL, Redis, and LiveKit with healthchecks. (See
`infra/docker/README.md` for the optional `--profile full` services: Mailpit,
MinIO, Coturn.)

### 2. Install dependencies

```sh
pnpm install
```

### 3. Configure the app

Edit `.env` and set real values for the secrets marked `replace_me`:

```sh
LOBBYFORGE_SESSION_SECRET=<at least 32 chars of random hex>
LOBBYFORGE_SETUP_TOKEN=<at least 32 chars of random hex>
```

Generate them with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Run the app

```sh
pnpm dev        # all workspaces in parallel
# or just the web app:
pnpm --filter @lobbyforge/web dev
```

Open `http://localhost:3000` and walk through the first-run setup wizard.

### Verify everything

```sh
pnpm verify     # typecheck + lint + test across all workspaces
```

## Monorepo layout

```
apps/
  web/          Next.js app — lobby, admin, API routes, realtime
  desktop/      Tauri 2 shell (experimental)
  registry/     Instance registry service
  ws-gateway/   Standalone WebSocket gateway for realtime fan-out
packages/
  core/         Shared helpers (cookies, guest sessions, doctor, update planner)
  db/           Drizzle schema, queries, migrations
  config/       Shared build/runtime config
  i18n/         Platform UI translations (en, tr)
  ui/           Shared UI primitives
  plugin-sdk/   Plugin lifecycle, reducer types, test harness, locale
  bot-sdk/      Bot manifest + client types (runtime planned)
plugins/
  hushle/       Taboo-style voice game (flagship)
  quiz/         Quiz game
  vampire-village/  Werewolf/Mafia-style social deduction
  watch-party/  Synchronized video watching
```

## Desktop app (optional)

The web app is the product — every feature (voice, games, admin, permissions)
works in the browser. The native shell is an **optional client** that members
install individually; **instance owners configure nothing**.

**Who is it for?** Members who want a native window, system tray, and the
global push-to-talk hotkey (Ctrl+Space) while another app has focus.

**How a member sets it up (one-time, ~30 seconds):**

1. Download the installer for your OS from the
   [GitHub releases](https://github.com/Juanka-e/LobbyForge/releases) page.
2. Install and launch it.
3. Enter your community's URL (e.g. `https://my.lobbyforge.dev`) — the same
   address you use in the browser. That's it; the URL is remembered.

One installer works with **any** LobbyForge instance — there is no
per-instance build or server-side switch. Switching communities is just
entering a different URL.

**Status: experimental alpha.** Installers are not code-signed yet, so:
- **Windows:** SmartScreen shows "Windows protected your PC" — *More info → Run anyway*.
- **macOS:** Gatekeeper blocks unsigned apps — right-click → *Open*, or run
  `xattr -cr /Applications/LobbyForge.app` after dragging to Applications.

Details: [docs/DESKTOP.md](docs/DESKTOP.md) ·
[docs/DESKTOP_GAP_ANALYSIS.md](docs/DESKTOP_GAP_ANALYSIS.md)

## Documentation

- **[docs/MONOREPO.md](docs/MONOREPO.md)** — workspace structure and cross-platform usage
- **[docs/WEB_APP.md](docs/WEB_APP.md)** — the Next.js app in detail
- **[docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md)** — how to write a plugin
- **[docs/DOCTOR.md](docs/DOCTOR.md)** — health & capacity monitoring
- **[docs/VOICE_TURN.md](docs/VOICE_TURN.md)** — production voice networking: coturn TURN fallback, firewall ports, NAT test matrix
- **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** — how to contribute
- **[docs/CHANGELOG.md](docs/CHANGELOG.md)** — full change history

## Contributing

See **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**. TL;DR: Node ≥ 22, pnpm ≥
10.12.1, run `pnpm verify` before pushing. No `&&` in scripts (cross-platform),
always include `.js` extensions on relative ESM imports.

## License

[AGPL-3.0-only](LICENSE) — open source. Self-host freely; derivative services
must stay open.
