# Voice networking: TURN fallback (LF-019)

LobbyForge voice uses LiveKit (WebRTC). Most clients connect directly or
via STUN; a minority — symmetric NATs, mobile carriers, corporate
networks that block UDP — need a TURN relay. The production stack ships
a standalone **coturn** container for exactly that case.

## How the pieces fit

```
client ── try direct/STUN ──► LiveKit (udp 50000-60000)
   │
   └── fallback (only on failure) ──► coturn TURN (3478, relay 49160-49200/udp)
                                        ▲
                       LiveKit advertises the TURN server to clients via
                       rtc.turn_servers in livekit.yaml (connect response)
```

- `infra/turn/turnserver.conf.template` — coturn config (rendered per
  install with your domain + shared credential; git-ignored output).
- `infra/livekit/livekit.yaml.template` — `rtc.turn_servers` entries
  (udp + tcp) with the same static user `lobbyforge`.
- `infra/docker/docker-compose.prod.yml` — the `turn` service
  (`coturn/coturn:4.6.2`, pinned), host networking so the UDP relay
  range binds directly.
- `scripts/render-configs.sh` — renders both files; the credential is
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
# TURN allocation on 3478/udp and 3478/tcp (expect "Allocate" success in coturn logs)
turnutils_uclient -u lobbyforge -w "$LOBBYFORGE_TURN_SECRET" -p 3478 -v your.domain
# Listening ports are up
nc -vz your.domain 3478 && nc -vz your.domain 5349
```

If case 4/5 fails: check `docker logs lobbyforge-turn`, confirm the
firewall range above, and verify the rendered `livekit.yaml` carries
`turn_servers` with your domain (udp 3478, tcp 3478, tls 5349).

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
- V4-007 (known debt): all clients share one static TURN credential.
  Alpha-scale quota limits bound the abuse surface; per-user ephemeral
  TURN auth is a production follow-up.
