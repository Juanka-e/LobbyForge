# Deploying LobbyForge behind Cloudflare (lobbyforge.org)

This guide covers running LobbyForge with **Cloudflare** in front —
including the **15-year Origin CA certificate** (`.pem`) model used for
the official deployment.

> **Not everyone deploys like this.** The DEFAULT and simplest path is
> Let's Encrypt via the installer (`bash install.sh`, option defaults).
> Use this guide only if you intentionally put Cloudflare's proxy in
> front of your instance. Both paths are first-class; pick one.

## TL;DR — official lobbyforge.org setup

| Step | Action |
|------|--------|
| DNS | `lobbyforge.org` (+ `community`, `docs`) → server IP, **proxied** (orange cloud) |
| DNS | TURN hostname (`turn.lobbyforge.org`) → server IP, **DNS only** (grey cloud) |
| Cloudflare SSL/TLS | Mode **Full (strict)** |
| Certificate | Origin CA certificate, 15 years, `.pem` pair (see below) |
| Install | `bash install.sh` → skip Let's Encrypt → "provide your own certificate" |
| Real IPs | `cp infra/nginx/cf-real-ip.conf.example infra/nginx/conf.d/cf-real-ip.conf` + restart nginx |
| Firewall | 80/443 open as usual; **3478, 5349, 7881/tcp + 49160-49200/udp + 50000-60000/udp must stay open** — Cloudflare does NOT proxy these |

## Why the proxy matrix matters

Cloudflare only proxies HTTP(S)-like traffic. LobbyForge's realtime
paths must reach the origin directly:

| Traffic | Path | Behind CF proxy? |
|---------|------|------------------|
| Web app | `https://lobbyforge.org` | ✅ proxied |
| WebSocket gateway | `wss://lobbyforge.org/ws` | ✅ proxied (CF supports WebSockets on proxied hostnames by default) |
| LiveKit signaling | `wss://lobbyforge.org/livekit` | ✅ proxied (WebSocket) |
| WebRTC media (ICE) | UDP 50000-60000 → **server IP directly** | ➖ not proxied — ICE candidates carry the server IP, DNS is irrelevant |
| TURN relay | `turn.lobbyforge.org` TCP 3478/5349 + UDP 49160-49200 | ❌ **must be DNS-only** — CF does not proxy TURN ports; a proxied TURN hostname resolves to CF edge IPs and TURN dies |

Rule of thumb: **HTTP(S)/WS hostnames may be proxied; anything the TURN/
ICE layer resolves must be DNS-only.**

## The 15-year Origin CA certificate

1. Cloudflare dashboard → **SSL/TLS → Origin Server → Create Certificate**.
2. Accept the defaults (RSA or ECC, hostnames `*.lobbyforge.org` +
   `lobbyforge.org`, validity **15 years**).
3. Cloudflare shows you the certificate and the private key **once** —
   save both as PEM files, e.g. `origin-cert.pem` and `origin-key.pem`
   (keep the key OFF the repo; `infra/certbot/` is git-ignored).
4. Run the installer:

   ```
   bash install.sh
   ...
   Proceed with certbot now? [Y/n]: n
   Provide your own certificate instead? [y/N]: y
   Certificate (fullchain) PEM path: /root/origin-cert.pem
   Private key PEM path: /root/origin-key.pem
   ```

   The installer validates that the cert parses, the key parses, and the
   two **match** (public-key comparison), then installs them at the exact
   path nginx expects (`infra/certbot/conf/live/<domain>/`). nginx needs
   no other change.

5. Cloudflare **SSL/TLS mode must be "Full (strict)"** — Origin CA
   certificates are only trusted by Cloudflare, never by browsers;
   browsers see Cloudflare's edge certificate. Never use "Flexible"
   (it downgrades origin traffic to plain HTTP).

Notes:

- The certbot sidecar keeps running but finds nothing to renew — its
  `No renewals were attempted` log lines are harmless noise.
- To replace the certificate in 15 years (or earlier): overwrite the
  two PEM files at `infra/certbot/conf/live/<domain>/` — nginx's
  in-container cert watcher detects the change and reloads gracefully
  within ~60 seconds. No restart required.
- Origin CA certs cover your hostnames **only via Cloudflare**. If you
  later point DNS directly at the server (grey cloud), browsers will
  reject the certificate — switch to Let's Encrypt in that case.

## Restoring real visitor IPs (important behind the proxy)

LobbyForge's nginx deliberately sets `X-Forwarded-For` to the immediate
peer — unspoofable, but behind Cloudflare every visitor would share an
edge IP, defeating IP-based rate limits and audit trails. Fix:

```sh
cp infra/nginx/cf-real-ip.conf.example infra/nginx/conf.d/cf-real-ip.conf
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod restart nginx
```

Only connections arriving FROM Cloudflare's published ranges are
rewritten to `CF-Connecting-IP`; direct connections keep their real
address. Refresh the ranges from <https://www.cloudflare.com/ips/> when
Cloudflare announces changes.

## Without Cloudflare (the default path)

No Cloudflare account needed: point DNS at the server, open ports
80/443, run `bash install.sh` and accept the certbot default. Let's
Encrypt provisions and auto-renews via the certbot sidecar, and the
visitor IP is always the real one (no proxy in the middle). This is the
path most self-hosters should start with — you can move to Cloudflare
later (re-run the installer with the own-certificate option).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Voice connects for some users, never for others | TURN hostname proxied — set it DNS-only; verify UDP ranges open on the host firewall |
| `curl https://<domain>` works, app shows CF IPs in logs | `cf-real-ip.conf` not installed / nginx not restarted |
| Browser certificate warning | SSL/TLS mode is not Full (strict), or you grey-clouded a hostname while using an Origin cert |
| WS connects then drops every ~100s | A proxy in between without WebSocket support — keep the hostname proxied only via Cloudflare, which supports WS |
| certbot log spam | Expected with an origin certificate — nothing renews, ignore |
