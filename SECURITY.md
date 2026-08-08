# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in LobbyForge, **please do not
open a public GitHub issue**. Instead, report it privately:

1. **GitHub Security Advisories** (preferred): go to the
   [Security tab](../../security/advisories/new) of this repo and create
   a private security advisory.
2. **Email**: send details to `security@lobbyforge.dev` (if available).

Please include:
- A description of the vulnerability and its impact.
- Steps to reproduce (proof of concept).
- The affected version/commit.

We acknowledge reports within **48 hours** and aim to publish a fix or
mitigation within **30 days** for critical issues.

## Supported Versions

Only the latest release receives security fixes. Self-hosted instances
should keep up to date via the built-in update system (Admin → Updates).

## Security Measures

LobbyForge implements defense-in-depth:

- **Session cookies**: HMAC-SHA256 signed, HttpOnly, SameSite=Lax, Secure in production.
- **Guest IDs**: 128-bit cryptographic randomness (`crypto.randomBytes`).
- **Admin auth**: owner session or constant-time emergency token (≥32 chars).
- **CSRF protection**: Fetch Metadata headers + Origin validation on all mutations.
- **CSP**: strict `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`.
- **Request body limits**: per-route caps (default 1 MiB).
- **Rate limiting**: Redis-backed (fails closed), per-route limits.
- **Update signatures**: Ed25519-signed manifests required for self-host updates.
- **Input validation**: Zod schemas on every API route.

## Self-Host Security Checklist

When deploying LobbyForge on your own server:

- [ ] Set `LOBBYFORGE_SESSION_SECRET` to ≥32 chars of random hex.
- [ ] Set `LOBBYFORGE_ADMIN_TOKEN` to ≥32 chars (different from session secret).
- [ ] Set `LOBBYFORGE_SETUP_TOKEN` and remove it after first-run setup.
- [ ] Use HTTPS (certbot/Let's Encrypt) — WebRTC requires it.
- [ ] Keep `registrationMode` on `invite_only` (the default).
- [ ] Run the Doctor health check after deployment.
- [ ] Configure backups via the backup manifest.
