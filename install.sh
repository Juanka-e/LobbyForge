#!/usr/bin/env bash
set -euo pipefail

# LobbyForge installer.
#
# Usage (clone + run — the script needs the repo's compose files,
# templates and scripts next to it, so curl | bash does NOT work):
#   git clone https://github.com/Juanka-e/LobbyForge.git
#   cd LobbyForge && bash install.sh
#
# Optional env:
#   LOBBYFORGE_TURN_EXTERNAL_IP   public IP for coturn behind 1:1 NAT
#                                 (unset = auto-detect)
#
# This script:
#   1. Checks prerequisites (Docker, Docker Compose, curl, openssl).
#   2. Prompts for domain name and generates secrets.
#   3. Provisions a Let's Encrypt certificate via certbot.
#   4. Starts the full production stack via docker-compose.prod.yml.
#   5. Runs the Doctor health check.

set -e
umask 077  # Secrets written by this script should only be readable by the owner.

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     LobbyForge Installer                  ║${NC}"
echo -e "${BOLD}║     Self-hosted voice community platform   ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Prerequisites ──────────────────────────────────────────────
echo -e "${BOLD}Checking prerequisites...${NC}"

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo -e "${RED}✗ $1 is not installed. Please install it first.${NC}"
    echo "   $2"
    exit 1
  fi
}

check_cmd docker "Install Docker: https://docs.docker.com/engine/install/"
check_cmd docker "Install Docker Compose (included with Docker Desktop or 'docker-compose-plugin')"
check_cmd curl "Install curl (usually preinstalled)"
check_cmd openssl "Install openssl (usually preinstalled)"

# Verify docker compose subcommand
if ! docker compose version &>/dev/null; then
  echo -e "${RED}✗ 'docker compose' plugin is not available. Install docker-compose-plugin.${NC}"
  exit 1
fi

echo -e "${GREEN}✓ All prerequisites found.${NC}"
echo ""

# ── 2. Configuration ──────────────────────────────────────────────
echo -e "${BOLD}Configuration${NC}"
echo ""

# Find the repo root (where this script lives or CWD).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/infra/docker/docker-compose.prod.yml"
ENV_FILE="$SCRIPT_DIR/.env.prod"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo -e "${RED}✗ docker-compose.prod.yml not found at $COMPOSE_FILE${NC}"
  echo "   Make sure you're running this from the repo root."
  exit 1
fi

# Domain (validated — used in sed and nginx config)
read -rp "$(echo -e ${BOLD}'Enter your domain (e.g. lobby.example.com): '${NC})" DOMAIN
if [ -z "$DOMAIN" ]; then
  echo -e "${RED}✗ Domain is required for HTTPS/WebRTC.${NC}"
  exit 1
