# Architecture Decision Records

Status: Accepted — 2026-09-15

## ADR-001: Plugin Runtime Trust Model

**Decision**: Reviewed-only trust model for the community marketplace.

The plugin-worker executes third-party code in a dedicated child process
within a hardened container (read-only fs, mem/pids caps, cap_drop ALL,
no-new-privileges, internal-only network, process-group SIGKILL on
timeout, strict IPC validation). This is adequate for **admin-reviewed,
curated plugins** where the review process is the primary trust gate.

**NOT adequate for arbitrary hostile JavaScript**. The child and parent
share the same UID and container; `/proc/<ppid>/environ` readability
depends on host kernel policy, and a sufficiently motivated plugin
could attempt same-UID signal attacks. Per-plugin containers with
separate UIDs, PID namespaces and cgroups are the path to hostile-code
sandboxing — deferred until the marketplace scales beyond curated.

**Marketplace policy**: submissions require human review before
`approved` status; artifact hash pinning ensures reviewed bytes ==
installed bytes; dynamic plugin execution remains opt-in
(`LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true` + worker URL).

## ADR-002: Plugin Client UI Architecture

**Decision**: Server-only for beta; sandboxed iframe as the target.

Dynamic marketplace plugins currently have `renderClient: () => null` —
they can manage server-side state, handle actions and use scoped
storage, but cannot render their own UI components in the LobbyForge
client. This is a **known functional gap**, not a bug.

**Target architecture** (post-beta):
- Each plugin UI runs in a sandboxed `<iframe>` with
  `sandbox="allow-scripts"` and a plugin-specific origin
- Communication via `postMessage` with a versioned capability protocol
  (state read/write, action dispatch, storage access)
- No direct access to the parent React context, DOM or LobbyForge
  session tokens
- Plugin bundles serve their client entry from the plugin-worker's
  static file path

This keeps untrusted client JS out of the main application context.

## ADR-003: Docker Image Supply Chain

**Decision**: Digest-pinned (IMPLEMENTED).

All six production third-party images AND the Dockerfile base image
are pinned to exact @sha256 digests. CI scans byte-identical to what
production deploys. Dependabot docker-compose is configured to
auto-PR digest updates weekly.

## ADR-004: GitHub Governance Level

**Decision**: Graduated enforcement; full lockdown before release.

Current: branch protection with required CI/security checks,
`enforcement_level: non_admins` (admin can bypass), unsigned commits.

**Pre-release action**: Enable admin enforcement, require PRs for all
changes (including admin), set up commit signing (GPG or SSH key),
create repo rulesets for branch protection.

## ADR-005: Desktop Distribution Security

**Decision**: Defer code signing to pre-distribution phase.

The Tauri desktop shell builds and runs correctly without signing.
Windows SmartScreen and macOS Gatekeeper will show warnings on
unsigned binaries, but this is acceptable for beta/closed testing.

**Pre-distribution action**: Obtain Windows Authenticode certificate,
set up macOS Developer ID + notarization, add SHA-256 checksums and
GitHub artifact attestations to the release workflow, pin release
actions to commit SHAs.

## ADR-006: No Central Authentication — the Hub Is Unauthenticated

**Decision**: The Official Hub (lobbyforge.org) has NO login/register
for end users. Identity is INSTANCE-LOCAL; self-hosting never depends
on a central LobbyForge account. (Accepted — 2026-09-17.)

Rationale: a hub-level login creates the user expectation "one
LobbyForge account works on every LobbyForge server" — the opposite of
the instance-local account model the platform is built on, and a
central dependency for every self-host.

Consequences:
- Hub surfaces (landing, discover, connect, download, docs) are public
  and read-only for visitors.
- "Sign in" flows START at an instance: discover → community → the
  instance's own `/login`.
- The future **LobbyForge ID** (if built) is an OPTIONAL identity
  provider for hub conveniences (starred communities, marketplace
  developer profile, plugin publishing, synced desktop instance list)
  and may be offered to instances as an OAuth provider — it is NEVER
  required to self-host or to run an instance.

