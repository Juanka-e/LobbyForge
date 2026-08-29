#!/usr/bin/env bash
# LF-018: destructive backup drill — prove backup → DESTROY → restore →
# verify against a REAL, throwaway PostgreSQL (never touches any dev or
# production stack; everything lives in one disposable container).
#
# Usage: bash scripts/backup-drill.sh
#
# How it works:
#   1. Disposable postgres:16-alpine on a random host port.
#   2. Repo migrations applied from the host (packages/db migrate).
#   3. Sentinel rows inserted (unique words, timestamped).
#   4. `lfctl backup create` — pg_dump -Fc + SHA-256 (pg tools run
#      inside the container via PATH shims; the DB URL points at the
#      in-container localhost:5432).
#   5. DROP SCHEMA public CASCADE — simulated catastrophic loss.
#   6. `lfctl backup restore` (lfctl refuses non-empty targets, so a
#      successful restore proves the schema was really gone).
#   7. Sentinel + row-count verification; non-zero exit on mismatch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="lf-backup-drill-$$"
WORKDIR="$(mktemp -d)"
PGPASSWORD='drill_pass_change_me'
TOOLS_URL="postgres://postgres:${PGPASSWORD}@localhost:5432/drill"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT
# Diagnose silent set -e exits: name the failing line in the log.
on_err() {
  echo "DRILL FAILED at line $1 (exit $2). Container logs:" >&2
  docker logs "$CONTAINER" --tail 20 >&2 2>&1 || true
}
trap 'on_err $LINENO $?' ERR

step() { printf '\n== %s ==\n' "$1"; }

step "1/8 Disposable PostgreSQL (random host port)"
docker run -d --name "$CONTAINER" \
  -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -e POSTGRES_DB=drill \
  postgres:16-alpine >/dev/null
HOSTPORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
HOST_URL="postgres://postgres:${PGPASSWORD}@127.0.0.1:${HOSTPORT}/drill"
echo "container: $CONTAINER  host port: $HOSTPORT"

# Postgres's entrypoint starts a TEMPORARY server for initdb, accepts
# connections, then SHUTS IT DOWN and starts the real one — a single
# successful pg_isready can hit that transient server (exactly what
# flaked CI: the loop broke on the temp server, the verify line hit the
# shutdown window). Require TWO consecutive successes.
READY=0
for i in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d drill >/dev/null 2>&1; then
    READY=$((READY + 1))
    if [ "$READY" -ge 2 ]; then break; fi
    sleep 1
  else
    READY=0
    sleep 1
  fi
done
if [ "$READY" -lt 2 ]; then
  echo "FAIL: postgres did not become steadily ready" >&2
  docker logs "$CONTAINER" --tail 20 >&2 || true
  exit 1
fi

step "2/8 Apply repo migrations"
if [ ! -f "$ROOT/packages/db/dist/migrate.js" ]; then
  (cd "$ROOT" && pnpm --filter @lobbyforge/db build >/dev/null)
fi
# The migrator resolves drizzle/meta relative to the package cwd.
(cd "$ROOT/packages/db" && DATABASE_URL="$HOST_URL" node dist/migrate.js | tail -3)

step "3/8 Insert sentinel data"
STAMP="$(date +%s)"
docker exec -i "$CONTAINER" psql -U postgres -d drill -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO card_packs (plugin_id, slug, name, language, is_built_in)
VALUES ('hushle', 'drill-$STAMP', 'Drill Pack', 'en', false);
INSERT INTO cards (pack_id, ordinal, payload, difficulty, category)
SELECT cp.id, t.ord, jsonb_build_object('word', t.w, 'forbiddenWords', '[]'::jsonb), 'easy', 'drill'
FROM card_packs cp
CROSS JOIN (VALUES (0,'drill-$STAMP-alpha'),(1,'drill-$STAMP-beta'),(2,'drill-$STAMP-gamma')) AS t(ord, w)
WHERE cp.slug = 'drill-$STAMP';
SQL
COUNT_BEFORE="$(docker exec "$CONTAINER" psql -U postgres -d drill -tAc 'SELECT count(*) FROM cards')"
echo "cards before destroy: $COUNT_BEFORE (expect 3 sentinels + any seeded)"
if [ "$COUNT_BEFORE" -lt 3 ]; then
  echo "FAIL: sentinel insert did not produce 3 rows" >&2
  exit 1
