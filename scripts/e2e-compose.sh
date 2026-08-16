#!/usr/bin/env bash
# LF-023: run Playwright e2e against the REAL compose stack — actual
# Postgres, Redis, LiveKit and the production-built web image.
#
# Usage: bash scripts/e2e-compose.sh
#
# Environment:
#   LF_E2E_BASE_URL     target (default http://localhost:3000)
#   LF_E2E_SETUP_TOKEN  first-run setup token (default below); also
#                       exported as LOBBYFORGE_SETUP_TOKEN for the stack
#
# The stack keeps its volumes between runs; the compose-stack spec is
# idempotent (warm volume -> owner login instead of first-run setup).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LF_E2E_BASE_URL="${LF_E2E_BASE_URL:-http://localhost:3000}"
export LF_E2E_SETUP_TOKEN="${LF_E2E_SETUP_TOKEN:-e2e_setup_token_default_0123456789ab}"
export LOBBYFORGE_SETUP_TOKEN="$LF_E2E_SETUP_TOKEN"

echo ">> Building + starting the stack (postgres, redis, livekit, migrate, web, ws-gateway)…"
docker compose -f "$ROOT/infra/docker/docker-compose.dev.yml" up -d --build --wait

echo ">> Installing Playwright chromium…"
cd "$ROOT/apps/web"
pnpm exec playwright install chromium

echo ">> Running e2e against $LF_E2E_BASE_URL"
pnpm exec playwright test compose-stack.spec.ts

echo ">> Done. Teardown (keeps volumes for warm reruns):"
echo "   docker compose -f $ROOT/infra/docker/docker-compose.dev.yml down"
echo "   add -v to also drop the data volumes (forces fresh first-run setup)"
