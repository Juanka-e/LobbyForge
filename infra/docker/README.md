# Local development infrastructure

Runs LobbyForge on a developer machine: the backing services and the app
itself (`docker-compose.dev.yml` builds the image and starts the web app as a
production build, plus the realtime gateway).

**This machine only** (security-review INFRA-V-02): every published port is
bound to `127.0.0.1`, and the stack runs with public development secrets.
web and ws-gateway accept a placeholder session secret here only because the
compose file sets `LOBBYFORGE_DEV_STACK=true` — never set that anywhere else.
Anything other people reach runs the production stack (`install.sh`).

## Services

| Service    | Host port (127.0.0.1)          | Purpose                                                 |
|------------|--------------------------------|---------------------------------------------------------|
| postgres   | `19532`                        | Primary data store (users, servers, messages, sessions) |
| redis      | `19579`                        | Presence, pub/sub, rate limit, short-lived state        |
| livekit    | `19580` + `19582/udp`          | WebRTC SFU for voice rooms (signaling + media)          |
| migrate    | —                              | One-shot schema migrations (runs before web/gateway)    |
| web        | `19520`                        | Next.js UI and API                                      |
| ws-gateway | `19521`                        | Realtime WebSocket subscriptions                        |
| mailpit    | `19525` + `19526`              | Local SMTP catcher + web UI (profile: `full`)           |
| minio      | `19590` + `19591`              | S3-compatible object storage (profile: `full`)          |
| coturn     | host network, `127.0.0.1` only | TURN server for NAT traversal (profile: `full`)         |

LiveKit advertises `127.0.0.1` to clients (`--node-ip`), so dev voice works
from browsers on this machine — which is exactly what the loopback-bound
media port allows. Voice from another device needs the production stack.

Profiles:

- **default** — postgres, redis, livekit, migrate, web and ws-gateway.
- **full**   — everything, including mail/minio/coturn, started with `--profile full`.

## Quick start

```sh
# 1. Copy the example env file next to the Compose file
cp infra/docker/.env.example infra/docker/.env

# 2. Generate a setup token and put the printed value in
#    infra/docker/.env as LOBBYFORGE_SETUP_TOKEN=<value>
pnpm lfctl setup token

# 3. Build the image and start the stack
docker compose -f infra/docker/docker-compose.dev.yml up -d --build

# 4. (optional) Add the optional services
docker compose -f infra/docker/docker-compose.dev.yml --profile full up -d

# 5. Tail logs
docker compose -f infra/docker/docker-compose.dev.yml logs -f

# 6. Stop
docker compose -f infra/docker/docker-compose.dev.yml down
```

The setup token is a 256-bit first-owner claim secret, not an account
password. A production installer must generate it automatically, save it only
in the deployment environment file, and print it once for the server operator.
After setup completes, the database bootstrap lock permanently closes the
wizard; the token can then be rotated or removed before recreating `web`.

The one-shot `migrate` service applies only journaled forward migrations and
must succeed before `web` and `ws-gateway` start. Rebuilding or recreating app
containers does not delete accounts: PostgreSQL data remains in the
`postgres-data` named volume. Never use `docker compose down -v` unless the
explicit goal is to erase all local data.

The release smoke sequence is documented in
[`docs/MANUAL_TEST_CHECKLIST.md`](../../docs/MANUAL_TEST_CHECKLIST.md).

## Node threadpool (`UV_THREADPOOL_SIZE`)

The image sets `UV_THREADPOOL_SIZE=16` (the [`Dockerfile`](../../Dockerfile)
runtime stage, right before the web server's `CMD`). libuv's threadpool —
4 threads by default — runs scrypt password hashing, zlib, file I/O and
`dns.lookup` for the whole process, so a handful of slow DNS lookups could
otherwise stall sign-ins. Bot event deliveries resolve their hosts off the
pool with a 2 s deadline ([BOT_API_V2.md §5.2](../../docs/BOT_API_V2.md));
the installer, the directory and CAPTCHA siteverify still use the system
resolver. Node reads the variable once at start: to change it, set
`UV_THREADPOOL_SIZE` in `.env.prod` (the `web` service's `env_file`) and
recreate the container. The other services built from the same image
(`ws-gateway`, `plugin-worker`, `migrate`) inherit it; the threads are only
created when the pool is first used.

## Cross-platform notes

- The compose file uses **standard compose syntax** with no `&&` or shell fragments, so the same `docker compose -f … up -d` works on Windows PowerShell, Windows CMD, macOS, and Linux.
- Path-style volume mounts (`postgres-data:/var/lib/postgresql/data`) are **named volumes**, not bind mounts. Docker Desktop on Windows (WSL2 backend) handles them transparently — no `/var/run/docker.sock` quirks.
- Healthchecks are included so that downstream tooling (`apps/web`'s `Doctor` check, future integration tests) can `wait-for` the services without timing-dependent sleeps.
- The dev secrets in `.env.example` are intentionally weak. They are checked in for convenience. **Do not** use these in any environment that is reachable from the public internet — the app refuses the placeholder session secret everywhere except this stack (`LOBBYFORGE_DEV_STACK=true`), and the stack's ports stay on `127.0.0.1`.

## What this is *not*

- This is **not** the production deployment. Production SHIPS in this repo: [`docker-compose.prod.yml`](docker-compose.prod.yml) (nginx + certbot + web + postgres + redis + livekit + coturn + ws-gateway) provisioned by [`install.sh`](../../install.sh) — see [docs/VOICE_TURN.md](../../docs/VOICE_TURN.md) for the voice/TURN port matrix. This dev file remains the local-development stack.
- Integration/E2E: the CI `e2e` job runs Playwright against THIS compose stack (real Postgres/Redis/LiveKit and the production-built image). `scripts/e2e-compose.sh` runs the same locally; `docker-compose.e2e-ports.yml` runs an isolated copy beside a live dev stack. Overlays for that copy: `docker-compose.e2e-plugins.yml` (plugin worker + dynamic plugins; `e2e-install-sandbox-plugin.sh` installs the example), `docker-compose.e2e-mail.yml` (Mailpit) and `docker-compose.e2e-bundles.yml` (a publisher stand-in on an internal network, so the real marketplace submit → review → install routes download a bundle over pinned HTTPS; `e2e-bundle-host.sh` makes its throw-away CA first).
- Production exposure note: in production only 80/443 (+ the WebRTC/TURN UDP-TCP ranges) need to be public. LiveKit's signaling port is proxied by nginx at `wss://<domain>/livekit` — do NOT expose it directly in production; the ports listed above are the DEV stack's loopback-only host mappings.