fi

step "4/8 Backup (pg_dump -Fc + SHA-256 via lfctl)"
# LFCTL_PG_CONTAINER: lfctl runs the pg tools inside the drill container
# via docker exec — also the documented operator mode for hosts without
# a local postgres client install.
export LFCTL_PG_CONTAINER="$CONTAINER"
BACKUP_JSON="$(node "$ROOT/scripts/lfctl.mjs" backup create \
  --out "$WORKDIR" --database-url "$TOOLS_URL" --json)"
echo "$BACKUP_JSON"
BACKUP_FILE="$(printf '%s' "$BACKUP_JSON" | sed -n 's/.*"file"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "FAIL: backup file not found" >&2
  exit 1
fi

step "5/8 DESTROY the schema (simulated catastrophic loss)"
docker exec "$CONTAINER" psql -U postgres -d drill -q \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' \
  -c 'DROP SCHEMA IF EXISTS drizzle CASCADE;'
COUNT_GONE="$(docker exec "$CONTAINER" psql -U postgres -d drill -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")"
echo "user tables after destroy: $COUNT_GONE (expect 0)"

step "6/8 Restore from backup"
node "$ROOT/scripts/lfctl.mjs" backup restore \
  --file "$BACKUP_FILE" --to "$TOOLS_URL" --json

step "7/8 Fail-closed checks (V5-004)"
# Refusal must happen for the RIGHT reason - assert the message, not just
# failure (the target may be non-empty here, which also refuses).
assert_refused() {
  local fragment="$1"; shift 2
  local out
  out="$(node "$ROOT/scripts/lfctl.mjs" backup restore "$@" --json 2>&1 || true)"
  if printf '%s' "$out" | grep -q '"ok": *true'; then
    echo "FAIL: restore unexpectedly succeeded" >&2
    exit 1
  fi
  if ! printf '%s' "$out" | grep -qi "$fragment"; then
    echo "FAIL: refusal reason mismatch - expected [$fragment] in: $out" >&2
    exit 1
  fi
}
# (a) A corrupted dump is refused specifically for the checksum mismatch.
CORRUPT="$WORKDIR/corrupt.dump"
head -c 200 "$BACKUP_FILE" > "$CORRUPT"
cp "${BACKUP_FILE}.json" "${CORRUPT}.json"
assert_refused 'SHA-256 mismatch' -- --file "$CORRUPT" --to "$TOOLS_URL"
echo "corrupt dump refused (checksum mismatch): yes"
# (b) A missing sidecar is refused by the fail-closed path itself.
NOSIDECAR="$WORKDIR/nosidecar.dump"
cp "$BACKUP_FILE" "$NOSIDECAR"
assert_refused 'sidecar' -- --file "$NOSIDECAR" --to "$TOOLS_URL"
echo "missing sidecar refused (fail-closed): yes"

step "8/8 Verify restored data"
COUNT_AFTER="$(docker exec "$CONTAINER" psql -U postgres -d drill -tAc 'SELECT count(*) FROM cards')"
SENTINELS="$(docker exec "$CONTAINER" psql -U postgres -d drill -tAc \
  "SELECT count(*) FROM cards WHERE category='drill' AND payload->>'word' LIKE 'drill-$STAMP-%'")"
echo "cards after restore: $COUNT_AFTER (before: $COUNT_BEFORE)"
echo "sentinel rows restored: $SENTINELS (expect 3)"

if [ "$COUNT_AFTER" != "$COUNT_BEFORE" ] || [ "$SENTINELS" != "3" ]; then
  echo "FAIL: restored data does not match" >&2
  exit 1
fi

printf '\nPASS: backup → destroy → restore → verify round-tripped %s cards incl. 3 sentinels; corrupt/unverified restores refused.\n' "$COUNT_AFTER"
