#!/usr/bin/env bash
# LF-010-R: render the nginx and LiveKit configs from their templates.
#
# Why a standalone script: install.sh used to `sed -i` the TRACKED config
# files in place. The first run destroyed the LOBBYFORGE_DOMAIN
# placeholder, so a re-run with a different domain silently left nginx
# and LiveKit on the OLD domain while .env.prod carried the new one.
# Templates are the immutable source of truth; the generated files are
# re-rendered from scratch on EVERY run and are git-ignored.
#
# Usage: scripts/render-configs.sh <domain> [infra-root]
#   <domain>     public domain, e.g. lobby.example.com (validated by caller)
#   [infra-root] defaults to the repo's infra/ directory
set -euo pipefail

DOMAIN="${1:?usage: render-configs.sh <domain> [infra-root]}"
ROOT="${2:-$(cd "$(dirname "$0")/.." && pwd)/infra}"

# Defense in depth: a domain containing the sed delimiter or slashes
# would corrupt the generated configs. install.sh validates too, but a
# standalone caller must not be able to break the output.
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]*|'')
    echo "render-configs: invalid domain '$DOMAIN'" >&2
    exit 1
    ;;
esac

render() {
  local template="$1" target="$2"
  if [ ! -f "$template" ]; then
    echo "render-configs: template not found: $template" >&2
    exit 1
  fi
  # NOT sed -i: the template is never mutated; output goes to the
  # generated (git-ignored) target.
  sed "s/LOBBYFORGE_DOMAIN/$DOMAIN/g" "$template" > "$target"
  echo "rendered $(basename "$target") for $DOMAIN"
}

render "$ROOT/nginx/conf.d/app.conf.template" "$ROOT/nginx/conf.d/app.conf"
render "$ROOT/livekit/livekit.yaml.template" "$ROOT/livekit/livekit.yaml"
