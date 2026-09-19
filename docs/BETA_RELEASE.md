# Beta Release Checklist

Status: Closed-beta release candidate — `v0.2.0-rc.7` (2026-09-19). The
beta-readiness review ([BETA_READINESS_REVIEW.md](BETA_READINESS_REVIEW.md))
found moderation, voice, desktop and release-pipeline defects that the
earlier "ready" claim missed. All are fixed and verified live (§8 of the
review). The updater chain was drilled end to end against the real signed
rc.6 release on a local production stack (see "Update drill" below).

Before inviting testers, three things still need your infrastructure or
hardware:
- one fresh install on a real VPS with DNS and Let's Encrypt;
- desktop PTT on macOS and Linux;
- a coturn relay test from a UDP-blocked network.

## Pre-beta verification

- [x] Beta-readiness review remediated (2026-09-19): S1 role escalation,
      S2 bans, S3 lobby leak, S4 voice moderation, S5–S11, V1–V14, I1–I9,
      I11 — see CHANGELOG "[Unreleased] - beta readiness remediation"
- [x] CI: real-UI voice + realtime E2E (`voice-ui-audio.spec.ts`) and
      real-Postgres integration/ban tests in the pipeline
- [x] CI: the published-image job asserts no baked localhost media URL
      and no pem/key/dump files in `/app`
- [x] New RC tags from the remediated main:
  - `v0.2.0-rc.6`: gate, candidate, exact-digest Trivy scan, promote,
    GitHub release and three-platform desktop bundles all green.
  - `v0.2.0-rc.7`: adds the coturn and desktop-connect fixes found while
    drilling rc.6. Verified after release:
    - `lfctl update apply` from rc.5 to the signed rc.7 manifest: healthy,
      data intact, runtime `livekitUrl`;
    - the published Windows installer (checksum verified) connects and
      delivers global PTT and shortcuts to the page;
    - coturn starts with the shipped template (14 deny ranges, healthy).
- [x] Desktop on **Windows** (real Windows 11, WebView2 driven over CDP):
  - the connect screen reaches an HTTPS instance;
  - global Ctrl+Space press and release, Ctrl+Shift+M and Ctrl+Shift+D
    arrive in the page;
  - the instance page gets "not allowed by ACL" for every command.

  rc.5 failed the same test: Connect was broken and the page received no
  PTT events.
