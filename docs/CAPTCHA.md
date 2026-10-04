# Bot protection (CAPTCHA)

Status: **implemented** (server and UI). This is the operator guide and
the contract the code follows. The decision and the research behind it are
in `CAPTCHA_RESEARCH_2026-10.md`. Notes marked **As implemented** record
where the code settled a detail the first draft left open, or changed it.
Keep this file accurate when the code changes.

Code: `apps/web/lib/captcha/` (settings, secret, ALTCHA, providers,
breaker, signals, form token, guards, CSP, Doctor, admin), the routes under
`app/api/auth/captcha` and `app/api/admin/captcha`, migration
`packages/db/drizzle/0045_captcha.sql`.

## 1. What it does

A sign-up, a new guest or a suspicious sign-in has to pass a challenge.
- **Default provider: ALTCHA.** It is built in. The browser solves a small
  proof of work (PBKDF2/SHA-256 through Web Crypto — ALTCHA's v2 format),
  with no third party involved, no cookie and no internet needed.
- **Optional external providers:**
  - Cloudflare Turnstile;
  - Google reCAPTCHA: v2 checkbox, v2 invisible or v3 score.
- **hCaptcha:** later, only if someone asks for it.

The challenge never runs on voice, chat, webhooks, the Bot API, LiveKit or
the gateway.

Captcha is one layer. Rate limits, the per-account lock, device cookies and
the approval queue stay in place, and phase 0 (§7) adds more.

## 2. Surfaces and defaults

| Surface key | Route(s) | Default | Modes |
|---|---|---|---|
| `register` | `POST /api/auth/register` without an invite (also the official hub sign-up) | on | `on`, `off` |
| `invite_register` | `POST /api/auth/register` with an invite code — **on invite-only instances only** (see below) | off | `on`, `off` |
| `guest` | `POST /api/auth/guest` when it would create a **new** guest identity (no valid guest cookie) | on | `on`, `off` |
| `login` | `POST /api/auth/login`, `POST /api/auth/desktop-session` | adaptive | `off`, `adaptive`, `always` |

**Adaptive sign-in** asks for a challenge when any of these is true:
- the account has at least `loginFailureThreshold` failures (default 3) in
  the auth-throttle window;
- the client address is over its failure threshold;
- **attack mode** is on (§7).

It never asks when the request comes from a **trusted device** for that
account. `always` asks every time. A trusted device still skips the
challenge under `always`: the owner's own browser is not a bot.

**As implemented:** "trusted device" = a valid `lf_device` entry for the
account that still **holds** (`deviceClaimHolds`: bound to the account's
current password hash) and whose own failure bucket has **not tripped**
(`deviceSignInPathOpen`). A MAC-valid entry from before a password change,
or from a device that has been guessing, does not skip anything — attack
mode included. Checking the hash needs the account, so a request with a
usable entry looks the account up before the attempt is counted (the row
is reused afterwards); requests without one are not looked up early.

Refreshing an existing guest (the re-bind path, or a guest cookie that is
still valid) never asks.

**An invite can only ADD protection** (changed after review): on an
**open** instance `@everyone` may create invites, with no use limit, so a
bot could solve one challenge, make an unlimited invite and then sign up
through it forever. So:
- open instance: a sign-up **with** an invite is challenged when
  `register` **or** `invite_register` is on;
- **invite-only** instance: `invite_register` alone decides. There the
  invite is the gate, and turning `invite_register` off trusts everyone who
  can create invites (by default `@everyone` with the Create Invite
  permission);
- closed instance: refused (403) before any challenge; official hub: always
  `register` (it has no invite sign-up).
The token and the form token of an invite sign-up are still bound to the
`invite_register` surface; only the requirement changes. The public config
of `invite_register` reads the registration mode and answers the same rule
(`mode` is then `on`/`off` as in force).

## 3. Configuration

### 3.1 Stored settings (migration 0045, on `instance_settings`)

| Column | Type | Default |
|---|---|---|
| `captcha_provider` | text: `none`, `altcha`, `turnstile` or `recaptcha` | `altcha` |
| `captcha_surfaces` | jsonb `{ register, invite_register, guest, login }` | `{"register":"on","invite_register":"off","guest":"on","login":"adaptive"}` |
| `captcha_site_key` | text, nullable | null |
| `captcha_secret_encrypted` | text, nullable (§3.3) | null |
| `captcha_options` | jsonb (below) | `{}` |
| `captcha_attack_mode` | boolean | false |

`captcha_options` (every key optional, validated with zod on write):
- `altchaDifficulty`: `normal` | `hard` (default `normal`). **As
  implemented:** ALTCHA v2 has no `maxnumber`; the work is PBKDF2-SHA-256
  `cost` iterations per counter value, for every value from 0 up to the
  secret counter, which the server picks uniformly in `[0, counterMax]`:

  | | `cost` | counter | expected PBKDF2 iterations | at most |
  |---|---|---|---|---|
  | `normal` | 2 000 | 0–2 500 | 2.5 M | 5 M |
  | `hard` | 4 000 | 0–7 500 | 15 M | 30 M |

  With Web Crypto that is well under a second on a desktop for `normal`.
  The range starts at 0 on purpose: a public floor ("never below N") lets a
  solver skip the first N derivations; the higher cost keeps the expected
  work. See `ALTCHA_DIFFICULTY` in `lib/captcha/altcha.ts`.
- `turnstileAppearance`: `always` | `interaction-only` (default `interaction-only`, which looks invisible until Cloudflare wants a click)
- `recaptchaVersion`: `v2_checkbox` | `v2_invisible` | `v3` (default `v3`)
- `recaptchaMinScore`: 0.1–0.9 (default 0.5; v3 only)
- `loginFailureThreshold`: 1–10 (default 3)

Note: Turnstile's widget mode (managed, non-interactive or invisible) is a
property of the **site key** in the Cloudflare dashboard. The admin screen
explains this and only offers the appearance option.

### 3.2 Environment overrides (win over the database; the admin UI shows them as locked)

- `LOBBYFORGE_CAPTCHA_PROVIDER` — `none` turns protection off. It is the
  emergency switch.
- `LOBBYFORGE_CAPTCHA_SITE_KEY`, `LOBBYFORGE_CAPTCHA_SECRET_KEY`

**As implemented:** an empty value counts as unset. A provider value that
is not one of the four is ignored (logged once, and Doctor warns). An
environment value is never copied into the database: a `PUT` with the
locked value leaves the stored column alone. The secret from the
environment is used as is (it is not stored).

The settings are cached per process for 5 s (on `globalThis`, shared by the
routes and the CSP middleware); a save through the admin API invalidates
that process's cache (a generation counter keeps a read that started before
the save from putting old values back), other processes catch up within
5 s. If the row cannot be read, the defaults apply (ALTCHA, sign-up and new
guests on): protection never turns off because the database hiccupped. That
answer is cached for 3 s, the error logged at most once a minute; the admin
API's fresh reads bypass the cache, and a save against an unreadable row is
refused (§6.1).

