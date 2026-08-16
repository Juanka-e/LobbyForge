# LobbyForge

> Self-hostable, voice-first community platform with a built-in plugin SDK for live activities.

**Status: Experimental alpha.** Core voice/chat/DM flows work end-to-end;
some features are incomplete or disabled by default. See the
[feature status table](#feature-status) below before deploying.

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
| Voice rooms (LiveKit audio/video/screen share) | 🟡 Alpha — real-network validation in progress |
| Text channels + chat | ✅ Available |
| Direct messages (instance-local) | ✅ Available |
| Multi-server lobby switching | ✅ Available (official instance) |
| Discovery directory | 🟡 Alpha — registration/review flow works, needs real instances |
| Hushle (Taboo-style game) | 🟡 Alpha — viewer state projection + classic Taboo roles work; action idempotency is PARTIAL (10-min duplicate suppression per actionId, no response replay — 409+duplicate triggers a client state reconcile; authoritative timer pending) |
| Quiz | 🔬 Experimental — basic reducer + UI, no per-player answer model |
| Plugin SDK (bundled plugins) | ✅ Available |
| Community plugin marketplace | ❌ Disabled by default — runs in-process without isolation (`LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED`) |
| Admin panel (settings, moderation, doctor) | ✅ Available |
| Self-host updates (one-click upgrade/rollback) | 🟡 Preview — apply/rollback gated behind maintenance+signature+backup checks |
| Backups (create/restore) | ❌ Planned — only manifest verification exists today |
| Desktop app (Tauri 2) | 🔬 Experimental — builds and opens, real media spike pending |
| Google OAuth login | ✅ Available (opt-in via env vars) |
| TURN relay | 🟡 Production stack ships coturn (UDP 3478 + TCP + TLS 5349) — advertised via LiveKit; real restricted-network matrix still manual ([docs/VOICE_TURN.md](docs/VOICE_TURN.md)) |

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
- **Native desktop client** — [Tauri 2](https://v2.tauri.app) shell (experimental). See [docs/DESKTOP.md](docs/DESKTOP.md).

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
