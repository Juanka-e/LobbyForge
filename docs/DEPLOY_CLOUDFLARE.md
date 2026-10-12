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

### Which `LOBBYFORGE_TRUSTED_PROXY` to use

The app keys rate limits (sign-in included) on the client address, and it
only believes the header named by `LOBBYFORGE_TRUSTED_PROXY`:

- **Bundled nginx (this guide): keep `LOBBYFORGE_TRUSTED_PROXY=x-forwarded-for`**
  (the installer's default) and install `cf-real-ip.conf` as above. nginx
  then rewrites the address only for connections that really come from
  Cloudflare and passes the result on as `X-Forwarded-For`, so a visitor
  who reaches the origin directly still gets their own address.
- **`LOBBYFORGE_TRUSTED_PROXY=cloudflare`** makes the app read
  `CF-Connecting-IP` itself. That is only safe when the origin accepts
  traffic **from Cloudflare alone** (firewall limited to Cloudflare's
  ranges, or a Cloudflare Tunnel). Otherwise anyone who finds the server's
  IP can connect directly and send any `CF-Connecting-IP` they like — a
  fresh rate-limit bucket on every request, or a victim's address to lock
  them out. nginx forwards that header untouched.
- **Unset (or `none`) in production**: every visitor shares one rate-limit
  bucket, so one client can lock everyone out of sign-in. The app still
  starts (existing installs are not refused); it logs a warning once and
  Admin → Health (Doctor) shows a `trusted_proxy` warning with this fix.

## Without Cloudflare (the default path)

No Cloudflare account needed: point DNS at the server, open ports
80/443, run `bash install.sh` and accept the certbot default. Let's
Encrypt provisions and auto-renews via the certbot sidecar, and there is
no proxy in the middle — but check the IPv6 case below: with Docker's
defaults, visitors arriving over IPv6 can all show up as one address.
This is the path most self-hosters should start with — you can move to
Cloudflare later (re-run the installer with the own-certificate option).

## Client addresses behind Docker

security-review INFRA-V-01. Docker publishes nginx's ports 80/443. For
IPv4 it rewrites the destination in the kernel, so nginx sees each
visitor's real address. For **IPv6**, when the `lobbyforge-edge` network
has no IPv6 (the default), Docker's *userland proxy* (`docker-proxy`)
accepts the connection on the host and opens a new IPv4 connection to
nginx — from the bridge gateway, e.g. `172.18.0.1`. Every IPv6 visitor
then has the same address. On some hosts (hairpin NAT, a proxy in front)
every visitor does.

Why it matters: LobbyForge keys sign-in rate limits, the guest limit
and the daily image-upload budget on the client address. When everyone
shares one address, one client can lock all of them out of sign-in, and
the per-address budgets become instance-wide.

**Detect it.** Admin → Health (Doctor) shows a `client_address` warning
when the request asking for the report, or most recent requests, come
from a gateway address (the container's default gateway, or a private
`x.x.x.1`) while `LOBBYFORGE_TRUSTED_PROXY` is set. You can also look at
nginx's log: `docker logs lobbyforge-nginx --tail 50` — every line
starting with the same `172.x.0.1` is the problem.

**Fix it** — one of these, on the Docker host:

1. **Give the edge network IPv6** (keeps IPv6 working, with real
   addresses). Docker Engine 27+ has `ip6tables` on by default. Add a
   unique-local subnet to the `edge` network in
   `infra/docker/docker-compose.prod.yml`:

   ```yaml
   networks:
     edge:
       name: lobbyforge-edge
       enable_ipv6: true
       ipam:
         config:
           - subnet: fd42:1f0b:c0de::/64
   ```

   then recreate the stack (`docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod down && … up -d`;
   the network must be recreated, volumes are kept). Keep the edit when
   you update — it is a local change to a tracked file.
2. **Turn off the userland proxy.** In `/etc/docker/daemon.json`:

   ```json
   { "userland-proxy": false, "ip6tables": true }
   ```

   and `sudo systemctl restart docker`. Docker then never proxies an IPv6
   connection to an IPv4-only container: browsers fall back to IPv4 (Happy
   Eyeballs) and arrive with their real IPv4 address. Combine with option 1
   to serve IPv6 properly.
3. **Publish no `AAAA` record** for the domain. Visitors connect over IPv4
   only. Simplest, and fine for most communities.

After the change, open Admin → Health again: `client_address` should say
the addresses look like real visitors. `install.sh` does not change
Docker's daemon settings for you.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Voice connects for some users, never for others | TURN hostname proxied — set it DNS-only; verify UDP ranges open on the host firewall |
| `curl https://<domain>` works, app shows CF IPs in logs | `cf-real-ip.conf` not installed / nginx not restarted |
| Everyone gets "Rate limit exceeded" at once; Doctor shows `trusted_proxy` | `LOBBYFORGE_TRUSTED_PROXY` unset — set it to `x-forwarded-for` in `.env.prod` and recreate `web` |
| IPv6 visitors share one rate limit; Doctor shows `client_address`; nginx logs show `172.x.0.1` | Docker's userland proxy — see [Client addresses behind Docker](#client-addresses-behind-docker) |
| Browser certificate warning | SSL/TLS mode is not Full (strict), or you grey-clouded a hostname while using an Origin cert |
| WS connects then drops every ~100s | A proxy in between without WebSocket support — keep the hostname proxied only via Cloudflare, which supports WS |
| certbot log spam | Expected with an origin certificate — nothing renews, ignore |
