# LobbyForge Doctor & Capacity

The Doctor subsystem answers the self-host admin's two questions: *"is my instance healthy?"* and *"how many users can I host?"*. This document is the implementation companion to [`projectdetails/19_OBSERVABILITY_DOCTOR_CAPACITY.md`](../projectdetails/19_OBSERVABILITY_DOCTOR_CAPACITY.md).

The Doctor code lives in two places:

| Layer | Location | What it does |
|---|---|---|
| **Domain primitive** | `packages/core/src/doctor.ts` | Types (`DoctorCheck`, `SystemStats`, `CapacityProfile`), `buildDoctorReport`, `recommendCapacityProfile`. Platform-agnostic — no `import 'node:os'`. |
| **App-specific checks** | `apps/web/lib/doctor.ts` | `buildChecksFromStats` (pure) + `collectSystemStats` (Node-only) + `collectDoctorReport` (HTTP probes). |

This split is deliberate: a future Tauri desktop host or CLI tool can reuse `packages/core` without pulling in Next.js.

## Data model

```ts
type DoctorCategory = 'system' | 'network' | 'services' | 'media';
type AlertLevel = 'info' | 'warning' | 'critical' | 'fatal';

interface DoctorCheck {
  id: string;          // e.g. "postgres", "disk_usage", "turn_configured"
  category: DoctorCategory;
  ok: boolean;         // true ⇒ display as ✅, false ⇒ use level for the glyph
  level: AlertLevel;   // ignored when ok === true
  message: string;     // short, admin-facing sentence
  detail?: Record<string, unknown>;
}

interface SystemStats {
  cpuCount: number;
  loadAverage1m: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  totalDiskBytes: number;
  freeDiskBytes: number;
  diskUsageRatio: number;   // 0..1
  uptimeSeconds: number;
  livekitReachable: boolean | null;
  postgresReachable: boolean | null;
  redisReachable: boolean | null;
  httpsReachable: boolean | null;
  udpLikelyOpen: boolean | null;
  turnConfigured: boolean | null;
  startedAt: Date;
}
```

The tri-state (`true | false | null`) for reachability is intentional: a `null` means "the probe has not run yet" and is shown as `ℹ️ pending`, **not** as a failure. This keeps the Doctor honest — Doctor runs continuously every 15 minutes (per spec §3), so the first report can never claim "everything is fine" if nothing has been probed.

## Capacity profile

`recommendCapacityProfile(stats)` returns one of three tiers plus a numeric profile:

| Tier | Voice cap / room | Camera cap / room | Screen share | Video default | Layout |
|---|---|---|---|---|---|
| LOW | 10 | 2 | 1 | off | active speaker |
| MEDIUM | 40 | 5 | 1 | opt-in | active speaker + thumbnails |
| HIGH | 100 | 9 | 2 | on | grid |

The function follows the spec's "conservative language" rule (§8): it never returns a hard promise. The returned `guidance` string is intentionally phrased as *"With these settings the safe guidance is up to X voice users per room. Re-measure under live load before raising the cap."* — copy-paste from the spec wording.

Tier selection algorithm:

1. Floor: `cpuCount = max(1, stats.cpuCount)`, `totalMemoryBytes = max(512 MB, stats.totalMemoryBytes)`. Even a constrained host gets a sensible answer.
2. Initial pick: `LOW` if ≤ 1 CPU or < 2 GB; `HIGH` if ≥ 4 CPU and ≥ 8 GB and disk < 70 %; otherwise `MEDIUM`.
3. Demote on disk pressure: `diskUsageRatio ≥ 0.95` → `LOW`; `≥ 0.9` and currently `HIGH` → `MEDIUM`.
4. Demote on heavy load: `loadPerCpu > 2` → demote one step; `> 4` (in `buildChecksFromStats`) → `CRITICAL` check.

The function is pure and exhaustive over the tier — Vitest covers all branches in `packages/core/src/__tests__/doctor.test.ts`.

## Checks produced by `buildChecksFromStats`

