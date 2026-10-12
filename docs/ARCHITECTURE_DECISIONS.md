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

**Amended 2026-10-09: signing is wired, off until secrets exist.** The
choice of certificate follows
[DESKTOP_SIGNING_INSTALLER_RESEARCH_2026-10.md](DESKTOP_SIGNING_INSTALLER_RESEARCH_2026-10.md):
no free route removes the SmartScreen warning today; Certum Open Source
(SimplySign cloud, from €49) is the cheapest route open to an individual in
Turkey; SignPath Foundation is free but asks for reputation the project does
not have yet. Azure Artifact Signing is not available in Turkey.

As implemented (owner guide: [DESKTOP_SIGNING.md](DESKTOP_SIGNING.md)):
- **One pipeline.** `desktop-release.yml` is the only place installers are
  built; `release.yml` calls it for `v*` tags (version stamped in), and it
  can be run by hand for test builds plus a Windows install smoke test.
  The tauri-action build on `desktop-v*` tags is retired: two copies of the
  signing steps would drift, and desktop versions already follow the
  unified release.
- **Off until configured.** `apps/desktop/scripts/release-signing.mjs`
  reads which secrets are set (environment `desktop-signing`). No secrets:
  unsigned, green. Half a provider, or two Windows providers: the build
  fails rather than silently shipping unsigned. Signing settings never
  live in the committed `tauri.conf.json`; CI passes them with `--config`.
- **Windows, Certum:** `CERTUM_EMAIL` + `CERTUM_OTP` (the TOTP seed) →
  `bundle.windows.signCommand` runs `ssign` (HTTPS client for SimplySign,
  downloaded and hash-pinned), so Tauri signs the app, the NSIS plugins,
  the uninstaller and the installer. MSI is skipped in these builds
  (ssign cannot sign MSI). Fallback without storing the seed:
  `pnpm --filter @lobbyforge/desktop sign:local` on the owner's machine
  with a one-time code, or a certificate thumbprint from the Windows
  store.
- **Windows, SignPath:** `SIGNPATH_API_TOKEN` + `SIGNPATH_ORGANIZATION_ID`
  → the app exe is signed through SignPath's action before bundling
  (pre-patched with the bundle-type marker so the bundler leaves the
  signature intact) and the installers after; release tags only, unless a
  test policy is configured. The NSIS-generated uninstaller stays unsigned
  on this route.
- **macOS:** `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` sign;
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or an App Store Connect API
  key notarize. Empty variables are unset before Tauri runs.
- **Least exposure.** The compile step sees no secret; only the bundling
  step gets the chosen provider's secrets; values are never printed;
  signatures are verified after bundling, and a platform that fails
  uploads nothing instead of an unsigned installer.
