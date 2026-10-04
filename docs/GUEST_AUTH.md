# Guest Auth and LiveKit Token Endpoint

This document describes the local guest/session boundary and the current
LiveKit token contract.

Important boundary: a LobbyForge self-host instance owns its local user
rows, memberships, roles, bans, messages, game history, and voice-channel
authorization. The official LobbyForge account is optional and can map to a
local user row later; it must not bypass the instance owner's auth policy.

## Local owner authentication

First-run `/setup` creates a credentialed local owner instead of a
display-name-only placeholder. The email is normalized and unique; the
password is hashed in `apps/web` with salted Scrypt before the DB package sees
it. The same atomic bootstrap creates the first server, owner membership,
default admin roles, and `general` plus `Lobby` channels.

`POST /api/auth/login` verifies local credentials with rate limiting and a
generic error response, then issues an HttpOnly signed session. For current
API and WebSocket compatibility, local accounts temporarily use the existing
`lf_guest` cookie envelope with a real `uid`; this does not create another
guest user row.

### Sign-in failure limits

Besides each route's per-IP bucket, password guesses are limited per
account (`apps/web/lib/auth-throttle.ts`):

| Counter | Shared by | Limit |
|---|---|---|
| sign-in, keyed by the normalised email | `POST /api/auth/login` and `POST /api/auth/desktop-session` (start) | 10 failures / 15 min |
| sign-in from a known device, keyed by the email and the device cookie's nonce (only while its entry matches the account's current password) | the same two routes | 10 failures / 15 min per device |
| password change, keyed by user id | `POST /api/auth/password` (current-password check) | 5 failures / 15 min |

- Every attempt is counted before the password is checked, atomically, and
  a correct password clears the counter. Once the limit is reached, every
  further attempt gets the generic `429` (`{ error: "Rate limit exceeded",
  retryAfter, resetAt }` plus `Retry-After`, the same as the per-IP
  limiter) until the window, fixed from the first failure, ends — whether
  or not the password is right, and without checking it.
- Unknown emails are counted and locked exactly like known ones, and the
  401 path keeps the dummy-hash verification, so neither the status
  sequence nor the timing tells whether an account exists.
- Redis key names hold an HMAC (keyed with `LOBBYFORGE_SESSION_SECRET`) of
  the normalised email or user id, never the email itself:
  `lf:<env>:rate-limit:auth-account:<scope>:<hex>`, and
  `lf:<env>:rate-limit:auth-device:sign-in:<hex>` for device buckets.
  Clearing `*rate-limit*` keys resets them too.
- Storage follows the rate limiter: Redis in production (or with
  `LOBBYFORGE_RATE_LIMIT_STORE=redis`), in-process otherwise. When Redis is
  unavailable the attempt is refused with a short `Retry-After` (fail
  closed). That applies to device buckets too.
- Any per-account limit lets someone who knows an address lock the account
  in 15-minute stretches. Device cookies (below) keep the owner's own
  browsers out of that lock. A browser that has never signed in to the
  account (a new computer, a cleared cookie jar) still waits out the lock.
  An existing session is never affected.

#### Device cookies

This follows OWASP's "Slow Down Online Guessing Attacks with Device
Cookies" (`apps/web/lib/device-cookie.ts`). A successful sign-in through
either route sets `lf_device` alongside the response:

| Property | Value |
|---|---|
| Name | `lf_device` |
| `HttpOnly` | yes |
| `SameSite` | `Lax` |
| `Secure` | yes in production |
| `Path` | `/` |
| `Max-Age` | 180 days, renewed by every successful sign-in |
| MAC key | derived from `LOBBYFORGE_SESSION_SECRET` with its own label (`lobbyforge:device-cookie:mac:v1`) |

The value has the same `<base64url(payload)>.<base64url(hmac)>` format as
`lf_guest`, and the payload is

```json
{ "v": 2, "subjects": [{ "sub": "<base64url>", "cred": "<base64url>", "nonce": "<base64url>", "iat": 1790000000 }] }
```

