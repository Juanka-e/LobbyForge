# Beta Release Checklist

Status: Closed-beta release candidate — 2026-09-19. The beta-readiness
review ([BETA_READINESS_REVIEW.md](BETA_READINESS_REVIEW.md)) found
moderation, voice and release-pipeline defects that the earlier "ready"
claim missed. All are fixed and verified live (§8 of the review). What
remains before inviting testers: the VPS drill below, desktop PTT on real
OSes, and cutting a new RC tag from the remediation branch.

## Pre-beta verification

- [x] Beta-readiness review remediated (2026-09-19): S1 role escalation,
      S2 bans, S3 lobby leak, S4 voice moderation, S5–S11, V1–V14, I1–I9,
      I11 — see CHANGELOG "[Unreleased] - beta readiness remediation"
- [x] CI: real-UI voice + realtime E2E (`voice-ui-audio.spec.ts`) and
      real-Postgres integration/ban tests in the pipeline
- [x] CI: the published-image job asserts no baked localhost media URL
      and no pem/key/dump files in `/app`
- [ ] Cut a new RC tag (e.g. `v0.2.0-rc.5`) from the remediation branch;
      re-run the release drill (the rc.4 artifacts predate the fixes)
- [ ] Desktop: verify global PTT (Ctrl+Space) and Ctrl+Shift+M/D on
      Windows, macOS and Linux against an instance
- [ ] Decide: dev-dependency upgrade (vitest 1.6 → 3.x, happy-dom) —
      dev-only advisories, separate PR

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

- [ ] Fresh tagged install (`git clone --branch v0.2.0-rc.4` + install.sh) on a clean VPS
- [ ] Real old → RC update via `lfctl update apply` on a VPS (backup auto-created,
      digest deployed, migrations ran, health green, version state persisted)
- [ ] Forced failure drill on a real VPS: health fails after recreate →
      old containers restored (covered by the CLI regression suite; do it live once)
- [ ] `lfctl backup restore` round-trip on the VPS

The remaining unchecked items need a real VPS (they exercise the
installer + updater against real infrastructure, not the CI sandbox).

## Reporting issues

- Security: use GitHub Security Advisories (private)
- Bugs: open a GitHub issue with reproduction steps
- Feature requests: open a GitHub issue with the `enhancement` label