- [ ] Desktop: the same check on **macOS** and **Linux**
- [x] Dev-dependency upgrade: vitest 4.1, happy-dom 20 and a patched
      vite/eslint chain; `pnpm audit` is clean (#23)

- [x] Security audit findings remediated; further hardening now comes from release drills and runtime testing
- [x] CI: Ubuntu + Windows verify, Docker build, production compose config
- [x] CI: Production TLS E2E (HTTPS, HTTP→HTTPS redirect, WSS upgrade, CSP nonce + hydration)
- [x] CI: Two-client voice E2E (real WebRTC through LiveKit)
- [x] CI: Destructive backup drill (backup → destroy → restore → verify)
- [x] CI: Real-Postgres migration + channel visibility + ownership integration tests
- [x] Security: CodeQL security-extended, RustSec (Cargo.lock), pnpm audit (prod)
- [x] Security: Trivy CRITICAL+HIGH gate on OUR web image (CI + the exact released digest BEFORE release tags are attached — candidate push → digest scan → promote); third-party images gate CRITICAL with HIGH reported (upstream base-layer HIGHs are outside our control — per-image ignores document exceptions)
- [x] Security: Branch protection with 16+ required checks, force-push disabled
- [x] Supply chain: All Docker images digest-pinned (@sha256), Dependabot docker-compose
- [x] Supply chain: Dockerfile base image digest-pinned (node:22-bookworm-slim)
- [x] Supply chain: Plugin artifact hash pinning (review hash'ler, install doğrular)
- [x] Desktop: Native state binding (session swap closed), GETDEL handoff, deep-link gate
- [x] Registry: Account-bound challenge + domain proof + SSRF-safe fetch + key rotation
- [x] Realtime: WS event-driven invalidation + 30s periodic reauth + SSE instant abort
- [x] Authorization: Centralized membership+visibility gates, moderation hierarchy
- [x] Updates: Safety gates (available/supported/signature/major) + strict (auto-created) backup + signed-digest deploy + migrate + health check + persisted version state + app-level rollback
- [x] Release: tag push gates on ALL CI+security checks (19 contexts, completed+success) before publishing
- [x] Release: `release-manifest.json` generated per release (Ed25519-signed when `LF_RELEASE_SIGNING_KEY` secret is set)
- [x] Release signing key provisioned: public half committed at `infra/update/release-public.pem` (keyId `34c793ff090fc436`), private half in the `LF_RELEASE_SIGNING_KEY` secret — every release manifest ships signed

## Known release-engineering constraints (pre-stable decisions)

- **Release image is explicitly pinned to linux/amd64 for beta** (the
  workflow sets `platforms: linux/amd64` — not a runner default). Beta
  targets standard x86_64 VPSes. ARM64 (Oracle ARM, Raspberry Pi class)
  requires `platforms: linux/amd64,linux/arm64` + QEMU in the build and a
  multi-arch scan strategy — evaluate after beta.
- **Candidates live in the public package**: GHCR visibility is
  package-level and public→private is not reversible, so after the first
  release the `candidate-<sha>` refs are anonymously pullable pre-scan.
  They are the exact bytes the scan gates; release tags/manifests still
  only appear post-scan. If the strict "no unscanned bytes publicly
  readable" bar is wanted for stable, move candidates to a separate
  private package (e.g. `lobbyforge-candidates`) before v1.0.
- **Scanner pin ≠ pin forever**: the Trivy scanner image is digest-pinned
  for immutability, but its VERSION must still be bumped deliberately as
  maintenance (0.74.0 is current; 0.65.0 is pinned). The vulnerability DB
  refreshes on every run regardless — the pin only fixes the scanner
  binary itself.

## Release policy: migrations must be rollback-safe (expand/contract)

App rollback (`lfctl update rollback`) restores the previous image — the
database schema is NOT rolled back (drizzle migrations are forward-only).
For that to be safe, releases MUST use expand/contract migrations:

1. **Expand release**: additive schema changes only (new nullable
   columns, new tables). The OLD app image must run correctly against
   the expanded schema — this is what rollback re-deploys.
2. **Contract release (later)**: only after the release that stopped
   reading/writing the old shape has been deployed everywhere, a
   subsequent release may drop columns/tables.

A release that DROPS or narrows schema the previous image still uses
makes rollback a lie; breaking migrations require a backup restore
instead (`lfctl backup restore --file <dump> --to <empty-db>`).

## Known limitations (documented in ADRs)

- [ADR-001] Plugin runtime: reviewed-only trust model (child-process + container, NOT hostile-code sandbox)
- [ADR-002] Plugin client UI: server-only (sandboxed iframe is the post-beta target)
- [ADR-003] Supply chain: digest-pinned (IMPLEMENTED)
- [ADR-004] Governance: graduated (admin bypass + unsigned commits OK for single-developer beta)
- [ADR-005] Desktop: unsigned builds (code signing before public distribution)

## Beta deployment

```bash
# Install (Linux/macOS) — the installer needs the repo files next to it
# (compose stack, nginx/livekit templates, lfctl), so clone first:
# curl | bash does NOT work.
git clone --branch <release-tag> --depth 1 https://github.com/Juanka-e/LobbyForge.git
cd LobbyForge && bash install.sh
# Default TLS: Let's Encrypt. Behind Cloudflare with an Origin CA
# certificate instead? See docs/DEPLOY_CLOUDFLARE.md.

# Updates — every GitHub release publishes a SIGNED release-manifest.json
# that pins the immutable image digest. Defaults just work: the manifest
# URL and the committed official public key are picked up automatically.
node scripts/lfctl.mjs update check    # what's available (signature verified)
node scripts/lfctl.mjs update plan     # review the plan
node scripts/lfctl.mjs update apply --yes   # auto-backup + gates + signed-digest deploy + migrate + health
node scripts/lfctl.mjs update rollback     # restore the previous recorded image + version
# Forks: override with --manifest <url> / --public-key <pem> or
# LOBBYFORGE_RELEASE_MANIFEST / LOBBYFORGE_RELEASE_PUBLIC_KEY_PEM.
```

## What to test in beta

1. **Voice**: Join a room with 2+ clients (browser + desktop), test mic/camera/screen share
2. **Chat**: Text channels, DMs, typing indicators, message history
3. **Plugin games**: Start Hushle in a voice room, play a round
4. **Discovery**: Register on the official directory, heartbeat, moderate
5. **Self-host**: Install, configure, update, backup + restore
6. **Desktop**: Connect to instance, login handoff, global push-to-talk

## Release drill — v0.2.0-rc (results: rc.1 + rc.2)

The unified `v*` release pipeline ran for real on GitHub. rc.1 exercised
the chain up to promote and caught two integration bugs (desktop pnpm
ordering; artifact download pattern); rc.2 completed the release.

- GitHub `releases/latest` does NOT include prereleases — for RC updater
  tests pass the manifest explicitly:
  `--manifest https://github.com/Juanka-e/LobbyForge/releases/download/v0.2.0-rc.2/release-manifest.json`

Results (final: **v0.2.0-rc.4 — all jobs green, full artifact set**):

- [x] RC tag pushed → 19 checks green → release gate passed → GHCR push
- [x] ghcr.io/juanka-e/lobbyforge package is PUBLIC
- [x] Anonymous digest pull (no GitHub credentials) — verified locally (rc.1, rc.2 digests)
- [x] `lfctl update check` against REAL release manifests: signature valid
      (committed public key), digest pinned; semver correct both ways
      (0.1.9 → rc.4 offered; 0.2.0 final is NOT "upgraded" to an RC)
- [x] Desktop artifacts for ALL THREE platforms with one flat
      SHA256SUMS.txt: linux rpm + AppImage + deb, macOS dmg,
      Windows NSIS setup.exe (MSI can't hold semver prereleases — NSIS-only on Windows)
- [x] Fail-closed gate proven live: rc.3 was REFUSED (a check state the
      gate could not accept), no release created — then the rule was
      refined (cancelled runs are non-authoritative) and rc.4 shipped

Iterations caught by the drill (exactly its purpose): rc.1 — desktop
pnpm setup order + SBOM artifact in the download; rc.2 — Windows MSI
semver limit; rc.3 — cancelled duplicate check runs tripping the gate;
rc.4 — clean end-to-end.

- [ ] Fresh tagged install (`git clone --branch v0.2.0-rc.7` + install.sh) on a clean VPS
      (needs real DNS + Let's Encrypt — not reproducible locally)
- [x] Real old → RC update via `lfctl update apply` (local production stack, see below)
- [x] Forced failure drill: health fails after recreate → old containers restored (live, see below)
- [x] `lfctl backup restore` round-trip (live, see below)

## Update drill — rc.5 → rc.6 (2026-09-19, local production stack)

Setup:
- The `v0.2.0-rc.5` checkout, running the production compose file with
  rendered configs, a self-signed TLS certificate, and rc.5 pinned to its
  signed GHCR digest.
- Project, network and container names were prefixed and host ports
  shifted so the stack could run next to other stacks.
- It was seeded through the nginx TLS edge: owner setup plus 3 messages.
- The old (rc.5) `lfctl` performed every step.

| Step | Result |
|---|---|
| `update check` against the real rc.6 manifest | signature **valid** (committed key), rc.5 → rc.6 offered |
| Published rc.6 image hygiene | no localhost media URL in the browser bundles; no pem/key/dump files |
| `update apply --yes` | fresh backup created and verified (sha256); digest deployed; migration 0036 applied; health green; `.env.prod` and `deployment-state.json` updated with a `previous` pointer |
| After the update | all app containers on the rc.6 digest and healthy; the 3 messages intact; the voice token returns the runtime `livekitUrl` |
| `update rollback` | rc.5 runs healthy on the expanded schema (expand-only migration confirmed); login and data OK |
| `backup restore` into an empty DB | 3 messages and 1 user restored with the pre-update schema |
| Forced failure **before** recreate (image without node, signed with a throwaway key via `--public-key`) | stopped at `apply-migrations`; old containers untouched; `.env.prod` restored |
| Forced failure **after** recreate (rc.6 without a Next build: migrations pass, web unhealthy) | "OLD CONTAINERS RESTORED AND HEALTHY"; `.env.prod` restored; data intact |

Found by the drill and fixed in rc.7:
- **coturn aborted on the IPv6 CIDR deny rules**, so TURN never ran on
  any install.
- **The desktop connect screen could not invoke** (`withGlobalTauri`).

## Reporting issues

- Security: use GitHub Security Advisories (private)
- Bugs: open a GitHub issue with reproduction steps
- Feature requests: open a GitHub issue with the `enhancement` label