- `sub` is an HMAC of the normalised email under another derived key, so
  the email never appears in the cookie. `cred` is an HMAC of the
  normalised email and the account's password hash at issue time, under a
  third derived key: the keyed counterpart of the credential fingerprint
  that desktop handoff codes carry. The browser can read the cookie, so no
  unkeyed digest of the hash goes into it. `nonce` is 16 random bytes and
  is new on every successful sign-in. `iat` is when that entry was issued,
  and each entry is trusted for 180 days from its own `iat`.
- A `v: 1` cookie (from before entries carried `cred`) is not accepted.
  Such a browser uses the account-wide counter until its next successful
  sign-in, which issues a `v: 2` cookie.
- One cookie holds up to **5** accounts (a shared computer), newest first.
  Signing in to a sixth drops the oldest. A single bounded cookie was
  chosen over one cookie per account because a browser holds a limited
  number of cookies per site and evicts the oldest past it, which could
  be `lf_guest`. Every cookie also rides on every request.
- When a sign-in attempt carries a valid, unexpired entry for the submitted
  email, the attempt is counted in that device's own bucket (10 failures
  / 15 min, keyed by email + nonce), atomically and before the password is
  checked. It is **not** refused by the account-wide lock and does not add
  to it. A device success clears only its own bucket. It never clears the
  account counter, because that would hand whoever is guessing a fresh
  batch of guesses every time the owner signs in.
- A device whose bucket fills is untrusted until that bucket's window ends.
  Its attempts are then charged to the account-wide counter like any
  browser without a device cookie, and they are refused while the account
  is locked. A success from an untrusted device resets neither counter.
  The next success still issues a fresh nonce, as always.
- **A password change voids every device entry of that account.** The
  new hash always differs from the old one (a new salt every time), so no
  existing `cred` matches it any more, on any browser. Changing the
  password is also how a user signs out everywhere (`POST
  /api/auth/password` revokes every other session), so that case is the
  same one. There is no separate "sign out everywhere" action. Signing
  out, or revoking one session from the sessions list, leaves device
  cookies alone on purpose.
- The check runs in two steps, because an attempt is counted before the
  account is looked up and the hash is only known after the lookup:
  1. Before the lookup, a valid, unexpired entry for the submitted email
     (MAC and `sub` checked) puts the attempt on the device path and
     charges the device's bucket, as above.
  2. After the lookup and **before the password is checked**, `cred` is
     compared, in constant time, with the HMAC of the account's current
     hash. When it does not match (the password changed, the account was
     deleted, or it has no password), the device path is withdrawn: the
     attempt is charged to the account-wide counter like a browser without
     a device cookie, gets the generic `429` while the account is locked,
     and the password is not checked. So a stale cookie gives no bucket
     outside the account lock, and its guesses count towards that lock.
     Step 2 runs on every attempt, unknown emails included. When there is
     no hash, a fixed stand-in is digested, so every attempt does the same
     work.
  A successful sign-in with the new password issues a fresh entry bound to
  the new hash. It replaces that browser's stale entry for the account and
  leaves the entries of other accounts alone.
- Anything else uses the account-wide counter exactly as before: no cookie,
  a forged or tampered one, an expired entry, or a cookie that only has
  entries for other accounts. None of these take the device path in step
  1, so a locked attempt is still answered before anything is looked up.
  Unknown emails never succeed, so they never get an entry, and their
  responses stay identical to those of known emails. That includes a
  browser that holds a stale entry for the known email. No cookie is set
  on a `401` or `429`.
- Both routes share the cookie and the device buckets. A cookie earned on
  the login form works on the desktop handoff start, and the reverse.
- A device cookie grants no access by itself. It only decides which counter
  a password guess is charged to. It survives sign-out on purpose: it marks
  the browser, not a session. It does not survive a password change.
  Someone who steals one gets at most one more bucket of guesses against
  that one account, and only until the password changes.
- After a password change, the owner's other browsers wait out an
  account lock like a new computer, until each signs in once with the new
  password. The browser the password was changed in keeps its session.