fi
# LF-010/OPS-005: full DNS label validation — each label 1-63 chars,
# alphanumeric first/last, letters/digits/hyphens only, total FQDN <= 253.
if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]] || [ ${#DOMAIN} -gt 253 ]; then
  echo -e "${RED}✗ Invalid domain "$DOMAIN" — each label must be 1-63 chars, alphanumeric start/end, hyphens inside only (max 253 total).${NC}"
  exit 1
fi

# Instance name
read -rp "$(echo -e ${BOLD}'Community name [LobbyForge Community]: '${NC})" INSTANCE_NAME
INSTANCE_NAME="${INSTANCE_NAME:-LobbyForge Community}"

# Deployment mode
read -rp "$(echo -e ${BOLD}'Official hub instance? (enables discovery/marketplace) [y/N]: '${NC})" IS_OFFICIAL
if [[ "$IS_OFFICIAL" =~ ^[Yy]$ ]]; then
  DEPLOYMENT_MODE="official"
else
  DEPLOYMENT_MODE="self_host"
fi

# Generate secrets. On a RE-RUN, values already present in .env.prod are
# reused — rotating every credential each run would invalidate existing
# sessions, admin tokens and TURN credentials for no benefit.
reuse_env() {
  local key="$1" generated="$2"
  if [ -f "$ENV_FILE" ]; then
    local prev
    prev=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)
    if [ -n "$prev" ]; then
      echo "$prev"
      return
    fi
  fi
  echo "$generated"
}

echo ""
echo -e "${BOLD}Generating secure secrets...${NC}"
SESSION_SECRET=$(reuse_env LOBBYFORGE_SESSION_SECRET "$(openssl rand -hex 32)")
ADMIN_TOKEN=$(reuse_env LOBBYFORGE_ADMIN_TOKEN "$(openssl rand -hex 32)")
SETUP_TOKEN=$(reuse_env LOBBYFORGE_SETUP_TOKEN "$(openssl rand -hex 32)")
PG_PASSWORD=$(reuse_env POSTGRES_PASSWORD "$(openssl rand -hex 16)")
REDIS_PASSWORD=$(reuse_env REDIS_PASSWORD "$(openssl rand -hex 16)")
LK_API_KEY=$(reuse_env LIVEKIT_API_KEY "devkey_$(openssl rand -hex 8)")
LK_API_SECRET=$(reuse_env LIVEKIT_API_SECRET "$(openssl rand -hex 32)")
# LF-019: shared coturn <-> LiveKit TURN credential (hex — render-configs
# validates the shape before writing it into both configs).
TURN_SECRET=$(reuse_env LOBBYFORGE_TURN_SECRET "$(openssl rand -hex 32)")
# V5-003: coturn public address behind 1:1 NAT. Reused from an existing
# .env.prod; export LOBBYFORGE_TURN_EXTERNAL_IP on the first run to set
# it. Empty = coturn auto-detects (correct for public-interface VPSes).
TURN_EXTERNAL_IP="${LOBBYFORGE_TURN_EXTERNAL_IP:-$(reuse_env LOBBYFORGE_TURN_EXTERNAL_IP '')}"

echo -e "${GREEN}✓ Secrets generated.${NC}"
echo ""

# ── 2b. Preflight: NEVER mutate a live installation (V4-003) ──────
# The old order wrote .env.prod + configs for the NEW domain and THEN
# failed at certbot (port 80 held by the running stack) — leaving the
# host one container-restart away from loading a certificate that does
# not exist. All writes below go to a STAGING directory and are
# activated atomically only after the certificate succeeds.
STACK_RUNNING=false
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^lobbyforge-nginx$'; then
  STACK_RUNNING=true
fi
EXISTING_DOMAIN=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_DOMAIN=$(grep -E '^NEXT_PUBLIC_BASE_URL=' "$ENV_FILE" | tail -1 | sed 's|^NEXT_PUBLIC_BASE_URL=https://||' | tr -d '
' || true)
fi

if [ "$STACK_RUNNING" = true ]; then
  if [ -n "$EXISTING_DOMAIN" ] && [ "$EXISTING_DOMAIN" = "$DOMAIN" ]; then
    echo -e "${GREEN}✓ Stack already running on $DOMAIN.${NC}"
    echo ""
    echo -e "${BOLD}What do you want to do?${NC}"
    echo "  1) Update to the code in this checkout (build new images, recreate services, run migrations)"
    echo "  2) Renew TLS certificates only"
    echo "  3) Nothing — exit"
    echo ""
    read -rp "$(echo -e ${BOLD}'Choice [1/2/3]: '${NC})" STACK_ACTION
    STACK_ACTION="${STACK_ACTION:-3}"
    case "$STACK_ACTION" in
      1)
        echo -e "${BOLD}Updating (this rebuilds images + recreates services; brief downtime per service)...${NC}"
        docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build
        echo -e "${GREEN}✓ Update applied.${NC}"
        exit 0
        ;;
      2)
        docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec certbot certbot renew
        echo "(nginx auto-reloads within ~60s of a certificate change; no restart needed.)"
        exit 0
        ;;
      *)
        echo "No changes made."
        exit 0
        ;;
    esac
  fi
  echo -e "${RED}✗ The stack is RUNNING (lobbyforge-nginx) but this run targets '$DOMAIN'${NC}"
  echo "   while the existing installation targets '${EXISTING_DOMAIN:-<unknown>}'."
  echo "   Switching domains rewrites env/configs and needs a new certificate —"
  echo "   stop the stack first:"
  echo "     docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down"
  echo "   Nothing has been modified."
  exit 1