**Amended 2026-09-28 — the optional hub account exists.** The official
hub now has sign-up and sign-in (`/login`, `/register`, hub home at
`/home`) — the "LobbyForge ID" foreseen above, in its first form. What
did NOT change:
- It is optional: every hub page a visitor used before stays public.
- It is not an identity for other instances. A self-hosted community
  still signs people in on its own `/login`; the hub account does not
  log you in anywhere else and no instance depends on it.
- It carries hub conveniences only: the communities you belong to on the
  official instance, the desktop app, the marketplace and (later)
  plugin publishing and a synced instance list.

Open: email verification and abuse protection beyond the per-IP rate
limit on sign-up; "Sign in with LobbyForge" as an OAuth provider for
instances remains future work.

## ADR-007: Marketplace Plugins Run Sandboxed (supersedes the trust limits of ADR-001 and the target of ADR-002)

**Status**: accepted 2026-10-03, in implementation on
`feat/bot-api-v2-marketplace-sandbox`.

**Decision**: a marketplace plugin can be installed without trusting its
author. Its code never runs with Node APIs and its UI never runs in the
app's origin.

### Server side — QuickJS in the plugin worker
- Marketplace plugin server code (`server.js` in the bundle) runs inside a
  **QuickJS WebAssembly** runtime (`quickjs-emscripten`) created in the
  plugin worker, one fresh runtime per call. Inside: plain ECMAScript
  only — no `require`/`import`, no `process`, `fs`, network, timers,
  `eval` of host objects, or shared memory. The host passes JSON in and
  reads JSON out; nothing else crosses the boundary.
- Limits per call: memory (32 MB), stack, and a CPU interrupt deadline
  (the existing call budget); exceeding any of them fails the call, never
  the worker. Output size stays capped (4 MiB).