### Bot protection (CAPTCHA)

Sign-up, new guests and suspicious sign-ins have to pass a challenge. The
full contract is [CAPTCHA.md](./CAPTCHA.md); this is how it sits in the
auth routes.

| Route | Surface | Asked when |
|---|---|---|
| `POST /api/auth/register` | `register` (no invite; the official hub always), `invite_register` (with an invite) | `register`: its switch is `on` (default). With an invite on an **open** instance: `register` **or** `invite_register` is on — an invite never lowers protection, since `@everyone` can create unlimited invites. On an **invite-only** instance `invite_register` alone decides (default off). |
| `POST /api/auth/guest` | `guest` | the request would create a **new** guest identity (no valid guest cookie) and the surface is `on` (default). A refresh or re-bind never is. |
| `POST /api/auth/login`, `POST /api/auth/desktop-session` | `login` | `adaptive` (default): the account has at least `loginFailureThreshold` (3) attempts on the sign-in counter above, the client address has that many failed sign-ins in 15 min, or attack mode is on. `always`: every time. Never from a trusted device: a valid `lf_device` entry for the account that still matches its current password and whose own bucket has not tripped. |

- The default provider is the built-in **ALTCHA** proof of work: no third
  party, no cookie, no keys. Cloudflare Turnstile and Google reCAPTCHA are
  optional (Admin → Settings → Authentication → Bot protection, or
  `LOBBYFORGE_CAPTCHA_PROVIDER` / `_SITE_KEY` / `_SECRET_KEY`).
  `LOBBYFORGE_CAPTCHA_PROVIDER=none` switches it all off.
- The routes accept four optional body fields: `captchaToken`,
  `captchaProvider`, `formToken` (from `GET /api/auth/captcha?surface=…`,
  the minimum-fill-time check: 2 s to 2 h) and `website` (a honeypot that
  must stay empty). Every refusal is HTTP 400 with `error` set to
  `captcha_required`, `captcha_invalid`, `captcha_unavailable` or
  `form_rejected`.
- The check runs after the zod parse and before any database work or
  password hashing. On the sign-in routes it runs **before** the attempt is
  counted, so a request refused for a missing challenge costs the account
  nothing; a wrong password (401) feeds the address counter and the
  instance-wide attack-mode counter (over 50 failures in 10 min turns it on
  for 30 min).
- New guests also get their own bucket: 10 per hour per client address
  (checked before the challenge, counted when a new identity is about to
  be created), on top of the route's 30/min that refreshes keep sharing.
  Without a trusted proxy (every client "unknown") it is one instance-wide
  backstop of 200 per hour instead.
- A form token is single use.
- Never asked on voice, chat, webhooks, the Bot API, LiveKit or the
  gateway.

Production bootstrap requires `LOBBYFORGE_SETUP_TOKEN`. It is generated by the
installer independently from the session secret, compared in constant time,
and never stored in PostgreSQL.

## Identity Scope

- Official LobbyForge account: registry, official hub, desktop profile sync,
  developer portal, optional "Sign in with LobbyForge".
- Local instance account: the actual user row used by server membership,
  permissions, bans, messages, games, and LiveKit voice access.
- Guest session: a first-party cookie that can be materialized into a local
  user row. Voice and server APIs require the `uid` once membership needs to
  be checked.

A user may need to register or join separately on different self-host
instances unless that instance explicitly enables LobbyForge account login.

`user_identity_links` stores that optional mapping as `(provider,
provider_subject) -> local userId`. Provider subjects and user/provider pairs
are independently unique. The table stores display claims and verified email
metadata, but never upstream access tokens, refresh tokens, local roles, or
local credentials.

Local registration applies the instance registration mode first. When the
target server has an explicit access-policy row, the route also enforces its
local-account, join-policy, and first-join-approval restrictions before
hashing a password. Registration itself still refuses a server whose policy
requires approval: an existing account or a guest asks to join through an
invite or the lobby's "Ask to join" button instead, and a moderator decides
in the approval queue (`docs/INVITES.md`, "Approval queue"). A missing
server policy row preserves instance-level behavior for existing
installations.