fi

# ── 3. Stage .env.prod + rendered configs (activated in step 6) ────
STAGE_DIR="$(mktemp -d "$SCRIPT_DIR/.install-staging.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT
echo -e "${BOLD}Staging .env.prod + configs (activated after the certificate succeeds)...${NC}"

cat > "$STAGE_DIR/.env.prod" << EOF
# LobbyForge production environment — generated by install.sh
# Domain: $DOMAIN

# PostgreSQL
POSTGRES_DB=lobbyforge
POSTGRES_USER=lobbyforge
POSTGRES_PASSWORD=$PG_PASSWORD
DATABASE_URL=postgres://lobbyforge:$PG_PASSWORD@postgres:5432/lobbyforge

# Redis
REDIS_PASSWORD=$REDIS_PASSWORD

# LiveKit
LIVEKIT_API_KEY=$LK_API_KEY
LIVEKIT_API_SECRET=$LK_API_SECRET
LIVEKIT_URL=http://livekit:7880
NEXT_PUBLIC_LIVEKIT_URL=wss://$DOMAIN/livekit
NEXT_PUBLIC_WS_URL=wss://$DOMAIN/ws

# Security
LOBBYFORGE_SESSION_SECRET=$SESSION_SECRET
LOBBYFORGE_ADMIN_TOKEN=$ADMIN_TOKEN
LOBBYFORGE_SETUP_TOKEN=$SETUP_TOKEN
LOBBYFORGE_TURN_SECRET=$TURN_SECRET
LOBBYFORGE_TURN_EXTERNAL_IP=$TURN_EXTERNAL_IP

# Product
LOBBYFORGE_DEPLOYMENT_MODE=$DEPLOYMENT_MODE
LOBBYFORGE_INSTANCE_NAME=$INSTANCE_NAME
LOBBYFORGE_TRUSTED_PROXY=x-forwarded-for
NEXT_PUBLIC_BASE_URL=https://$DOMAIN

# Node
NODE_ENV=production
EOF

echo -e "${GREEN}✓ .env.prod staged. Save these credentials:${NC}"
echo "   Admin token:     $ADMIN_TOKEN"
echo "   Setup token:     $SETUP_TOKEN (remove after first-run setup)"
echo ""

# ── 4. Render nginx + LiveKit configs (LF-010-R) ──────────────────
# The tracked *.template files are the immutable source of truth; the
# generated configs are re-rendered from scratch on EVERY run. This is
# what makes a re-run with a different domain correct: the old in-place
# `sed -i` destroyed the placeholder on first run and left nginx/LiveKit
# stuck on the previous domain.
echo -e "${BOLD}Rendering nginx + LiveKit + TURN configs (LF-010-R)...${NC}"
if TURN_EXTERNAL_IP="$TURN_EXTERNAL_IP" bash "$SCRIPT_DIR/scripts/render-configs.sh" "$DOMAIN" "$TURN_SECRET" "$SCRIPT_DIR/infra" "$STAGE_DIR/infra"; then
  echo -e "${GREEN}✓ Nginx, LiveKit and coturn TURN configs staged.${NC}"
else
  echo -e "${RED}✗ Failed to render configs from templates.${NC}"
  exit 1
fi
echo ""

# ── 5. Provision SSL certificate ──────────────────────────────────
echo -e "${BOLD}Provisioning SSL certificate via Let's Encrypt...${NC}"
echo -e "${YELLOW}This requires port 80 to be open and DNS to point here.${NC}"
read -rp "$(echo -e ${BOLD}'Proceed with certbot now? [Y/n]: '${NC})" DO_CERTBOT
DO_CERTBOT="${DO_CERTBOT:-Y}"

# LF-010: Initialize explicitly to avoid unbound variable with set -u.
CERT_FAILED=false