- Contract (`sdk: "sandbox-v1"` in the bundle manifest): `server.js`
  assigns `globalThis.plugin = { createInitialState(ctx),
  handleAction(ctx, state, action), validateAction?(action),
  projectState?(state, viewerId, ctx), migrateState?(raw) }`, and the
  manifest declares `actionPolicies` (the same `GamePluginActionPolicy`
  shape as official plugins: roles, `actorFields`, `joinsRoster`,
  `audit`). `ctx` carries `players`, `now` and `random()` values injected
  by the host (`random` draws from a CSPRNG-seeded list the host passes
  in), `locale`, and the session/server ids. No storage in v1 (state is
  the plugin's only memory); a host-mediated storage effect can follow.
- `projectState` gives marketplace plugins the same per-viewer hidden
  state official plugins have: every read path (REST, SSE, gateway, action
  response) calls it for the viewer; without it the plugin's state is
  public, and the UI warns the installer.
- The worker keeps its container hardening (read-only fs, caps dropped,
  no-new-privileges, memory/pids limits) as defence in depth, sits on a
  network only the web app joins, and makes no outbound calls.
- Legacy bundles (Node `index.js`, ADR-001 model) stop loading; the
  installer refuses bundles without `sdk: "sandbox-v1"`.

### Server side — as implemented (2026-10-03)
Where the implementation refines the points above:
- **Package**: `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync`
  0.32.0 (bellard/quickjs 2025-09-13), pinned exactly — the sync release
  build only, about 1.4 MB instead of the umbrella package's four variants.
- **The interrupt deadline is not a hard wall.** QuickJS checks it between
  bytecodes, so one long native operation runs past it (measured:
  `sort()` on 200 000 numbers in a loop finished 298 s after a 300 ms
  deadline). Run in the worker's main thread that would freeze every
  plugin and the health check. So calls run in a small pool of executor
  threads (`PLUGIN_SANDBOX_THREADS`, default 2); a thread that has not
  answered 250 ms after the budget is terminated (V8 stops running
  WebAssembly within milliseconds) and replaced. The thread is liveness,
  not isolation: the WebAssembly VM is the boundary. The per-call Node
  child process of ADR-001 is gone — plugin code no longer runs as Node.
- **Fresh per call** means a fresh WebAssembly instance (new linear
  memory), not just a fresh QuickJS runtime: nothing an earlier call left
  in memory — another plugin's state included — is reachable even through
  a QuickJS bug. Cost: about 1.5 ms per call.
- **Limits**: 32 MB VM memory, 256 KiB VM stack (caught by QuickJS before
  the thread's native stack), budget `PLUGIN_CALL_BUDGET_MS` lowered from
  10 s to a 2 s default (a sandboxed reducer needs milliseconds, and a
  stuck call holds a thread for the whole budget), 4 MiB result, 2 MiB
  `server.js`, 1024 CSPRNG values per reducer call (`PLUGIN_RANDOM_VALUES`;
  `Math.random` draws from the same list; none at load time).
- **No host functions at all.** The prelude that runs before `server.js`
  hands the host a call function plugin code cannot reach, and removes
  `SharedArrayBuffer` (the build has no Atomics). Plugin code tampering
  with built-ins only changes its own output, which the host validates
  (JSON, object-shaped states, size cap).
- **`projectState` ctx** is `{ sessionId, serverId, hostId, now }` — no
  players and no locale, because the gateway knows neither and a
  projection must not differ between REST, SSE and WebSocket.
- **Policies are the web app's reading of the manifest**, validated by
  the installer and on every load from the web app's own copy of the
  files; the worker's `describe` must report the same policies or the
  plugin does not load. A VM escape therefore cannot widen who may send
  which action.
- **The gateway** (which cannot reach the worker) projects only the
  official plugins itself (`isCoreProjectedPlugin`) and asks the web app
  for every other id through `POST /api/internal/activity-projection`,
  signed with a key derived from `LOBBYFORGE_SESSION_SECRET` (which the
  gateway already holds); failure means an event without state.
- `/api/internal/plugin-storage` and `LOBBYFORGE_PLUGIN_STORAGE_TOKEN` on
  `web` remain but are unused until a host-mediated storage effect.

### Client side — sandboxed iframe
- A marketplace plugin may ship `ui/index.html` (+ assets). The lobby
  renders it in `<iframe sandbox="allow-scripts">` (no
  `allow-same-origin`, forms, popups, top navigation or downloads) from
  `/api/plugin-ui/{pluginId}/{version}/…`, so the frame has an **opaque
  origin**: it cannot read the app's cookies, storage or DOM, and the
  app's SameSite=Lax session cookie is not sent with its requests.
- The asset route answers with its own CSP: `default-src 'none';
  script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'
  data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self';
  base-uri 'none'; form-action 'none'` plus `X-Content-Type-Options:
  nosniff`. No network: the frame cannot exfiltrate what it is shown.
  The app's own CSP gains `frame-src 'self'`.
- **postMessage protocol v1** (all messages carry `lf: 1`): parent →
  frame `init { viewer, players, locale, theme (CSS variables), state }`
  and `state { state, revision }` (the PROJECTED state for that viewer);
  frame → parent `ready`, `action { action }`, `resize { height }`.
  The parent accepts messages only from that iframe's `contentWindow`,
  validates shape and size (≤ 64 KiB, ≤ 10 actions/s), and dispatches
  actions through the normal actions route with the viewer's session —
  the frame can do nothing the viewer could not do by sending actions.
- `@lobbyforge/plugin-sdk/frame` gives plugin authors a tiny client for
  this protocol plus the theme variables.

### Consequences
- Review stays (catalog approval, digest pinning), but it is no longer
  the only thing between a plugin and the instance.
- Official plugins stay compiled in (they are trusted code and keep
  React panels in the app origin).
- Remaining risk: a plugin can still waste its own call budget or show
  misleading UI inside its frame; it cannot read other state, sessions or
  the network. Server side, a busy plugin can occupy the executor threads
  for up to one budget per call and so slow other marketplace plugins
  (never official ones, which do not use the worker); a QuickJS or V8
  WebAssembly escape would land in the worker container, which holds only
  the worker's RPC token and can reach only the web app.