Official sign-in callbacks remain closed until the official IdP publishes an
issuer/audience, signed-token, state, nonce, PKCE, and key-rotation contract.
The identity-link schema is not permission to trust browser assertions.

## Cookie Format

The `lf_guest` cookie value is:

```txt
<base64url(payload)>.<base64url(hmac_sha256(payload, secret))>
```

Payload:

```json
{
  "gid": "g_<32 hex chars>",
  "uid": "local-user-uuid-or-null",
  "name": "Guest abcd",
  "iat": 1718049600,
  "exp": 1718053200,
  "auth_time": 1717444800
}
```

`iat`/`exp` belong to this cookie; `auth_time` is when the session was first
issued (sign-in, or guest creation) and is copied unchanged by every
refresh.

Cookie properties:

| Property | Value |
|---|---|
| Name | `lf_guest` |
| `HttpOnly` | yes |
| `SameSite` | `Lax` |
| `Secure` | yes in production |
| `Path` | `/` |
| `Max-Age` | 3600 s (less when the session nears its absolute lifetime) |
| Secret | `LOBBYFORGE_SESSION_SECRET`, at least 32 characters |

`readGuestSession` verifies expiry and the HMAC using timing-safe comparison.
Tampered or expired cookies return `null`.

### Absolute session lifetime

A cookie lives one hour and `POST /api/auth/guest` refreshes it. A session
can be refreshed for at most `LOBBYFORGE_SESSION_MAX_AGE_DAYS` (default
**30**; fractions allowed, clamped to 1 hour … 365 days; anything that is not
a positive number falls back to 30 with a warning) after its `auth_time`:

- A refresh signs `exp = min(now + 1 h, auth_time + max age)`, so no cookie
  ever outlives the limit. Readers that only check `exp` — the ws-gateway —
  enforce it without knowing the setting.
- The web app's `readGuestSession` (`apps/web/lib/guest-session.ts`) also
  reads a session older than the current setting as absent. That covers an
  operator lowering the limit, and it is what every API route
  (`withApiSecurity`, `requireMaterializedSession`), every page
  (`getActiveSession`) and the refresh route use: an over-age session is
  signed out.
- `POST /api/auth/guest` with an over-age session does not refresh it. The
  request is handled like one without a cookie: a new guest identity if
  the instance allows guests, otherwise the access-policy error. A
  signed-in user signs in again.
- **Guests are included.** A guest's identity is the cookie, so a stolen
  guest cookie is the whole guest account. After the limit the browser gets
  a new guest identity; the old guest user row keeps its history.
- Recorded sessions (`apps/web/lib/session-tracker.ts`) remember the
  session's start: the Redis entry never outlives the absolute lifetime,
  the active-sessions list hides over-age entries, and "sign out other
  sessions" still revokes them.
- Compatibility: cookies issued before this change have no `auth_time`.
  They keep working until their own `exp` (at most an hour); their first
  refresh stamps `auth_time = now`, which starts their clock. Nobody is
  signed out by the upgrade. Setting the variable affects the web app only
  — new cookies carry the limit in `exp`, so the gateway needs no change.

## Endpoints

### `POST /api/auth/guest`