| ID | Category | Default | When it fails |
|---|---|---|---|
| `cpu_count` | system | ok | never (always ok) |
| `memory_free` | system | ok | < 10 % free ⇒ `CRITICAL`; < 20 % ⇒ `WARNING` |
| `disk_usage` | system | ok | ≥ 95 % ⇒ `FATAL`; ≥ 90 % ⇒ `CRITICAL`; ≥ 80 % ⇒ `WARNING` |
| `load_average` | system | ok | per-CPU load ≥ 2 ⇒ `WARNING`; ≥ 4 ⇒ `CRITICAL` |
| `https` | network | info | `httpsReachable === false` ⇒ `CRITICAL` |
| `udp_range` | network | info | `udpLikelyOpen === false` ⇒ `WARNING` |
| `postgres` | services | info | `postgresReachable === false` ⇒ `CRITICAL` |
| `redis` | services | info | `redisReachable === false` ⇒ `CRITICAL` |
| `livekit_signaling` | services | info | `livekitReachable === false` ⇒ `CRITICAL` |
| `turn_configured` | media | info | TURN missing **and** UDP looks blocked ⇒ `WARNING` |

`null` reachability always renders as `ok: true, level: 'info'` with the message *"… has not been probed yet"*. This is what keeps the very first 60-second ping from being noisy.

## Web app integration

`apps/web/lib/doctor.ts` adds the Node-`os`-bound collector and HTTP probes:

- `collectSystemStats()` — pulls CPU / load / memory from `node:os`, reads `LOBBYFORGE_DISK_USAGE_RATIO` from the env (a future iteration can read `/proc` or call `df` via `child_process`), and seeds all reachability booleans to `null`.
- `collectDoctorReport()` — fills in reachability via `probeUrl()` (1.5 s timeout, accepts 2xx/3xx) against `LIVEKIT_URL`, `POSTGRES_URL`, `REDIS_URL`, and `NEXT_PUBLIC_BASE_URL`, then calls `buildChecksFromStats()` and `buildDoctorReport()`.
- `redactStatsForPublic()` — strips `startedAt` from the public response. The endpoint is admin-facing but unauthenticated in the current skeleton; a future identity layer can remove this redaction entirely.

The web app exposes two routes:

| Route | Auth | Method | Purpose |
|---|---|---|---|
| `GET /api/health` | public | GET | Returns `buildHealthStatus({ web, started }, startedAt)`. Cheap; 120 req/min. |
| `GET /api/doctor` | admin token in production | GET | Returns `{ report, stats }`. Moderately expensive (4 parallel HTTP probes); 12 req/min. |
| `GET /admin/health` | admin token in production | GET | Renders `DoctorReport` as a server component with summary badges + capacity card. |

All three pass through `withApiSecurity` (in `lib/security-headers.ts`), which applies:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- A Redis-backed production rate limit (keyed by route + trusted caller IP).
- A 405 + `Allow` header for any method that is not in the allowlist.

CSRF and an identity layer are deferred until the first state-changing route lands (Phase 2 of the roadmap). The intent is documented as a TODO in `lib/security-headers.ts` style comments.

## What is not implemented yet

The spec calls for several things this skeleton deliberately leaves for later:

- **Real TCP probes for PostgreSQL / Redis.** Today these return `true` optimistically. A real implementation opens a `pg` / `ioredis` connection and pings; both are already in the dependency surface but not wired in (see `probePostgres`/`probeRedis` in `lib/doctor.ts`).
- **UDP reachability probe.** Always `null` today. A real probe sends a STUN binding request and checks the response; deferred because it adds a runtime dep (`stun` or `node-turn`).
- **Nginx config test.** Lives in the `infra/` layer (not the JS app).
- **Disk snapshot from the real filesystem.** Currently a single env var. A future iteration shells out to `df -P` on Linux or reads `Get-PSDrive` on Windows.
- **Admin auth on `/admin/health` and `/api/doctor`.** The route is reachable today; the next pass introduces the user/session model.
- **Webhook / email / banner alert delivery.** The spec describes three alert channels; this skeleton emits the report only. The contract is that anything reading `/api/doctor` can drive its own channel.
- **Continuous / periodic scheduling.** Doctor is on-demand today. A cron tick (60 s health / 15 min full report) is the next step — and the 15-minute debounce rule for duplicate alerts is also future work.

These are listed in `docs/CHANGELOG.md` under "Out of Scope (intentionally deferred)".

## Security Hardening Update

Current behavior after the security pass:

- `GET /api/health` remains public and minimal.
- `GET /api/doctor` is admin-facing. In production it requires
  `LOBBYFORGE_ADMIN_TOKEN` through the `x-lobbyforge-admin-token` header.
- `GET /admin/health` is admin-facing. In production it reads the same token
  from the `lf_admin_token` cookie.
- `LOBBYFORGE_ADMIN_TOKEN` must be at least 32 characters.
- Non-production remains open so local development and tests do not need a
  manual admin-login setup.
- Full role-based instance-admin sessions are still a later product feature.
