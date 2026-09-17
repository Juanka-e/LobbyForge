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

**Decision**: The Official Hub (lobbyforge.com) has NO login/register
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