**Upgrading:** migration 0045 gives an existing install the defaults
above, so sign-up and new guests are protected by ALTCHA right after the
upgrade. `LOBBYFORGE_CAPTCHA_PROVIDER=none` restores the old behaviour.

**Upgrading an install served over plain HTTP** (a LAN address such as
`http://192.168.1.6:19520`, no TLS): browsers only give Web Crypto to a
secure context (HTTPS or localhost), so ALTCHA cannot use it there. The
widget then falls back to a pure-JavaScript solver — sign-up and new guests
keep working, but the proof of work takes several times longer (seconds on
a desktop, longer on a phone). Voice does not work on such an origin at all
(microphone and camera need a secure context too). Doctor reports
`secure_origin` as **critical** while ALTCHA is active. Serve the instance
over HTTPS, or — on a trusted LAN only — set
`LOBBYFORGE_CAPTCHA_PROVIDER=none`.

### 3.3 The secret key

- The secret key is encrypted at rest with AES-256-GCM.
- The encryption key comes from `HKDF-SHA256(session secret,
  info "lobbyforge:captcha-secret:v1")`.
- Stored format: `v1.<iv>.<ciphertext>.<tag>` (base64url).
- **It never goes back to a browser.** The admin API only returns
  `{ secretSet: boolean, secretHint: "…abcd" }`.
- If the session secret changes, decryption fails. The provider is then
  treated as misconfigured (§5) and Doctor reports it.

## 4. HTTP API

### 4.1 Public config — `GET /api/auth/captcha?surface=<key>`

```json
{
  "surface": "register",
  "required": true,
  "mode": "on",
  "provider": "altcha",
  "siteKey": null,
  "options": { "turnstileAppearance": "interaction-only", "recaptchaVersion": "v3" },
  "formToken": "<signed>"
}
```

