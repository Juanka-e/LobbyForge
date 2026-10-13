#!/usr/bin/env bash
# E2E-only: prepare the publisher stand-in for docker-compose.e2e-bundles.yml.
#
# Writes into infra/docker/.e2e-bundles (gitignored; another folder with
# LF_E2E_BUNDLE_DIR, an absolute path):
#   tls/ca.pem, tls/ca.key        a throw-away CA (the web container trusts ca.pem)
#   tls/server.pem, server.key    its certificate for bundles.lobbyforge-e2e.test
#   server.mjs                    a tiny HTTPS file server on :8443 for files/*.tgz
#   files/                        where the specs drop the bundles they publish
#
# Idempotent: an existing CA and certificate are kept, so a running web
# container keeps trusting them. Needs openssl (Git Bash ships it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${LF_E2E_BUNDLE_DIR:-$ROOT/infra/docker/.e2e-bundles}"
HOST=bundles.lobbyforge-e2e.test
# Git Bash: keep openssl's -subj from being rewritten into a Windows path,
# and hand it a mixed-style (D:/...) path instead of /d/... for the files.
export MSYS_NO_PATHCONV=1
if command -v cygpath >/dev/null 2>&1; then DIR="$(cygpath -m "$DIR")"; fi
mkdir -p "$DIR/tls" "$DIR/files"

if [ ! -s "$DIR/tls/ca.pem" ] || [ ! -s "$DIR/tls/server.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 \
    -subj "/CN=LobbyForge e2e throw-away CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$DIR/tls/ca.key" -out "$DIR/tls/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=$HOST" \
    -keyout "$DIR/tls/server.key" -out "$DIR/tls/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' "$HOST" > "$DIR/tls/server.ext"
  openssl x509 -req -sha256 -days 30 -in "$DIR/tls/server.csr" \
    -CA "$DIR/tls/ca.pem" -CAkey "$DIR/tls/ca.key" -CAcreateserial \
    -extfile "$DIR/tls/server.ext" -out "$DIR/tls/server.pem" 2>/dev/null
  rm -f "$DIR/tls/server.csr" "$DIR/tls/server.ext"
fi

cat > "$DIR/server.mjs" <<'EOF'
// The publisher stand-in: GET /<name>.tgz from /srv/files over HTTPS, nothing else.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:https';

const server = createServer(
  { key: readFileSync('/srv/tls/server.key'), cert: readFileSync('/srv/tls/server.pem') },
  (req, res) => {
    const name = new URL(req.url ?? '/', 'https://bundles.invalid').pathname.slice(1);
    if (req.method !== 'GET' || !/^[a-z0-9][a-z0-9._-]*\.tgz$/i.test(name)) {
      res.writeHead(404).end();
      return;
    }
    const path = `/srv/files/${name}`;
    let size;
    try {
      size = statSync(path).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    console.log(`GET /${name} ${size}`);
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': size });
    createReadStream(path).pipe(res);
  }
);
server.listen(8443, '0.0.0.0', () => console.log('bundle host on :8443'));
EOF

echo "bundle host files ready in $DIR (host $HOST, CA $DIR/tls/ca.pem)"
