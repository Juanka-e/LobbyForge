# Local development infrastructure

Brings up the LobbyForge backing services on a developer machine so that `apps/web` (when it ships) has a real target to talk to.

## Services

| Service   | Port (host)     | Purpose                                                 |
|-----------|-----------------|---------------------------------------------------------|
| postgres  | `5432`          | Primary data store (users, servers, messages, sessions) |
| redis     | `6379`          | Presence, pub/sub, rate limit, short-lived state        |
| livekit   | `7880`/`7881`/`7882/udp` | WebRTC SFU for voice rooms                  |
| mailpit   | `1025` + `8025` | Local SMTP catcher + web UI (profile: `full`)           |
| minio     | `9000` + `9001` | S3-compatible object storage (profile: `full`)          |
| coturn    | `3478` + `5349` | TURN server for NAT traversal (profile: `full`)         |

Profiles:

- **default** — only the three required services (postgres, redis, livekit).
- **full**   — everything, including mail/minio/coturn, started with `--profile full`.

## Quick start

```sh
# 1. Copy the example env file
cp infra/docker/.env.example .env

# 2. Start the required services
docker compose -f infra/docker/docker-compose.dev.yml up -d

# 3. (optional) Add the optional services
docker compose -f infra/docker/docker-compose.dev.yml --profile full up -d

# 4. Tail logs
docker compose -f infra/docker/docker-compose.dev.yml logs -f

# 5. Stop
docker compose -f infra/docker/docker-compose.dev.yml down
```

## Cross-platform notes

- The compose file uses **standard compose syntax** with no `&&` or shell fragments, so the same `docker compose -f … up -d` works on Windows PowerShell, Windows CMD, macOS, and Linux.
- Path-style volume mounts (`postgres-data:/var/lib/postgresql/data`) are **named volumes**, not bind mounts. Docker Desktop on Windows (WSL2 backend) handles them transparently — no `/var/run/docker.sock` quirks.
- Healthchecks are included so that downstream tooling (`apps/web`'s `Doctor` check, future integration tests) can `wait-for` the services without timing-dependent sleeps.
- The dev secrets in `.env.example` are intentionally weak. They are checked in for convenience. **Do not** use these in any environment that is reachable from the public internet.

## What this is *not*

- This is **not** the production deployment. The production stack (Nginx, certbot, single-VPS hardening) lives in `projectdetails/04_DEPLOYMENT_SINGLE_VPS_NGINX.md` and is implemented in a separate set of compose files / scripts that this repository does not yet ship.
- This is **not** an integration test rig. For automated integration tests against these services, see `projectdetails/25_TESTING_STRATEGY.md` (TBD) — typically a `docker compose -f docker-compose.test.yml up -d` inside the test runner with a different data store and seed script.
