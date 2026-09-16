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
- [x] Security: Trivy CRITICAL+HIGH on web image + all third-party images (per-image ignores)
- [x] Security: Branch protection with 16+ required checks, force-push disabled
- [x] Supply chain: All Docker images digest-pinned (@sha256), Dependabot docker-compose
- [x] Supply chain: Dockerfile base image digest-pinned (node:22-bookworm-slim)
- [x] Supply chain: Plugin artifact hash pinning (review hash'ler, install doğrular)
- [x] Desktop: Native state binding (session swap closed), GETDEL handoff, deep-link gate
- [x] Registry: Account-bound challenge + domain proof + SSRF-safe fetch + key rotation
- [x] Realtime: WS event-driven invalidation + 30s periodic reauth + SSE instant abort
- [x] Authorization: Centralized membership+visibility gates, moderation hierarchy
- [x] Updates: Safety gates (available/supported/signature/major) + strict backup + build + health check
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

# Updates — every GitHub release publishes a release-manifest.json asset
node scripts/lfctl.mjs update check \
  --manifest https://github.com/Juanka-e/LobbyForge/releases/latest/download/release-manifest.json
node scripts/lfctl.mjs update plan    # review the plan
node scripts/lfctl.mjs update apply --yes  # execute (verified backup + safety gates required)
# Trust hardening: pin the release public key (committed in the repo) —
# a client with a pinned key fails closed on unsigned/tampered manifests:
#   --public-key infra/update/release-public.pem
```

## What to test in beta

1. **Voice**: Join a room with 2+ clients (browser + desktop), test mic/camera/screen share
2. **Chat**: Text channels, DMs, typing indicators, message history
3. **Plugin games**: Start Hushle in a voice room, play a round
4. **Discovery**: Register on the official directory, heartbeat, moderate
5. **Self-host**: Install, configure, update, backup + restore
6. **Desktop**: Connect to instance, login handoff, global push-to-talk

## Reporting issues

- Security: use GitHub Security Advisories (private)
- Bugs: open a GitHub issue with reproduction steps
- Feature requests: open a GitHub issue with the `enhancement` label
