#!/bin/sh
# coturn certificate watcher (OPS-001).
#
# V5-002: coturn loads its TLS certificate at process start and has no
# reliable reload — when certbot renews, this watcher terminates
# turnserver so `restart: unless-stopped` brings it back with the fresh
# certificate (a seconds-long TURN blip once per renewal window).
#
# This script runs as the CONTAINER COMMAND in a tight supervision loop:
# the watcher backgrounds itself, then `exec turnserver` replaces the
# shell so signals reach turnserver directly. Written as a SEPARATE
# POSIX-sh file (mounted read-only) — the previous inline multi-line
# command collided with the image entrypoint's eval semantics and put
# the loop into a restart cycle.
set -eu

CERT_DIR="${CERT_DIR:-/etc/letsencrypt/live}"
SUM=/tmp/.certsum
SUM_NEW=/tmp/.certsum.new

md5_files() {
    # md5sum over every fullchain.pem under the live dir (dirs may come
    # and go); absent dir -> empty output.
    find "$CERT_DIR" -name fullchain.pem -type f 2>/dev/null | sort | xargs -r md5sum
    true
}

(
    md5_files > "$SUM" 2>/dev/null || : > "$SUM"
    while :; do
        sleep 300
        md5_files > "$SUM_NEW" 2>/dev/null || : > "$SUM_NEW"
        if ! cmp -s "$SUM_NEW" "$SUM"; then
            echo "[turn-cert-watcher] certificate changed — restarting coturn"
            # Kill the shell's own process group (turnserver included) —
            # docker restarts the container fresh.
            kill -TERM "$(cat /proc/self/stat 2>/dev/null | awk '{print $1}')" 2>/dev/null || kill -TERM "$$"
            exit 0
        fi
    done
) &

exec turnserver -c /etc/coturn/turnserver.conf