- `required` is false when the surface is off.
- For `login` in adaptive mode, `required` is false (unless attack mode is
  on) and `mode` is `"adaptive"`. The UI then shows the challenge only after
  a `captcha_required` answer.
- `provider` is what the client must render **now**. It is `altcha` while
  the external-provider breaker is open (§5).
- `formToken` backs the minimum-fill-time check (§7). It is returned for
  `register`, `invite_register` and `guest`.
- `Cache-Control: no-store`.

**As implemented:**
- `formToken` is `null` for `login` (the key is always present).
- With provider `none`: `required: false`, `mode: "off"`, `provider: "none"`.
- `siteKey` is set only when `provider` (the one to render now) is
  external.
- An unknown or missing `surface` answers 400 `{ "error": "invalid_surface" }`.
- Rate limit: 120 / min per address — or, when client addresses are
  unknown (no `LOBBYFORGE_TRUSTED_PROXY`), one instance-wide backstop of
  1 200 / min instead of a small bucket everyone shares
  (`lib/captcha/limits.ts`). The lazy reachability probe (§5) runs in the
  background, so a slow provider never slows this answer.
- `invite_register`: `required` and `mode` follow the rule of §2 (an
  invite only adds protection), so the server reads the registration mode.

### 4.2 ALTCHA challenge — `GET /api/auth/captcha/challenge?surface=<key>`

- Returns an ALTCHA challenge created with `altcha-lib`.
- The challenge is HMAC-signed with a key derived from the session secret
  (info `lobbyforge:altcha:v1`).
- It carries the expiry (5 min) and the surface, so a solution for
  `guest` is refused on `register`.
- Rate limited per IP, like the other auth endpoints.

**As implemented (shape changed from the first draft):** `altcha-lib` 2.x
and the `altcha` 3.x widget use ALTCHA's **v2** challenge format, so the
answer is

```json
{
  "parameters": {
    "algorithm": "PBKDF2/SHA-256",
    "nonce": "<hex>", "salt": "<hex>",
    "cost": 2000, "keyLength": 32,
    "keyPrefix": "<hex>", "keySignature": "<hex>",
    "expiresAt": 1791110400,
    "data": { "surface": "register" }
  },
  "signature": "<hex>"
}
```

not the v1 `algorithm / challenge / maxnumber / salt / signature`. The UI
never reads it — it passes this URL to the widget's `challenge` attribute,
and the widget submits base64 of `{ challenge: { parameters, signature },
solution }` as `captchaToken`. The surface lives in the signed
`parameters.data.surface` and the expiry in the signed
`parameters.expiresAt` (v2 has no salt query string). Deterministic mode:
the server picks the counter and signs the expected key (`keySignature`,
key info `lobbyforge:altcha:key:v1`), so verifying a solution is two HMACs.
The widget needs a `PBKDF2/SHA-256` worker (see §9). Rate limit: 30 / min
per address, or an instance-wide backstop of 600 / min when client
addresses are unknown. Without a session secret: 503 `{ "error": "captcha_unavailable" }`.
The e2e helpers can solve it in Node with `altcha-lib`'s `solveChallenge`
and `altcha-lib/algorithms/pbkdf2`.

### 4.3 Sending a solution

The protected routes accept these optional body fields:
- `captchaToken: string` — the ALTCHA payload, or the Turnstile/reCAPTCHA
  response token. Max 4096 characters.
- `captchaProvider` — which provider produced the token.
- `formToken` — from §4.1.
- `website` — the honeypot field. It must be empty or absent.

Every protected route keeps its `.strict()` schema, with these fields added.

**As implemented:** the fields are `CaptchaBodyFields` in
`lib/captcha/types.ts`: `captchaProvider` is `altcha | turnstile |
recaptcha`, `formToken` at most 256 characters, `website` at most 1024 (a
filled one is `form_rejected`, not a validation error). Register and guest
were `.strict()` and stay so; the login and desktop-session schemas were
never strict and keep their old behaviour. The four routes' body limit is
now 12 KiB (it was 4 KiB on register and desktop-session), to fit a
4096-character token.

### 4.4 Refusals (always HTTP 400 JSON)

| `error` | Meaning | UI does |
|---|---|---|
| `captcha_required` | No token, but one is needed now (also the adaptive login trigger) | Fetch the config, render the widget, let the user resubmit |
| `captcha_invalid` | Token wrong, expired, reused or for another surface | Reset the widget, show "Verification failed, try again" |
| `captcha_unavailable` | External provider unreachable; the server switched to ALTCHA | Fetch the config again (now `altcha`), render it, resubmit |
| `form_rejected` | Honeypot filled or the form was sent too fast | Generic "Something went wrong, try again" |

