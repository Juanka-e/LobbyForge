# Voice networking: TURN fallback (LF-019)

LobbyForge voice runs on **LiveKit, an SFU (Selective Forwarding Unit)**
— every client's media ALWAYS flows through the LiveKit server, which
receives N upstream streams and redistributes ~N×(N−1) downstream
copies. There is no client-to-client P2P mesh; server bandwidth is
consumed even without TURN. TURN is an *additional* relay for the
minority whose direct client→SFU ICE path fails (symmetric NATs, mobile
carriers, corporate networks that block UDP). The production stack ships
a standalone **coturn** container for exactly that case.

**Capacity implication:** in an N-person room where everyone listens to
everyone, expect roughly N uplink + N×(N−1) downlink audio streams on
the SFU. Screen-share/video multiplies this. Measure with real devices
before opening a public server (LF-028).

## How the pieces fit

```
client ── ICE: client-to-SFU direct ──► LiveKit SFU (udp 50000-60000)
   │        (all media relays THROUGH the SFU either way)
   │
   └── direct path fails ──► coturn TURN (3478, relay 49160-49200/udp)
                                        ▲
                       The web app mints a per-user, time-limited TURN
                       credential with each LiveKit token (VOICE-001) and
                       the client applies it via rtcConfig.iceServers.
```

- `infra/turn/turnserver.conf.template` — coturn config in REST-auth
  mode (`use-auth-secret` + `static-auth-secret`); rendered per install
  with your domain + secret (git-ignored output).
- `apps/web/lib/turn-credentials.ts` — derives the coturn REST-auth
  credential pair: `username = ${unixExpiry}:${userId}`,
  `credential = base64(HMAC-SHA1(secret, username))`. The token
  endpoint (`/api/livekit/token`) ships one alongside every LiveKit
  token (1h, matching the token TTL).
- `infra/livekit/livekit.yaml.template` — NO `turn_servers` entries:
  LiveKit's config only accepts a STATIC credential, which used to hand
  every community member one permanent relay credential. Do not re-add
  it.
- `infra/docker/docker-compose.prod.yml` — the `turn` service
  (`coturn/coturn:4.17.2`, pinned), host networking so the UDP relay
  range binds directly.
- `scripts/render-configs.sh` — renders the configs; the secret is
  validated as 32-128 hex chars so it can never inject config syntax.

LiveKit's built-in `turn:` block is intentionally NOT used — it
provisions its own certificates and would conflict with the stack's
certbot. The standalone coturn shares the Let's Encrypt certificate
via the certbot volume.

`install.sh` generates `LOBBYFORGE_TURN_SECRET` once, stores it in
`.env.prod`, and re-uses it on re-runs (secret rotation per re-run would
break issued TURN credentials for no benefit).

## Firewall checklist

| Port | Protocol | Purpose |
|---|---|---|
| 80, 443 | tcp | web (nginx, HTTPS, WSS signaling) |
| 7881 | tcp | LiveKit ICE/TCP |
| ~~7880~~ | — | NOT public: LiveKit HTTP signaling is nginx-proxied at `wss://<domain>/livekit` (V5-005) |
| 3478 | tcp + udp | TURN listening |
| 5349 | tcp + udp | TURN/TLS (UDP-blocked networks) |
| 49160-49200 | udp | TURN relay range |
| 50000-60000 | udp | LiveKit RTC media |

Example (ufw):

```bash
ufw allow 80/tcp; ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 3478/tcp; ufw allow 3478/udp
ufw allow 5349/tcp; ufw allow 5349/udp
ufw allow 49160:49200/udp
ufw allow 50000:60000/udp
```

Behind 1:1 NAT (cloud VM with a private interface), uncomment and set
`external-ip=` in the rendered `infra/turn/turnserver.conf`.

## Manual network test matrix

Automated CI cannot cover real-world NAT variety; run this matrix after
deploying. In each environment, join a voice room from two clients and
confirm bidirectional audio, then check the LiveKit participant
connection quality in the room UI.

| # | Client network | Expected path | Notes |
|---|---|---|---|
| 1 | Home fiber, no firewall | direct / STUN | baseline |
| 2 | Same LAN, two devices | direct (host candidates) | |
| 3 | Mobile LTE/5G | STUN, occasionally TURN | carrier CGNAT |
| 4 | Corporate network w/ UDP blocked | TURN/TCP (5349 or 3478/tcp) | verify audio still flows |
| 5 | Symmetric NAT (e.g. some hotel Wi-Fi) | TURN/UDP relay | hardest case |
| 6 | VPN exit node | STUN via VPN egress | |

Quick relay smoke checks from a laptop:

```bash
# Derive a REST-auth credential with the stack secret, then allocate on
# 3478/udp (expect "Allocate" success in coturn logs). coturn has NO
# static user anymore — a raw -u/-w pair cannot be used directly.
EXP=$(( $(date +%s) + 300 )); USER="$EXP:smoketest"
PASS=$(printf '%s' "$USER" | openssl dgst -sha1 -hmac "$LOBBYFORGE_TURN_SECRET" -binary | base64)
turnutils_uclient -u "$USER" -w "$PASS" -p 3478 -v your.domain
# Listening ports are up
nc -vz your.domain 3478 && nc -vz your.domain 5349
```

If case 4/5 fails: check `docker logs lobbyforge-turn`, confirm the
firewall range above, and verify the token endpoint returns
`iceServers` (the client only falls back to coturn when it carries
them — udp 3478, tcp 3478, tls 5349).

## Certificate lifecycle (V5-002/V5-003)

- **nginx** watches the fullchain fingerprint and gracefully reloads on
  change (config-tested).
- **coturn** cannot reload its TLS certificate in place — its watcher
  detects the renewal and restarts the process (a seconds-long TURN
  blip once per renewal window).
- Behind 1:1 NAT, set `LOBBYFORGE_TURN_EXTERNAL_IP` (exported for
  install.sh on first run; stored in `.env.prod` and reused on re-runs)
  — it renders as coturn `external-ip`.
- Relay targets in private/CGNAT space (10/8, 172.16/12, 192.168/16,
  100.64/10) are denied — coturn runs in the host network namespace and
  a credential holder must not pivot into the Docker/VPC network.

## Scope limits — read before promising corporate-network support

- **TURN/TLS on 5349** is advertised to clients and covers networks that
  block plain UDP/TCP but allow arbitrary outbound TLS ports.
- **Networks that ONLY allow outbound 443/tcp** are NOT covered by this
  stack: nginx already terminates 443 on this host, so TURN/TLS cannot
  also bind there. Covering that case needs extra design — a second
  IP/domain for TURN, or L4 routing that splits 443 traffic between
  nginx and coturn. Do not claim "works behind any corporate firewall"
  until that exists.
- The coturn healthcheck proves the 3478 listener is up; a real TURN
  allocation smoke test (credentials + egress) is the manual
  `turnutils_uclient` step above.
- ~~V4-007 (known debt): all clients share one static TURN credential.~~
  FIXED (VOICE-001): coturn runs in REST-auth mode; every voice client
  receives a per-user credential that expires with its LiveKit token,
  and coturn's `user-quota` counts allocations per user again.