Creates or refreshes a local guest session. A refresh keeps the session's
`auth_time`; a session past its absolute lifetime is not refreshed (see
[Absolute session lifetime](#absolute-session-lifetime)).

Request body:

```json
{ "displayNameSeed": "alice", "rebind": false }
```

Response:

```json
{
  "guest": {
    "gid": "g_0123...",
    "uid": "00000000-0000-0000-0000-000000000001",
    "name": "Guest alice",
    "ttlSeconds": 3600
  }
}
```

`ttlSeconds` is the cookie's lifetime: 3600, or less in the session's last
hour.

A request that would create a **new** guest identity also carries the bot
protection fields (`captchaToken`, `captchaProvider`, `formToken`,
`website`) when the `guest` surface is on — see
[Bot protection](#bot-protection-captcha).

Errors:

- 400: invalid `displayNameSeed`
- 400: `captcha_required`, `captcha_invalid`, `captcha_unavailable`,
  `form_rejected` (new identities only)
- 429: more than 10 new guest identities in an hour from this address
- 500: missing or weak `LOBBYFORGE_SESSION_SECRET`

### `GET /api/auth/guest`

Lightweight session probe.

- 200: `{ guest: { gid, uid, name, iat, exp } }`
- 401: no active session

### `POST /api/livekit/token`

Exchanges the local session cookie for a channel-scoped LiveKit JWT.

This route is no longer a generic "mint a token for any room string" endpoint.
It is scoped to an existing voice/stage channel and checks local instance
authorization before signing the token.

Request body:

```json
{
  "serverId": "00000000-0000-0000-0000-000000000001",
  "channelId": "00000000-0000-0000-0000-000000000010",
  "displayName": "Optional override",
  "canPublishSources": ["microphone"],
  "hidden": false,
  "metadata": "{\"role\":\"host\"}"
}
```

Authorization rules:

- Valid `lf_guest` cookie is required.
- Cookie must contain a materialized local `uid`.
- `serverId` must exist.
- `channelId` must exist and belong to `serverId`.
- Channel type must be `voice` or `stage`.
- Caller must be owner or member of the server.
- Caller must have `CONNECT_VOICE`.

The server derives the LiveKit room name from `serverId + channelId`:

```txt
s_<server_uuid_without_dashes>_c_<channel_uuid_without_dashes>
```

The client must not provide the LiveKit room name directly.

Response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "identity": "00000000-0000-0000-0000-000000000001",
  "room": "s_00000000000000000000000000000001_c_00000000000000000000000000000010",
  "serverId": "00000000-0000-0000-0000-000000000001",
  "channelId": "00000000-0000-0000-0000-000000000010",
  "ttlSeconds": 600,
  "expiresAt": 1718053200
}
```

Errors:

- 400: invalid body, or channel is not voice/stage
- 401: missing/invalid session cookie
- 403: not a server member, or lacks `CONNECT_VOICE`
- 403 `{ code: "voice_blocked", retryAfter }`: removed for a mislabelled track and blocked from voice on this server for `retryAfter` more seconds (see `docs/VOICE_ROOM.md`, "Voice block")
- 404: server/channel not found
- 503: guest session has no local `uid`, LiveKit credentials are missing, or (production) the voice block list cannot be read

## JWT Shape

The token is an HS256 LiveKit access token:

```json
{
  "video": {
    "room": "s_<server>_c_<channel>",
    "roomJoin": true,
    "canPublish": true,
    "canSubscribe": true,
    "canPublishData": true
  },
  "iss": "<LIVEKIT_API_KEY>",
  "sub": "<local uid>",
  "iat": 1718049600,
  "exp": 1718053200
}
```

The `sub` claim uses the local user id. This keeps LiveKit moderation
actions aligned with memberships, roles, bans, and audit logs.

## `/connect` Developer Page

`apps/web/app/connect/page.tsx` is only a developer surface. It now asks for
a server UUID and voice/stage channel UUID before requesting a token. The
real user-facing flow is the voice-room page with `serverId` and `channelId`
in the URL.

## Security Notes

- The token endpoint is first-party only.
- `withApiSecurity` applies method allowlists, security headers, rate limits,
  and an Origin guard for state-changing browser requests.
- Rate limiting is IP-scoped and Redis-backed in production (in-process in
  development). It can only tell clients apart behind a trusted proxy
  (`LOBBYFORGE_TRUSTED_PROXY`); without one every client shares one bucket,
  which Admin → Health (Doctor) reports as the `trusted_proxy` warning.
  Sign-in and password changes also have per-account limits (see
  [Sign-in failure limits](#sign-in-failure-limits)).
- A double-submit CSRF token is not implemented yet; current protection is
  `SameSite=Lax` plus Origin validation.
