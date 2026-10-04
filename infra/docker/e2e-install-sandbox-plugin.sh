#!/usr/bin/env bash
# E2E-only: install examples/plugins/sandbox-buzzer into the e2e stack's
# shared plugin volume the way the marketplace installer lays it out
# (apps/web/lib/plugin-install-layout.ts / plugin-installer.ts), then
# restart web so it loads it (dynamic plugins are only loaded at boot).
#
# The real install route only takes an approved https catalog entry and
# refuses local/private URLs (SSRF guard), so a local test bundle goes in
# by hand:
#   1. pack the bundle exactly as a publisher would (pack.mjs → .tgz);
#   2. extract it into <installDir>/sandbox-buzzer/<version>/ as the `node`
#      user (tar --no-same-owner --no-same-permissions, like the installer);
#   3. compute the bundle digest with the worker's own computeBundleDigest
#      (per-file sha256 lines, sorted by path) and write active.json
#      ({version, digest, activatedAt}, mode 0600);
#   4. restart web (the worker must already be healthy).
#
# Requires the stack started with docker-compose.e2e-plugins.yml.
set -euo pipefail
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Git Bash on Windows: node/docker are Windows programs and MSYS_NO_PATHCONV
# stops the /d/... → D:/... translation, so hand them a mixed-style path.
if command -v cygpath >/dev/null 2>&1; then ROOT="$(cygpath -m "$ROOT")"; fi
WEB=lobbyforge-e2e-web
WORKER=lobbyforge-e2e-plugin-worker
PLUGIN=sandbox-buzzer
INSTALL=/app/plugins/installed

docker inspect "$WORKER" --format '{{.State.Health.Status}}' | grep -q healthy \
  || { echo "plugin worker is not healthy — start the stack with docker-compose.e2e-plugins.yml" >&2; exit 1; }

node "$ROOT/examples/plugins/$PLUGIN/pack.mjs" "$ROOT/examples/plugins/$PLUGIN" --out "$ROOT/examples/plugins/$PLUGIN/dist" >/dev/null
TGZ=$(ls "$ROOT/examples/plugins/$PLUGIN/dist/"*.tgz | head -1)
VERSION=$(node -e "console.log(require('$ROOT/examples/plugins/$PLUGIN/manifest.json').version)")
docker cp "$TGZ" "$WEB:/tmp/$PLUGIN.tgz"

docker exec -u node -e PLUGIN="$PLUGIN" -e VERSION="$VERSION" -e INSTALL="$INSTALL" "$WEB" sh -ec '
  dir="$INSTALL/$PLUGIN/$VERSION"
  rm -rf "$INSTALL/$PLUGIN"
  mkdir -p "$dir"
  tar -xzf "/tmp/$PLUGIN.tgz" -C "$dir" --no-same-owner --no-same-permissions
  digest=$(node -e "import(\"/app/apps/plugin-worker/dist/bundle.js\").then(async (m) => console.log(await m.computeBundleDigest(process.argv[1])))" "$dir")
  printf "{\"version\":\"%s\",\"digest\":\"%s\",\"activatedAt\":\"%s\"}\n" "$VERSION" "$digest" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$INSTALL/$PLUGIN/active.json.tmp"
  chmod 600 "$INSTALL/$PLUGIN/active.json.tmp"
  mv "$INSTALL/$PLUGIN/active.json.tmp" "$INSTALL/$PLUGIN/active.json"
  echo "installed $PLUGIN@$VERSION digest=$digest"
  ls -la "$dir" "$dir/ui"
'
docker exec -u 0 "$WEB" rm -f "/tmp/$PLUGIN.tgz"

docker restart "$WEB" >/dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect "$WEB" --format '{{.State.Health.Status}}')" = healthy ] && break
  sleep 2
done
docker logs --since 2m "$WEB" 2>&1 | grep -i "plugin" | tail -5 || true
echo "web: $(docker inspect "$WEB" --format '{{.State.Health.Status}}')"