Order inside a route:
1. `withApiSecurity` (rate limit, origin)
2. zod parse
3. honeypot and form token
4. `verifyCaptcha`
5. database work and password hashing

**As implemented** (`guardCaptchaSurface` / `guardSignInCaptcha` in
`lib/captcha/guard.ts`):
- A request that needs a challenge and carries **no** `captchaToken` gets
  `captcha_required` before the form token is looked at — that is the
  first contact of a client that has not rendered the widget yet (the
  lobby's automatic guest creation).
- With a token, a missing, forged, too-early (< 2 s), too-old (> 2 h) or
  other-surface `formToken` is `form_rejected`. When the surface is off,
  the form token is not checked at all (an API client has none, so it
  could not stop a bot, and an old tab must not be refused for a stale
  one); the honeypot always is.
- **A form token is single use** (changed after review): it is marked
  used (Redis `SET NX`, TTL = its remaining lifetime, key
  `lf:<env>:captcha:form-used:<sha256>`) once the whole check passed — not
  when the challenge fails, so a failed attempt can be retried with the
  same one. A reused token is `form_rejected`; the client fetches a new
  config. Without Redis in production: `captcha_unavailable` (fail closed,
  like the ALTCHA replay marker).
- `verifyCaptcha` results: `missing` → `captcha_required`; `invalid`,
  `expired`, `duplicate` → `captcha_invalid`; `unavailable` and
  `misconfigured` → `captcha_unavailable`. On the sign-in routes a
  challenge that cannot run at all (`misconfigured`: no session secret)
  does not block the sign-in — the account and address limits still apply.
- `register`: official hub → challenge (`register`) → account. Otherwise
  the registration mode is read first (closed → 403, no challenge), then
  the challenge with the invite rule of §2, then invite / policy checks,
  hashing and the account.
- `guest`: the cookie / revocation check and the access policy
  (`authorizeGuestRegistration`, a read) run first — no challenge where
  guests cannot get in — then the new-guest bucket is **checked without
  counting** (a full bucket is refused before a solved token is spent),
  then the challenge, then the bucket is counted, then the user row.
- `login` / `desktop-session`: the guard runs after the zod parse and
  **before** the attempt is counted (`beginSignInAttempt`), so a request
  refused for a missing challenge costs the account nothing. Only a request
  with a usable device entry looks the account up first (trusted device,
  §2).
- A client that gets `captcha_unavailable` twice in a row while already
  rendering ALTCHA should show an error, not retry: that means ALTCHA's
  replay store (Redis) is down in production.

## 5. Server verification (`apps/web/lib/captcha/`)

The entry point is `verifyCaptcha({ surface, token, provider, req })`. It
returns one of these results:
- `ok`
- `missing`, `invalid`, `expired` or `duplicate` → `captcha_invalid` (or
  `captcha_required` when the token is missing)
- `unavailable` → `captcha_unavailable`
- `misconfigured`

How each provider is checked:
- **ALTCHA:** `altcha-lib` verifySolution, the expiry, the surface in the
  salt, and replay protection. Replay is blocked with Redis `SET NX`, keyed
  by sha256(token), with a TTL equal to the remaining lifetime. In
  production, a missing Redis fails closed.

  **As implemented:** the surface is the signed `parameters.data.surface`
  (v2, see §4.2), and the replay key is
  `lf:<env>:captcha:altcha-used:<sha256(challenge signature)>`, not
  sha256(token): the token is base64 JSON, so the same solution re-encoded
  (other key order, extra spaces) would hash differently and slip past a
  token-hash key. The HMAC signature is unique per challenge and cannot be
  forged, so the challenge is usable exactly once. Outside production (no
  Redis by default) the marker is kept in memory.
- **Turnstile:** POST to `https://challenges.cloudflare.com/turnstile/v0/siteverify`
  with secret, response, remoteip and idempotency_key. The server checks
  `success`, that `hostname` equals the app host, and that `action` equals
  the surface.
- **reCAPTCHA:** POST to `https://www.google.com/recaptcha/api/siteverify`.
  The server checks `success` and `hostname`. For v3 it also checks `action`
  equals the surface and `score >= recaptchaMinScore`. Check the current
  Google Cloud docs: keys created in Google Cloud still answer siteverify.

Network rules for the external providers:
- 3 s timeout, one retry.
- Use the existing pinned-HTTPS helper where it fits.
- Never log tokens or the secret.

**As implemented** (`lib/captcha/providers.ts`):
- Form-encoded POST over `lib/ip-pinned-https.ts` (DNS resolved and
  checked once, the connection pinned to those addresses, no redirects),
  3 s for the whole attempt — the DNS lookup included — and one retry after
  a network error, a 5xx or a non-JSON answer. Turnstile gets the same `idempotency_key` on the retry.
- `remoteip` is sent only when the app can tell clients apart
  (`LOBBYFORGE_TRUSTED_PROXY`).
- The expected hostnames are the request's host plus the hosts of
  `LOBBYFORGE_APP_ORIGIN` and `NEXT_PUBLIC_BASE_URL` (the origin guard's
  set).
- Error codes: `invalid-input-secret` / `missing-input-secret` → bad secret
  (see the breaker); `timeout-or-duplicate` → `duplicate`;
  `internal-error` → `unavailable`; anything else → `invalid`.
- The providers' published **test secrets** answer for a fixed hostname
  (`example.com`, `testkey.google.com`) without an action, so with a test
  secret the hostname/action checks are skipped — the e2e test keys work.
  Doctor flags test keys in production.
- Google checks the token before the secret, so a dummy-token call cannot
  tell a bad reCAPTCHA secret from a good one (verified 2026-10-04): the
  probe and "Test configuration" only prove reachability for reCAPTCHA; a
  bad secret shows up on the first real verification. Turnstile's dummy
  call does detect it.
- reCAPTCHA keys over Google Cloud's free quota without billing "fail
  open" on siteverify (`success: true`, score 0.9). Nothing in the answer
  is reliable enough to detect this; the operator watches the Google Cloud
  console.

**Breaker:**
- An external provider's breaker opens after 3 consecutive network or 5xx
  failures, **or** when a cached reachability probe fails.
- The probe is a siteverify call with a dummy token, run at most once per
  60 s, lazily from §4.1. A normal "invalid token" answer counts as
  reachable.
- While the breaker is open (5 min, held in Redis with a memory fallback):
  - §4.1 serves `altcha`;
  - ALTCHA tokens are accepted;
  - `misconfigured` (no keys, or the secret can't be decrypted) behaves the
    same.
- Otherwise **only tokens from the configured provider are accepted.** A bot
  cannot pick the weaker path.

**As implemented** (`lib/captcha/breaker.ts`, `lib/captcha/verify.ts`):
- A refused secret also opens the breaker (reason `bad_secret`) — but
  **only when the dummy-token probe says so** (Turnstile: only the real
  secret gets a normal answer to it). An `invalid-input-secret` answer to a
  **real** verification never opens it by itself (changed after review): a
  token minted with someone else's key can draw that answer, and an
  attacker could otherwise keep the instance on the ALTCHA fallback. That
  token is refused (`captcha_invalid`), the event is recorded for a day
  (`lf:<env>:captcha:bad-secret-seen:<provider>`), and for Turnstile the
  probe is asked to confirm. For reCAPTCHA (whose probe cannot tell) the
  recorded event is what Doctor reports (`captcha_siteverify`).
- Consecutive failures are remembered for 10 minutes; any usable answer
  resets them. Saving new provider settings or keys resets both breakers.
- The probe runs at most once per 60 s per provider **and secret** (a
  Redis `SET NX` elects the process); its last result is kept for Doctor.
- While ALTCHA stands in, a token that claims the configured external
  provider gets `unavailable` (the client re-fetches the config); a token
  from any other provider gets `invalid`.

## 6. UI contract

- **`<CaptchaChallenge surface=… onToken=… />`** (client component):
  - loads its config from §4.1;
  - renders ALTCHA (the `altcha` web component, pinned exact version), the
    Turnstile explicit-render script or the reCAPTCHA script;
  - loads external scripts lazily, with the page nonce;
  - follows the theme (light/dark) and the locale (en/tr strings for
    ALTCHA's labels);
  - re-renders on `captcha_unavailable`.
- **Pages:**
  - `/login`: email sign-in shows the widget after `captcha_required`; the
    guest button uses the guest surface;
  - `/register`;
  - `/join/[code]` (invite sign-up and guest);
  - `/connect/demo`.
- **Automatic guest creation** in the lobby voice provider and the room
  page must handle `captcha_required`:
  - show the challenge in a small dialog, or send the user to `/login` with
    a return URL;
  - never loop silently, and never leave a dead button.
- **Honeypot:**
  - a visually hidden `website` input (`tabIndex={-1}`,
    `autoComplete="off"`, `aria-hidden` on its wrapper);
  - `formToken` goes along with the form.
- **Admin → Settings → Authentication → new "Bot protection" card:**
  - provider choice (Off / ALTCHA built-in, recommended / Turnstile /
    reCAPTCHA);
  - site key and secret, write-only with a hint;
  - the provider options and the four surfaces;
  - the login threshold;
  - the attack-mode switch, with the automatic state and when it ends;
  - "Test configuration": the server does a dummy siteverify and reports
    reachable / bad secret / bad hostname;
  - environment-locked fields read "Set by LOBBYFORGE_…".
- **Privacy dialog:** choosing an external provider opens a dialog that
  explains the data transfer. It gives a ready paragraph to copy for the
  privacy notice (en/tr). The ALTCHA sentence for the notice is "To stop
  bots, your browser does a small calculation locally; no data is sent to a
  third party."

### 6.1 Admin API

All three endpoints are instance-admin only. A `PUT` is audited as
`instance.captcha_updated`, with field names only, never secrets. If the
codebase's admin routes live under a different prefix, follow it and update
this section.

`GET /api/admin/captcha` returns:

```json
{
  "provider": "altcha",
  "surfaces": { "register": "on", "invite_register": "off", "guest": "on", "login": "adaptive" },
  "siteKey": null,
  "secretSet": false,
  "secretHint": null,
  "options": {
    "altchaDifficulty": "normal",
    "turnstileAppearance": "interaction-only",
    "recaptchaVersion": "v3",
    "recaptchaMinScore": 0.5,
    "loginFailureThreshold": 3
  },
  "attackMode": { "manual": false, "autoUntil": null },
  "locked": { "provider": false, "siteKey": false, "secretKey": false },
  "breaker": { "open": false, "until": null }
}
```

- `options` always comes back with the defaults filled in.
- `autoUntil` and `until` are ISO timestamps or null.

`PUT /api/admin/captcha` takes
`{ provider, surfaces, siteKey?, secretKey?, options, attackMode: boolean }`.
- `secretKey` is a string to set a new secret, `null` to clear it, or
  omitted to keep the current one.
- It returns the GET shape.
- Errors:
  - 400 `{ error: "invalid_settings", issues }`;
  - 400 `{ error: "keys_required" }` when an external provider is chosen
    without both keys;
  - 409 `{ error: "locked_by_env", field }`.

`POST /api/admin/captcha/test` takes `{ provider?, siteKey?, secretKey? }`.
Values that are left out fall back to the saved ones. It returns
`{ result: "ok" | "bad_secret" | "unreachable" | "missing_keys" | "not_applicable", detail? }`.
`not_applicable` is the answer for `none` and `altcha`.

**As implemented** (`lib/captcha/admin.ts`; the routes use
`requireInstanceAdmin`, like every `/api/admin` route — the owner's
session or the emergency admin token):
- The prefix is `/api/admin/captcha` as specified.
- `PUT`: `siteKey: ""` means `null`; `secretKey: ""` means "keep" (an
  empty write-only field). `issues` is `[{ path, message }]` — never the
  submitted values. A locked field is a 409 only when the value would
  **change** (sending the environment's value back is fine); the locked
  value is not written. Environment keys count for `keys_required`. A
  stored secret that cannot be decrypted still counts as set (enter a new
  one to fix it). Body limit 4 KiB; rate limits 30 / min (GET), 10 / min
  (PUT, test).
- Audit: written only when something changed, `metadata: { fields: [...] }`
  with the names among `provider`, `surfaces`, `siteKey`, `secretKey`,
  `options`, `attackMode` (making an option's default explicit is no
  change). It is filed under the instance's first server (so it shows in
  Admin → Audit, category "System"), `targetType: "instance"`, actor = the
  owner's account (null for the emergency token). Label and summary:
  `admin.audit.action.instance.captcha_updated`,
  `admin.audit.event.captchaUpdated` (en, tr).
- `PUT` when the stored row cannot be read: 503
  `{ "error": "settings_unavailable" }` — never a save against the defaults
  that stand in for it.
- `test`: nothing is stored and no breaker moves. `detail` is a **code**
  the admin card translates (changed after review — it was an English
  sentence), exactly one of:

  | `detail` | with `result` | meaning |
  |---|---|---|
  | `missing_both` | `missing_keys` | neither a site key nor a secret key (given or saved) |
  | `missing_site_key` | `missing_keys` | no site key |
  | `missing_secret_key` | `missing_keys` | no secret key |
  | `secret_undecryptable` | `missing_keys` | a site key, but the saved secret cannot be decrypted (the session secret changed) — enter it again |
  | `test_keys` | `ok` | the provider's public test keys: every challenge passes, not for production |
  | `recaptcha_reachability_only` | `ok` | Google answered, but it only checks the secret together with a real token (§5) |

  `detail` is absent otherwise. A dummy token carries no hostname, so a site key used on
  the wrong domain cannot be detected here: it shows up as
  `captcha_invalid` on real sign-ups (the provider's dashboard lists the
  allowed hostnames).

## 7. Phase 0 (no captcha needed)

- **New guests get their own rate limit:** 10 per hour per client address.
  It is separate from the refresh bucket, which stays as it is.
- **Attack mode:**
  - an instance-wide failed-sign-in counter;
  - over 50 failures in 10 minutes turns attack mode on automatically for
    30 minutes, and the admin can also turn it on by hand;
  - while it is on, every sign-in without a valid device cookie needs the
    challenge.
- **Minimum fill time:**
  - `formToken` = HMAC(issuedAt, surface);
  - a form sent less than 2 s or more than 2 h after issue gets
    `form_rejected`.
- **Honeypot:** see §6.

**As implemented** (`lib/captcha/signals.ts`, `lib/captcha/form.ts`):
- New guests: 10 / hour per client address (`lib/captcha/limits.ts`,
  key `lf:<env>:rate-limit:captcha-guest-new:<hash>`). Checked without
  counting before the challenge, counted only when a new identity is about
  to be created, so the `captcha_required` round trip does not use up the
  budget. Over it: the usual 429. **When client addresses are unknown** (no
  `LOBBYFORGE_TRUSTED_PROXY`, every visitor is "unknown"), one
  instance-wide backstop of **200 / hour** replaces it — a 10 / hour bucket
  shared by everyone would be a one-client denial of service and break a
  LAN party. The challenge (600 / min) and config (1 200 / min) endpoints
  get the same treatment.
- A "failed sign-in" is a wrong email/password answer (401) from
  `/api/auth/login` or `/api/auth/desktop-session`.
- The **client address** signal of adaptive sign-in counts those failures
  per address over 15 min (the auth-throttle window) and uses the same
  `loginFailureThreshold`. It only applies when the app can tell clients
  apart (`LOBBYFORGE_TRUSTED_PROXY` set); without it every visitor is
  "unknown" and one bucket would challenge everyone — attack mode covers
  that case.
- The **account** signal reads the auth-throttle sign-in counter without
  counting (`peekSignInAttempts`): attempts since the last success, for
  known and unknown emails alike (no enumeration).
- Attack mode: more than 50 failures in a fixed 10-minute window turns it
  on for 30 minutes (it then ends on its own; continued failures turn it on
  again). Manual switch: `captcha_attack_mode`.
- Keys: `lf:<env>:rate-limit:captcha-address-failures:<hash>`,
  `…:captcha-signin-failures`, `…:captcha-attack-until` (so the documented
  e2e reset of `*rate-limit*` clears them); the breaker, probe and replay
  markers live under `lf:<env>:captcha:*`. Redis in production (or with
  `LOBBYFORGE_RATE_LIMIT_STORE=redis`), in memory otherwise.
- `formToken` format: `<issuedAt ms>.<surface>.<base64url HMAC>` (key info
  `lobbyforge:captcha-form-token:v1`). The client must wait 2 s after the
  config arrived before sending — ALTCHA can solve faster than that.

## 8. Doctor checks

- An external provider is selected but a key is missing.
- The secret can't be decrypted.
- Siteverify reports a bad secret.
- Cloudflare or Google test keys are in use in production.
- Redis is unavailable (ALTCHA replay protection).

**As implemented** (`lib/captcha/doctor.ts`, category `services`):
`captcha_keys` (warning), `captcha_secret` (warning), `captcha_siteverify`
(warning: bad secret or unreachable, from the probe's cached result — at
most 60 s old, else one probe — or a `bad_secret` breaker),
`captcha_test_keys` (warning, production only), `captcha_replay_store`
(critical, production only: challenge-protected sign-ups and new guests
are refused), `captcha_env` (unknown `LOBBYFORGE_CAPTCHA_PROVIDER`),
`captcha_settings` (row unreadable). When nothing is wrong, one info line
`captcha` names the provider (and an open breaker).

Also `secure_origin` (`lib/doctor.ts`, category `network`): a declared
public origin (`NEXT_PUBLIC_BASE_URL`, `LOBBYFORGE_APP_ORIGIN`) on plain
`http://` whose host is not localhost. **Critical** while ALTCHA is the
active provider (configured, or standing in for an external one): its
proof of work needs Web Crypto, which browsers only give a secure context
(HTTPS or localhost), so every sign-up falls back to the slow
pure-JavaScript solver (see the upgrade note in §3.2). A warning
otherwise — microphone and camera need a secure context too.

`captcha_siteverify` for reCAPTCHA also reports an "invalid secret" answer
to a real verification in the last day (its dummy-token probe cannot detect
a bad secret); for Turnstile only the probe counts (§5).

## 9. CSP

- ALTCHA needs no new origin. Prefer the widget build whose worker loads
  from `'self'`; if a `blob:` worker can't be avoided, add
  `worker-src 'self' blob:`.
- External providers' origins are added on **every page** (HTML document
  responses), and only when that provider is active:
  - Turnstile: `https://challenges.cloudflare.com` (script-src, frame-src);
  - reCAPTCHA: `https://www.google.com/recaptcha/`,
    `https://www.gstatic.com/recaptcha/` (script-src, frame-src).
- `style-src` already allows `'unsafe-inline'`.

**Why every page, not only the widget pages** (changed after the first
draft): a client-side navigation (`next/link` — `/home` → `/login`, or
`/lobby` opening the guest dialog) does not load a new document, so the
browser keeps enforcing the CSP of the page the visit **started** on. With
the origins only on the widget pages, the widget was blocked whenever it
was reached that way, although its own page's response would have allowed
it. When the provider is `altcha` or `none`, nothing is added anywhere.

**As implemented** (`apps/web/middleware.ts`, `lib/captcha/csp.ts`):
- reCAPTCHA follows Google's published list: script-src
  `https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/`,
  frame-src `https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/`,
  connect-src `https://www.google.com/recaptcha/`.
- "Pages" = every path the middleware sees except `/api/*`, `/_next/*` and
  paths ending in a file name (`/icon.svg`, `/manifest.webmanifest`); the
  matcher already skips `_next/static`, `_next/image` and the root files.
  API routes and static files never look the provider up.
- "Active" = the configured provider is external **and** both keys are in
  place (decryptable). While its breaker is open the origins stay (harmless:
  the page renders ALTCHA then).
- **How the middleware knows the provider:** in Next 16 a `middleware.ts`
  still defaults to the Edge runtime (only the new `proxy.ts` is Node-only),
  and Edge cannot reach Postgres or share memory with the route handlers.
  The middleware now declares `config.runtime = 'nodejs'` (stable since
  Next 15.5) and, on page requests, reads the same per-process settings
  cache the routes use (`resolveCaptchaSettings`, on `globalThis`, 5 s
  TTL).
  - **A value younger than 5 s** is used as is.
  - **An older value** gets one refresh, capped at 300 ms and shared by all
    readers. Without that, the first page after a provider change saved in
    another process would still carry the old policy, while the config API
    already names the new provider, and the widget would be blocked.
  - **When the refresh misses the cap** (slow or hung database), the page
    goes out with the last known value, and for 5 s pages stop waiting and
    only refresh in the background. A failed read is cached for 3 s and
    logged at most once a minute.
  - **The first lookup of a process** has no last known value and waits up
    to 750 ms. Past that, pages use the environment override (or no
    external origin, which fails closed) under the same 5 s backoff.
  - **After a save:** the admin API invalidates the cache in its own
    process; other processes pick the change up on their first page after
    the 5 s TTL.
- ALTCHA: the UI loads the widget's `external` build and registers
  same-origin `PBKDF2/SHA-*` and `SHA-*` workers bundled by Next, so no
  `blob:` worker and no `worker-src` change is needed.

## 10. Tests

- **Unit:**
  - every provider adapter with mocked fetch;
  - an ALTCHA round trip with `altcha-lib`'s solver;
  - replay, expiry, surface mismatch;
  - the breaker;
  - secret encryption;
  - every protected route's new branches.
- **Component:** the widget states, and the admin card.
- **e2e:**
  - ALTCHA in a real browser on sign-up and new guest;
  - adaptive sign-in;
  - Turnstile with Cloudflare's test keys (always pass / always fail).
  
  The shared e2e helpers solve ALTCHA in Node, so the other specs keep
  working with protection on.
