#!/usr/bin/env bash
# LF-010-R: render the nginx, LiveKit and coturn configs from their
# templates.
#
# Why a standalone script: install.sh used to `sed -i` the TRACKED config
# files in place. The first run destroyed the LOBBYFORGE_DOMAIN
# placeholder, so a re-run with a different domain silently left nginx
# and LiveKit on the OLD domain while .env.prod carried the new one.
# Templates are the immutable source of truth; the generated files are
# re-rendered from scratch on EVERY run and are git-ignored.
#
# Usage: scripts/render-configs.sh <domain> <turn-secret> [infra-root] [out-root]
#   <domain>      public domain, e.g. lobby.example.com (validated by caller)
#   <turn-secret> shared coturn/LiveKit credential (LF-019); hex, >= 32 chars
#   [infra-root]  where the *.template files live (default: repo's infra/)
#   [out-root]    where the GENERATED files go (default: infra-root). V4-003:
#                 install.sh renders into a staging out-root and activates
#                 atomically only after the certificate succeeds.
set -euo pipefail

DOMAIN="${1:?usage: render-configs.sh <domain> <turn-secret> [infra-root] [out-root]}"
TURN_SECRET="${2:?usage: render-configs.sh <domain> <turn-secret> [infra-root] [out-root]}"
ROOT="${3:-$(cd "$(dirname "$0")/.." && pwd)/infra}"
OUT="${4:-$ROOT}"

# Defense in depth: a domain containing the sed delimiter or slashes
# would corrupt the generated configs. install.sh validates too, but a
# standalone caller must not be able to break the output.
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]*|'')
    echo "render-configs: invalid domain '$DOMAIN'" >&2
    exit 1
    ;;
esac

# The TURN credential is written into two rendered files (coturn static
# user + LiveKit rtc.turn_servers). Anything that isn't plain hex could
# inject newlines/config syntax into either file.
if ! [[ "$TURN_SECRET" =~ ^[0-9a-fA-F]{32,128}$ ]]; then
  echo "render-configs: turn secret must be 32-128 hex characters" >&2
  exit 1
fi

# V5-003: optional public address for coturn behind 1:1 NAT. Unset ->
# coturn auto-detects (correct on VPSes with a public interface).
TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP:-}"
if [ -n "$TURN_EXTERNAL_IP" ]; then
  if ! [[ "$TURN_EXTERNAL_IP" =~ ^[0-9a-fA-F.:]+$ ]]; then
    echo "render-configs: invalid TURN_EXTERNAL_IP '$TURN_EXTERNAL_IP'" >&2
    exit 1
  fi
  EXTERNAL_IP_LINE="external-ip=$TURN_EXTERNAL_IP"
else
  EXTERNAL_IP_LINE="# external-ip: auto-detected (set LOBBYFORGE_TURN_EXTERNAL_IP behind 1:1 NAT)"
fi

render() {
  local template="$1" target="$2"
  if [ ! -f "$template" ]; then
    echo "render-configs: template not found: $template" >&2
    exit 1
  fi
  # NOT sed -i: the template is never mutated; output goes to the
  # generated (git-ignored) target (possibly under a staging root).
  mkdir -p "$(dirname "$target")"
  sed -e "s/LOBBYFORGE_DOMAIN/$DOMAIN/g" \
      -e "s/TURN_CREDENTIAL/$TURN_SECRET/g" \
      -e "s|@TURN_EXTERNAL_IP_LINE@|$EXTERNAL_IP_LINE|" \
    "$template" > "$target"
  echo "rendered $(basename "$target") for $DOMAIN"
}

render "$ROOT/nginx/conf.d/app.conf.template" "$OUT/nginx/conf.d/app.conf"
render "$ROOT/livekit/livekit.yaml.template" "$OUT/livekit/livekit.yaml"
render "$ROOT/turn/turnserver.conf.template" "$OUT/turn/turnserver.conf"