if [[ "$DO_CERTBOT" =~ ^[Yy]$ ]]; then
  # Preflight (step 2b) already refused to continue with a running
  # stack, so port 80 is expected free for the standalone challenge.
  if docker run --rm \
    -p 80:80 \
    -v "$SCRIPT_DIR/infra/certbot/conf:/etc/letsencrypt" \
    certbot/certbot:v2.11.0 certonly --standalone \
    -d "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --no-eff-email; then
    if [ -d "$SCRIPT_DIR/infra/certbot/conf/live/$DOMAIN" ]; then
      echo -e "${GREEN}✓ Certificate provisioned for $DOMAIN${NC}"
    else
      echo -e "${RED}✗ Certificate directory not found — certbot may have failed silently.${NC}"
      CERT_FAILED=true
    fi
  else
    echo -e "${RED}✗ Certbot FAILED.${NC}"
    echo "   Common causes: DNS not pointing here yet, port 80 blocked, rate limit."
    CERT_FAILED=true
  fi
else
  echo -e "${YELLOW}Skipping certbot.${NC}"
  CERT_FAILED=true
fi

# P0-D: Fail-closed — WebRTC requires HTTPS (secure context). Without a
# certificate the production Nginx config cannot start (it loads cert files
# unconditionally), so aborting is the only safe action.
if [ "$CERT_FAILED" = true ]; then
  echo ""
  echo -e "${RED}✗ TLS certificate is not available. Aborting — WebRTC voice requires HTTPS.${NC}"
  echo "   Existing .env.prod and rendered configs were NOT modified (all writes were staged)."
  echo "   Fix the issue above and re-run: bash install.sh"
  exit 1
fi
echo ""

# ── 6. Activate the staged installation (V4-003) ─────────────────
# The certificate exists, so the new domain is fully provisioned: move
# every staged file into place (same-filesystem renames) and only then
# start the stack. Any earlier failure left the live files untouched.
echo -e "${BOLD}Activating configuration for $DOMAIN...${NC}"
mv "$STAGE_DIR/.env.prod" "$ENV_FILE"
mv "$STAGE_DIR/infra/nginx/conf.d/app.conf" "$SCRIPT_DIR/infra/nginx/conf.d/app.conf"
mv "$STAGE_DIR/infra/livekit/livekit.yaml" "$SCRIPT_DIR/infra/livekit/livekit.yaml"
mv "$STAGE_DIR/infra/turn/turnserver.conf" "$SCRIPT_DIR/infra/turn/turnserver.conf"
echo -e "${GREEN}✓ Activated .env.prod, nginx, LiveKit and TURN configs.${NC}"
echo ""

# ── 7. Start the stack ────────────────────────────────────────────
echo -e "${BOLD}Starting LobbyForge...${NC}"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

echo ""
echo -e "${GREEN}${BOLD}✓ LobbyForge is starting!${NC}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Visit https://$DOMAIN to run the first-run setup wizard."
echo "  2. Use the Setup Token when prompted: $SETUP_TOKEN"
echo "  3. After setup, remove the Setup Token from .env.prod."
echo "  4. Visit Admin → Doctor & Health to verify everything is healthy."
echo ""
echo -e "${BOLD}Important credentials (save these!):${NC}"
echo "  Admin Token:  $ADMIN_TOKEN"
echo "  Setup Token:  $SETUP_TOKEN (remove after setup!)"
echo ""
echo -e "${BOLD}Firewall ports required for voice (LF-019):${NC}"
echo "  80/tcp + 443/tcp          web (nginx + HTTPS)"
echo "  3478/tcp + 3478/udp       TURN (coturn)"
echo "  5349/tcp + 5349/udp       TURN/TLS (UDP-blocked networks)"
echo "  49160-49200/udp           TURN relay range"
echo "  50000-60000/udp           LiveKit RTC media"
echo ""
echo "  Example (ufw): ufw allow 3478/tcp; ufw allow 3478/udp; ufw allow 5349/tcp; ufw allow 5349/udp; ufw allow 49160:49200/udp; ufw allow 50000:60000/udp"
echo ""
echo -e "${BOLD}To stop:${NC}  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down"
echo -e "${BOLD}To update:${NC}  git pull && bash install.sh  (a running same-domain stack offers: update / renew / exit)"
