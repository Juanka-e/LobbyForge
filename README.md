# LobbyForge

> Self-hostable, voice-first community platform with a built-in plugin SDK for live activities.

LobbyForge is an open-source community platform you run on your own server. It
takes the "server → channel → voice room" structure you know, and lets voice
rooms run live activities — games, quizzes, watch parties — through a typed
plugin SDK.

Discord owns your data. TeamSpeak can't run games. Element is text-first.
LobbyForge is the open niche: **voice-first + plugin SDK + self-hostable**.

| | LobbyForge | Discord | TeamSpeak | Revolt |
|---|:-:|:-:|:-:|:-:|
| Voice-first | ✅ | ✅ | ✅ | ❌ |
| Plugin SDK (in-room activities) | ✅ | ❌ | ❌ | ❌ |
| Self-hostable | ✅ | ❌ | ✅ | ✅ |
| Guest-friendly (no account needed) | ✅ | ❌ | ❌ | ❌ |

## Features

- **Voice rooms** powered by [LiveKit](https://livekit.io) — WebRTC SFU, mic/camera/screen-share, speaking indicators, per-user volume.
- **Plugin SDK** — pure reducer pattern (`State → Action → State`), 9 sub-contexts, declarative auth, per-plugin i18n, built-in test harness.
- **Pre-installed games** — Hushle (Taboo-style), Quiz, Vampire Village, Watch Party. All removable.
- **Guest access** — invite link → one click into a voice room. No account required.
- **Real-time** — WebSocket gateway + Redis pub/sub for presence, chat, and activity state.
- **Doctor** — built-in health monitoring + automatic capacity profiling (how many voice/camera users your hardware can host).
- **Self-host updates** — Ed25519-signed manifests, one-command upgrade, verified backups.
- **Privacy-first defaults** — SEO off, invite-only registration, no telemetry, strict security headers (CSP, HSTS, Fetch-Metadata CSRF).
- **i18n** — English + Turkish; community translations welcome.
- **Calm Future design system** — quiet, premium, trust-evoking. Dark palette + ice-blue accent + glassmorphism. Not a neon gamer skin.

## Tech stack

- **[Next.js 15](https://nextjs.org)** (App Router) + React + TypeScript
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
  desktop/      Electron shell (planned)
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
- **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** — how to contribute
- **[docs/CHANGELOG.md](docs/CHANGELOG.md)** — full change history

## Contributing

See **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**. TL;DR: Node ≥ 22, pnpm ≥
10.12.1, run `pnpm verify` before pushing. No `&&` in scripts (cross-platform),
always include `.js` extensions on relative ESM imports.

## License

[AGPL-3.0-only](LICENSE) — open source. Self-host freely; derivative services
must stay open.