- **Installer.** A custom NSIS template (Tauri's, four fenced changes)
  makes the default install one-click, per user (`%LOCALAPPDATA%`, no UAC),
  with a compact branded progress window that opens the app when done;
  `/WIZARD` keeps Tauri's pages. English and Turkish follow the system
  language. Publisher is "LobbyForge contributors" (it was the product
  name, which the Microsoft Store rejects).

Still open: buying the certificate or SignPath's acceptance; macOS
Developer ID when Mac users arrive; Microsoft Store (MSIX) and winget
channels; the Tauri updater.

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
  the plugin's only memory); a host-mediated storage effect can follow
  (it did: phase 3, below).
- `projectState` gives marketplace plugins the same per-viewer hidden
  state official plugins have: every read path (REST, gateway, action
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
  projection must not differ between REST and WebSocket.
- **Policies are the web app's reading of the manifest**, validated by
  the installer and on every load from the web app's own copy of the
  files; the worker's `describe` must report the same policies or the
  plugin does not load. A VM escape therefore cannot widen who may send
  which action.
- **Translations** (added 2026-10-12): a bundle may ship
  `locales/<code>.json`, flat string tables validated with the manifest
  (`parseSandboxBundle`, same caps in the installer and the worker). The
  web app registers them with the plugin SDK's process-wide locale
  registry under the plugin's id, so the host's own screens show its
  `catalog.name` / `catalog.summary` in each viewer's language; never
  for the id of a compiled-in plugin. The iframe does not receive them.
- **The gateway** (which cannot reach the worker) projects only the
  official plugins itself (`isCoreProjectedPlugin`) and asks the web app
  for every other id through `POST /api/internal/activity-projection`,
  signed with a key derived from `LOBBYFORGE_SESSION_SECRET` (which the
  gateway already holds); failure means an event without state.
- `/api/internal/plugin-storage` and `LOBBYFORGE_PLUGIN_STORAGE_TOKEN` on
  `web` remain but are unused: storage became a host effect (below) and
  the worker still makes no outbound calls.
- **Host effects** (2026-10, phase 3a of docs/PLUGIN_UNLOCK_PLAN.md):
  `createInitialState` / `handleAction` may return `{ __lf: 1, state,
  effects }` — `timer.set` / `timer.clear`, `storage.set` /
  `storage.delete`, `chat.post`. They are still pure data crossing the
  boundary: the VM returns them beside the state, and the web app
  validates each one against the plugin's EFFECTIVE permissions (manifest
  `permissions` asked for AND approved at install) and applies all or none
  (`effect_refused`). Timers fire lazily under the session lock as
  `role: "system"` actions no client can send; `ctx.storage` is a
  read-only JSON snapshot passed in with the call, written back after the
  commit; a chat post becomes an author-less app message in the text
  channel the community chose. Official plugins use the same effects with
  their manifest's permissions. Details: docs/PLUGIN_SDK.md "Effects".

### Client side — sandboxed iframe
- A marketplace plugin may ship `ui/index.html` (+ assets). The lobby
  renders it in `<iframe sandbox="allow-scripts">` (no
  `allow-same-origin`, forms, popups, top navigation or downloads) from
  `/api/plugin-ui/{pluginId}/{version}/…`, so the frame has an **opaque
  origin**: it cannot read the app's cookies, storage or DOM, and the
  app's SameSite=Lax session cookie is not sent with its requests.
- The asset route answers with its own CSP: `default-src 'none';
  script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self'; media-src <own> data: blob:;
  connect-src <own>; frame-ancestors 'self'; base-uri 'none'; form-action
  'none'` plus `X-Content-Type-Options: nosniff`, where `<own>` is the
  plugin version's own folder on the configured public origin
  (`https://<instance>/api/plugin-ui/<id>/<version>/`; `'self'` when no
  origin is configured). No network: `fetch()` and media reach the
  plugin's own files and nothing else, so the frame cannot exfiltrate what
  it is shown. WebAssembly compiles (`'wasm-unsafe-eval'`) but reaches
  nothing a script cannot. The app's own CSP gains `frame-src 'self'`.
  (2026-10: phase 1 of the plugin unlock — media, WebAssembly and the
  plugin's own files; the first version had `connect-src 'none'`.)
- **Approved outside origins** (2026-10, phase 2 of the plugin unlock,
  docs/PLUGIN_UNLOCK_PLAN.md): a manifest may ask for `network` origins
  (`connect`, `img`, `media`, `frame`), which take effect only once the
  instance owner approves them at install (`approved` on the active
  record). The HTML document's policy then adds the plugin's EFFECTIVE
  origins — asked for AND approved — to `connect-src`, `img-src`,
  `media-src` and `frame-src` (no `frame-src` otherwise). A nested frame
  inherits the sandbox (opaque origin). Because the approval can change for
  one version, the HTML is `Cache-Control: no-cache`; every other file
  keeps the base policy (a subresource's CSP does not govern the frame) and
  stays `immutable`.
- **The author's own site as the UI** (phase 2): `ui: { url }`, once
  approved, is framed directly with `sandbox="allow-scripts
  allow-same-origin allow-forms allow-pointer-lock"` and
  `referrerpolicy="no-referrer"` — never `allow-top-navigation`,
  `allow-popups` or `allow-modals`. `allow-same-origin` (the site keeps its
  own origin, cookies and storage) is safe only because that origin is not
  the app's, so a URL on the app's host — any port or scheme, since
  cookies are scoped by host — or on a subdomain either way is refused at
  install, in the frame info route and in the lobby. The app's pages add
  the approved sites to `frame-src` (a 30 s per-process cache read from the
  install root, reset on install; nothing added on error). The lobby shows
  the site's host above the frame so its content is visibly not the app.
- **postMessage protocol v1** (all messages carry `lf: 1`): parent →
  frame `init { viewer, players, locale, theme (CSS variables), state }`
  and `state { state, revision }` (the PROJECTED state for that viewer);
  frame → parent `ready`, `action { action }`, `resize { height }`.
  The parent accepts messages only from that iframe's `contentWindow`
  AND the expected origin (`"null"` for the plugin's files, the approved
  site's origin for an external UI — the window survives a navigation, the
  origin does not), validates shape and size (≤ 64 KiB, ≤ 10 actions/s),
  and dispatches actions through the normal actions route with the
  viewer's session — the frame can do nothing the viewer could not do by
  sending actions. It posts to an external site's origin only; to the
  opaque files frame it must post to `'*'`.
- `@lobbyforge/plugin-sdk/frame` gives plugin authors a tiny client for
  this protocol plus the theme variables. On an external site (a real
  origin of its own, framed by any instance that installed the plugin) it
  sends only `ready` until the parent's first `init` names the parent's
  origin, then talks to that origin only.

### Consequences
- Review stays (catalog approval, digest pinning), but it is no longer
  the only thing between a plugin and the instance.
- Official plugins stay compiled in (they are trusted code and keep
  React panels in the app origin).
- Remaining risk: a plugin can still waste its own call budget or show
  misleading UI inside its frame; it cannot read other state, sessions or
  the network beyond the origins the owner approved (which then see what
  players see; an approved site can change what it serves at any time).
  Sibling subdomains of the app's registrable domain cannot be told apart
  from other sites without the Public Suffix List, so the owner should not
  approve an external UI on their own domain. Server side, a busy plugin can occupy the executor threads
  for up to one budget per call and so slow other marketplace plugins
  (never official ones, which do not use the worker); a QuickJS or V8
  WebAssembly escape would land in the worker container, which holds only
  the worker's RPC token and can reach only the web app.
