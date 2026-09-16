# Beta Release Checklist

Status: Ready for closed beta — 2026-09-16

## Pre-beta verification (ALL COMPLETE)

- [x] 20 security audit rounds remediated
- [x] CI: Ubuntu + Windows verify, Docker build, production compose config
- [x] CI: Production TLS E2E (HTTPS, HTTP→HTTPS redirect, WSS upgrade, CSP nonce + hydration)
- [x] CI: Two-client voice E2E (real WebRTC through LiveKit)
- [x] CI: Destructive backup drill (backup → destroy → restore → verify)
- [x] CI: Real-Postgres migration + channel visibility + ownership integration tests
- [x] Security: CodeQL security-extended, RustSec (Cargo.lock), pnpm audit (prod)
- [x] Security: Trivy CRITICAL+HIGH gate on OUR web image (CI + the exact released digest pre-publish); third-party images gate CRITICAL with HIGH reported (upstream base-layer HIGHs are outside our control — per-image ignores document exceptions)
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

## Release drill — v0.2.0-rc.1 (before any final tag)

The unified `v*` release pipeline is only "tested" after this passes once
end-to-end on GitHub. Notes:

- GitHub `releases/latest` does NOT include prereleases — for RC updater
  tests pass the manifest explicitly:
  `--manifest https://github.com/Juanka-e/LobbyForge/releases/download/v0.2.0-rc.1/release-manifest.json`
- The release fails closed if the GHCR package is not PUBLIC (anonymous
  pull is how every self-host updater fetches the digest). First publish
  may need a one-time manual visibility flip in package settings.

Checklist:

- [ ] RC tag pushed → 19 checks green → release gate passes → GHCR push
- [ ] ghcr.io/juanka-e/lobbyforge package is PUBLIC
- [ ] Clean VPS, NO GitHub credentials: `docker pull ghcr.io/juanka-e/lobbyforge@sha256:<digest>` succeeds
- [ ] Fresh tagged install (`git clone --branch v0.2.0-rc.1` + install.sh) healthy
- [ ] `lfctl update check` against the RC manifest verifies the signature and shows the pinned digest
- [ ] Old install (0.1.x/0.2.0-source) → RC update: backup auto-created, digest deployed, migrations ran, health green, version state persisted
- [ ] Forced failure drill: make `/api/health` fail after recreate → updater restores OLD containers + `.env.prod` (or leaves a working `update rollback` pointer)
- [ ] `lfctl backup restore` round-trip from the pre-update dump into an empty DB
- [ ] Desktop artifacts present for linux/windows/macos with matching single SHA256SUMS.txt

## Reporting issues

- Security: use GitHub Security Advisories (private)
- Bugs: open a GitHub issue with reproduction steps
- Feature requests: open a GitHub issue with the `enhancement` label
