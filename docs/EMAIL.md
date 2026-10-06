# Email: providers, verification, email change and password reset

Status: **implemented** (server and UI). This is the operator guide and
the contract the code follows. The research and the decisions behind it are
in `EMAIL_VERIFICATION_RESEARCH_2026-10.md`. Notes marked **As implemented**
record where the code settled a detail the first draft left open, or
changed it. Keep this file accurate when the code changes.

Code (server): `apps/web/lib/mail/` (types, providers, host rules,
settings, transport, classify, templates, send, stats, limits, tokens,
verification, change, admin, doctor, disposable), `apps/web/lib/secret-box.ts`,
the routes under `app/api/auth/email`, `app/api/auth/password/{forgot,reset}`,
`app/api/admin/mail` and `app/api/admin/users/[id]/verify-email`, migration
`packages/db/drizzle/0046_email.sql` and `packages/db/src/queries/email.ts`.

## 1. Scope

**In scope:**
- One mail layer with a provider registry: the two professional choices,
  the free tiers, custom SMTP, and mailpit in development.
- Email verification with three modes: `off`, `optional` and `required`.
- Email change.
- Password reset.
- An admin screen, Doctor checks, and the e2e setup with mailpit.

**Out of scope, later:**
- bounce and complaint webhooks;
- per-server verification levels;
- HTTP API transports. The registry is built so that adding one is a new
  `transport` entry, not a rewrite.

Nothing changes for an existing install until an admin configures mail:
- the default mode is `off`, with no mail transport;
- password reset then shows "ask your administrator".

## 2. One structure for every provider (`apps/web/lib/mail/`)

### 2.1 Transport interface

```ts
interface MailTransport {
  readonly kind: 'smtp'; // later: 'ses-api', 'resend-api', ...
  send(message: OutgoingMail): Promise<SendResult>;
  verify(): Promise<VerifyResult>; // connect + auth, no message (used by the test button)
}
```

- The only implementation in v1 is SMTP, through nodemailer `10.0.11`
  (exact pin, already in `apps/web/package.json`).
- One pooled transport per configuration, cached on `globalThis` and keyed
  by a hash of the settings. It is rebuilt when the settings change.
- Connection timeout 10 s, greeting 10 s, socket 20 s.
- `disableFileAccess` and `disableUrlAccess` are on.
- Every address passes zod validation before nodemailer sees it.

**As implemented** (`lib/mail/transport.ts`):
- The host passes the §3.4 rules and is resolved **once**; nodemailer
  connects to an allowed address (IPv4 first) with the host name as the TLS
  server name, so the certificate is still checked against the name and a
  DNS answer that changes afterwards cannot redirect the connection.
  Certificate verification is always on, minimum TLS 1.2.
- The pooled transport (2 connections, 50 messages each) is also rebuilt
  every 10 minutes, so the host is resolved and checked again; a replaced
  one is closed 30 s later. The admin test uses a fresh unpooled transport.
- `MailTransport` also has `close()`. `send` answers
  `{ ok: true, messageId }` or `{ ok: false, result, detail?, permanent }`
  (the §5 codes; `permanent` = a 5xx reply).
- nodemailer is pinned at `10.0.11` in `apps/web/package.json`. Every
  GitHub advisory against nodemailer is fixed at or below 10.0.9 (the latest,
  GHSA-g57g-f23g-4646, in 10.0.9), so 10.0.11 carries them all. It was the
  newest release at least a week old when added, a supply-chain margin.
  Dependabot proposes later versions.

### 2.2 Provider registry (pure data, importable from client code, no secrets)

`lib/mail/providers.ts` exports `MAIL_PROVIDERS: MailProviderPreset[]`:

```ts
interface MailProviderPreset {
  id: MailProviderId;               // 'ses' | 'scaleway' | 'brevo' | 'smtp2go' | 'resend' | 'mailjet' | 'mailgun' | 'gmail' | 'custom' | 'mailpit'
  tier: 'professional' | 'free' | 'custom' | 'development';
  transport: 'smtp';
  regions?: { id: string; host: string }[];      // SES regions, Mailgun US/EU
  host?: string;                                  // fixed host when there are no regions
  ports: { port: number; security: 'tls' | 'starttls' }[]; // first = recommended
  usernameHint: string;                           // message key, e.g. "SMTP username from the SES console" / "the literal 'resend'"
  passwordHint: string;                           // message key
  freeTier?: { perDay?: number; perMonth?: number; noteKey?: string };
  pricingNoteKey?: string;
  docsUrl: string;                                // the provider's SMTP setup page
  dataRegionNoteKey?: string;                     // EU option, KVKK note
}
```

**Presets.** Verify every host and port against the provider's CURRENT
docs before coding; the research table is the starting point.
- **professional:**
  - `ses`: regions, with `eu-central-1` first; host
    `email-smtp.<region>.amazonaws.com`; 587/2587 STARTTLS, 465/2465 TLS.
  - `scaleway`: Scaleway TEM, `smtp.tem.scaleway.com`; 587/2587 STARTTLS,
    465/2465 TLS. The username is the project id and the password is the
    API secret key.
- **free:**
  - `brevo`: 300/day.
  - `smtp2go`: 1,000/month; port 2525 first.
  - `resend`: 3,000/month, 100/day; the username is literally `resend`.
  - `mailjet`: 6,000/month and 200/day, with their logo in the email.
  - `mailgun`: 100/day; US or EU region.
  - `gmail`: 500/day, needs an app password; for testing and small closed
    groups.
- **custom:** any host and port.
- **development:** `mailpit`, `localhost:19525` in the dev stack and
  `mailpit:1025` inside compose, no TLS. Offered only when
  `NODE_ENV !== 'production'`, or when the host is the compose service
  name. Never offered on the official hub.

Adding a provider later means appending one entry, plus its message keys.
The admin UI renders from the registry.

**As implemented** (`lib/mail/providers.ts`, keys in
`messages/<locale>/mailProviders.json`):
- Two fields were added: `name` (the brand name, shown as is) and
  `crossBorder` (a hosted relay outside Türkiye: the screen shows the KVKK
  note; false for `custom` and `mailpit`). `ports[].security` can be `none`
  for the development preset only.
- Ports are listed only where §3.4 allows them; providers' extra ports (80,
  443, 588, 8025, 8465) are left out on purpose.
- **The development preset (changed after e2e):** it is offered on EVERY
  instance that is not the official hub, labelled Development (its tier), and
  never on the hub — where the admin PUT refuses it (`invalid_settings`,
  issue `provider: not_offered`). "Only outside production" hid it from a
  production-mode compose stack although that stack runs mailpit as a
  service. What it fills depends on where the app runs:
  `offeredMailProviders({ production, official })` / `getMailProvider` hand
  out `localhost:19525` outside production (the dev host) and
  `MAILPIT_COMPOSE_PRESET` — `mailpit:1025`, no TLS — in a production build
  (inside compose; `localhost` there is the app container, and production
  refuses loopback anyway). The host rules (§3.4) accept exactly that pair in
  production, so what is offered is what a save accepts.

Verified on 2026-10-04 against each provider's own documentation:

| Preset | Host | Ports (recommended first) | User name / password | Free tier | Source |
|---|---|---|---|---|---|
| `ses` | `email-smtp.<region>.amazonaws.com`; regions eu-central-1 (default), eu-west-1, eu-west-2, eu-west-3, eu-north-1, us-east-1, us-east-2, us-west-1, us-west-2 (eu-south-1 and eu-central-2 have no SMTP endpoint) | 587, 2587 STARTTLS; 465, 2465 TLS (25 left out: throttled on EC2, blocked on most VPS) | SMTP credentials from the SES console (an IAM user's key id and a derived SMTP password — not the AWS access key); per region | none fixed (credit-based free plan; sandbox 200/day) | <https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html>, <https://docs.aws.amazon.com/general/latest/gr/ses.html>, <https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html> |
| `scaleway` | `smtp.tem.scaleway.com` | 587, 2587 STARTTLS; 465, 2465 TLS | project ID / IAM API secret key | 300/month per organization | <https://www.scaleway.com/en/docs/transactional-email/reference-content/smtp-configuration/> |
| `brevo` | `smtp-relay.brevo.com` | 587, 2525 STARTTLS; 465 TLS | the SMTP login (`…@smtp-brevo.com`) / an SMTP key (not the API key) | 300/day | <https://developers.brevo.com/docs/smtp-integration> |
| `smtp2go` | regions: global `mail.smtp2go.com` (default), `mail-eu.smtp2go.com`, `mail-us.smtp2go.com`, `mail-au.smtp2go.com` | 2525 (their recommendation), 587, 25 STARTTLS; 465 TLS | an SMTP user created under Sending → SMTP Users / its password | 1,000/month, 200/day, 25/hour until the domain is verified | <https://developers.smtp2go.com/docs/smtp-relay>, <https://www.smtp2go.com/faq/> |
| `resend` | `smtp.resend.com` | 587, 2587 STARTTLS; 465, 2465 TLS; 25 | the literal `resend` / an API key | 3,000/month, 100/day | <https://resend.com/docs/send-with-smtp>, <https://resend.com/pricing> |
| `mailjet` | `in-v3.mailjet.com` | 587, 2525 STARTTLS; 465 TLS; 25 | API key / secret key | 6,000/month, 200/day, Mailjet logo | <https://dev.mailjet.com/smtp-relay/configuration/>, <https://www.mailjet.com/pricing/> |
| `mailgun` | regions: us `smtp.mailgun.org` (default), eu `smtp.eu.mailgun.org` | 587 (their recommendation), 2525 STARTTLS; 465 TLS; 25 | the domain's SMTP login (e.g. `postmaster@mg.example.org`) / its SMTP password; API-created domains need SMTP credentials added by hand | 100/day | <https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp> |
| `gmail` | `smtp.gmail.com` | 587 STARTTLS; 465 TLS | the full Gmail address / an app password (needs 2-Step Verification) | ~500/day | <https://developers.google.com/workspace/gmail/imap/imap-smtp>, <https://support.google.com/accounts/answer/185833>, <https://support.google.com/mail/answer/22839> |
| `custom` | any | 587, 465, 2525, 2587, 2465, 25 | whatever the server needs (may be empty) | — | this file |
| `mailpit` | `localhost` (dev host) — `mailpit` inside compose | 19525, 1025, no TLS | none | — | <https://mailpit.axllent.org/docs/> |

Not first-party: Brevo's `@smtp-brevo.com` login format and 300/day, and
SMTP2GO's daily and hourly caps, came from the providers' help-centre
search snippets (those pages refuse automated fetches). Resend's EU sending
region keeps account data in the US.

### 2.3 Sending

The entry point is `sendMail({ to, template, locale, vars })`.
- **Templates:**
  - `verify`: code plus link;
  - `change-confirm`: sent to the new address;
  - `change-notice`: sent to the old address;
  - `reset`: code plus link;
  - `test`.
- **Content:** plain text plus simple HTML, built from `messages/{en,tr}/email.json`
  in the recipient's `users.locale`, falling back to the instance default.
  No remote images, no tracking. The code is never in the subject line.
- **Sign-up never blocks on mail.** It returns at once and the send happens
  without waiting. Failures are logged (no addresses in logs, or masked)
  and counted for Doctor.
- **Daily limit:** an optional instance-wide `mailDailyLimit`. Doctor warns
  at 80%, and at 100% sends are refused with `mail_quota`.

**As implemented** (`lib/mail/send.ts`, `templates.ts`, `stats.ts`):
- **Language.** `users.locale` is never written by the UI yet (it is `en`
  for nearly everyone), so an email the recipient asked for (sign-up,
  resend, change, forgot password) is written in their saved `users.locale`
  when it is an explicit choice (anything but the default `en`), else in the
  language of the request — the `lf_locale` cookie, then Accept-Language,
  then `LOBBYFORGE_DEFAULT_LOCALE`, then English — the same order the pages
  use. The admin test uses the instance default.
- **Links** are built from `LOBBYFORGE_APP_ORIGIN`, else
  `NEXT_PUBLIC_BASE_URL` — never from the request's Host header. With
  neither configured the email carries the code only.
- **Minimal data:** no display name in any email; the `change-notice` shows
  the new address masked (`n***@example.org`).
- Headers: `Auto-Submitted: auto-generated`, `Content-Language`.
- The user routes answer `202` and send in the background too
  (`dispatchMail`); they check `mail_unavailable` / `mail_quota` first, so
  those still come back synchronously.
- The daily count is per UTC day (`lf:<env>:mail:sent:<YYYY-MM-DD>`, in
  Redis in production). Counting fails open: a Redis outage does not stop
  verification emails (the provider's own limit is the backstop). Test sends
  count too. Failures are counted for Doctor (`lf:<env>:mail:failures`,
  `…:auth-failures`, `…:last-failure`, 24 h), logged with the address
  masked and never with the server's reply text.

## 3. Configuration

### 3.1 Migration 0046 (`email`)

**`users`:** add `email_verified_at timestamptz null`.
- Backfill it to `now()` for users whose Google identity link has
  `email_verified = true`.

**New table `email_tokens`:**
- `id uuid pk`
- `user_id uuid fk → users on delete cascade`
- `purpose text check in ('verify','change','reset')`
- `target_email text`
- `token_hash bytea`: sha256 of 32 random bytes
- `code_hash bytea`: HMAC-SHA256 of the 6-digit code, keyed by HKDF(session
  secret, `lobbyforge:email-code:v1`), with the token id mixed in
- `code_attempts int default 0`
- `expires_at timestamptz`: the link
- `code_expires_at timestamptz`
- `consumed_at timestamptz null`
- `created_at timestamptz default now()`

Indexes on `token_hash`, and on `(user_id, purpose)`, which is unique while
the token is not consumed.

**`instance_settings` columns:**

| Column | Default |
|---|---|
| `mail_provider` text (registry id or `none`) | `none` |
| `mail_region` text | null |
| `smtp_host`, `smtp_port int`, `smtp_security` (`tls`/`starttls`/`none`), `smtp_username` | null |
| `smtp_password_encrypted` | null |
| `mail_from` (e.g. `LobbyForge <no-reply@example.org>`) | null |
| `mail_daily_limit int` | null |
| `mail_last_test_at`, `mail_last_test_result` | null |
| `email_verification_mode` (`off`/`optional`/`required`) | `off` |
| `email_verification_scope` jsonb | `{"open_register":true,"invite_register":false}` |
| `email_verification_enforced_since` timestamptz | null (set when the mode first becomes `required`) |
| `email_verification_existing_deadline` timestamptz | null (optional: existing accounts must verify by then) |
| `disposable_email_block` boolean | false |
| `disposable_email_overrides` jsonb | `{"allow":[],"block":[]}` |

**As implemented** (`0046_email.sql`, expand-only and idempotent; CI runs
`email.integration.test.ts` against real Postgres):
- `email_tokens.target_email` is `NOT NULL`. The token-hash index is
  **unique** (`email_tokens_token_hash_unique`); the live-row index is
  `email_tokens_user_purpose_active_unique … WHERE consumed_at IS NULL`.
- CHECK backstops (SQL only, like 0045): the password is only ever stored as
  `v1.<iv>.<ct>.<tag>`; `token_hash` and `code_hash` are 32 bytes;
  `purpose`, `smtp_security` and the mode are enums; `mail_provider` and
  `mail_region` are slugs (`^[a-z0-9-]{1,32}$`, not an enum — adding a
  provider must not need a migration); port 1–65535; daily limit
  1–10,000,000; the JSON columns are objects.
- Two more columns than the table above (review): `users.signup_channel`
  (`open` | `invite` | `oauth` | `setup`, null for accounts that predate
  0046; see §4.2) and `instance_settings.mail_last_test_fingerprint` (see
  §5). The register route sets `open`/`invite` (every hub sign-up is
  `open`), a Google sign-up `oauth`, `/setup` `setup`.
- The Google backfill marks an account only when its address IS the
  verified Google address (`users.email = lower(link.provider_email)`) —
  Google sign-ups have no address, so in practice it marks accounts that
  share one with their Google link — and touches only rows still `NULL`
  (re-running it changes nothing).
- Queries: `getInstanceMailSettings` / `setInstanceMailSettings` (partial),
  `recordInstanceMailTest` (with the tested fingerprint; does not touch
  `updated_at`), `ensureEmailVerificationEnforcedSince` (set once), and in
  `queries/email.ts` the challenge functions (`replaceEmailToken` serialized
  by an advisory lock, `reserveEmailCodeAttempt` — §4.1 — and
  `applyEmailVerification` / `applyEmailChange` / `applyPasswordReset`, each
  the conditional UPDATE plus its action in one transaction) and the account
  helpers (`getUserEmailState`, `markUserEmailVerified`,
  `markUserEmailVerifiedForAddress`, `changeUserEmailDirect`,
  `revokeEmailChallenges`, `listUserEmailVerification`, …).
- **Stale challenges die with the write that makes them stale, in the same
  transaction:** every password write — a reset (`applyPasswordReset`) and
  a password change in the settings (`replaceUserPasswordHash`) — drops
  the account's live `change` and `reset` challenges, so a change started
  by someone who knew the old password cannot be confirmed after the owner
  took the account back; an address change (`applyEmailChange`) drops the
  live `reset` and `verify` challenges sent to the old address, and a
  direct change (`changeUserEmailDirect`) drops every live challenge. There
  is no separate "sign out everywhere" action (the sessions list revokes one
  session at a time); a password change is that action.

### 3.2 Environment overrides

These win over the database, and the admin UI shows them as locked:
- `LOBBYFORGE_MAIL_PROVIDER`
- `LOBBYFORGE_SMTP_HOST`, `LOBBYFORGE_SMTP_PORT`, `LOBBYFORGE_SMTP_SECURITY`
- `LOBBYFORGE_SMTP_USER`, `LOBBYFORGE_SMTP_PASSWORD`
- `LOBBYFORGE_MAIL_FROM`
- `LOBBYFORGE_EMAIL_VERIFICATION`: `off` is the emergency switch

When `LOBBYFORGE_SMTP_HOST` is set without a provider, the provider counts
as `custom`.

**As implemented** (`lib/mail/settings.ts`):
- An empty value counts as unset; an invalid one is ignored, logged once,
  and Doctor warns (`mail_env`). An environment value is never copied into
  the database (a PUT that sends the locked value back is fine; a different
  one is 409). The provider is locked when either `LOBBYFORGE_MAIL_PROVIDER`
  or `LOBBYFORGE_SMTP_HOST` is set.
- Missing pieces come from the preset: the host from the region (or the
  first region), the port from the recommended one, the security from the
  preset's port (465/2465 → `tls`, else `starttls`).
- Cached per process for 5 s on `globalThis`; an admin save invalidates it.
  When the row cannot be read: no transport, verification as the environment
  says or `off` (so restrictions fail **open** — the restricted actions need
  the database anyway), cached 3 s, logged at most once a minute.
- `email_verification_enforced_since` is also recorded the first time the
  ENVIRONMENT makes the mode `required` (one conditional UPDATE when the
  settings are read), so `LOBBYFORGE_EMAIL_VERIFICATION=required` (the
  official hub) restricts accounts created from that moment on.

### 3.3 Secrets

- Extract the CAPTCHA secret code into `apps/web/lib/secret-box.ts`:
  AES-256-GCM, HKDF from the session secret, a purpose label, and the
  `v1.<iv>.<ct>.<tag>` format.
- CAPTCHA keeps its label (`lobbyforge:captcha-secret:v1`), so existing
  ciphertexts still decrypt; a test proves it.
- SMTP uses `lobbyforge:smtp-secret:v1`.
- The password never goes back to a browser. The API returns only
  `passwordSet` and `passwordHint`.

**As implemented:** each purpose has its own HKDF `info` AND its own AES-GCM
associated data (the column it lives in), so a ciphertext never opens under
another purpose: `CAPTCHA_SECRET_BOX` (info `lobbyforge:captcha-secret:v1`,
AAD `lobbyforge:instance_settings.captcha_secret_encrypted` — both unchanged)
and `SMTP_SECRET_BOX` (`lobbyforge:smtp-secret:v1`,
`lobbyforge:instance_settings.smtp_password_encrypted`).
`lib/__tests__/secret-box.test.ts` decrypts a ciphertext produced by the
pre-extraction CAPTCHA code.

### 3.4 SMTP host rules (SSRF)

- Allowed ports: 25, 465, 587, 2465, 2525, 2587, plus 1025 for
  mailpit/development.
- Refuse link-local and metadata addresses (169.254.0.0/16, fd00:ec2::254),
  checked on the resolved addresses.
- Refuse loopback and private ranges in production, unless the host is the
  compose service name `mailpit` and the instance is not official. Use the
  existing IP helpers.
- TLS certificate verification cannot be turned off. `none` security is
  allowed only for localhost or mailpit.

**As implemented** (`lib/mail/host-rules.ts`): the development ports are
1025 **and 19525** (the dev stack publishes mailpit's 1025 on the host as
19525, which is what `localhost` reaches) — both only outside production;
in production 1025 only for the host `mailpit` on an instance that is not
the official hub. Link-local is 169.254.0.0/16 and fe80::/10 (and their
IPv4-mapped forms) plus fd00:ec2::254; a name that does not resolve is
`connection` / `host_not_found`. The admin PUT runs the checks that need no
DNS (`staticSmtpTargetRefusal`); every connection and the test run the full
check on the resolved addresses.

## 4. Verification

### 4.1 Rules

- **Who gets a verification email:** in `optional` and `required` modes, a
  sign-up in scope (`open_register`, and/or `invite_register`). A verify
  token is created and the `verify` email sent.
- **Link:** `<app origin>/verify-email?t=<token>`.
  - GET only shows a confirmation page with a button. It never uses up the
    token, because security scanners open links.
  - The button POSTs, and that consumes the token.
  - The page sends `Referrer-Policy: no-referrer`.
  - The link never signs anyone in.
- **Code:** 6 digits, valid 15 minutes, at most 5 wrong attempts. The link
  is valid 24 hours. A new send invalidates the previous token.
- **Consuming a token** is one conditional `UPDATE … WHERE consumed_at IS
  NULL AND expires_at > now()`. Compare with `timingSafeEqual`.
- **Accounts that count as verified:** guests have no email and are never
  restricted. A Google sign-in with `email_verified=true` sets
  `email_verified_at`. A successful password reset also verifies.
- **Admin:** can mark a user verified (audited as `user.email_verified_by_admin`).

**As implemented** (`lib/mail/tokens.ts`):
- The link token is 32 random bytes, base64url (43 characters) in the
  link; only `sha256(bytes)` is stored and looked up. The code HMAC input is
  `<row id>:<code>`.
- Validity: link 24 h (verify, change) / 60 min (reset); code 15 min; 5
  attempts per code (the link still works after that).
- **An attempt is reserved before the code is compared:** every code
  submission first runs one conditional UPDATE —
  `code_attempts = code_attempts + 1 WHERE … code_attempts < 5 AND
  consumed_at IS NULL AND code_expires_at > now() AND expires_at > now()` —
  and only a submission that got a row compares (in constant time). So
  however many guesses arrive at once, at most 5 are ever compared
  (proven against real Postgres with 12 concurrent reservations). The
  submission that uses the fifth attempt with a wrong code answers
  `too_many_attempts`; a right code on the fifth attempt still works (the
  consuming UPDATE accepts a count AT the cap, never over it).
- A reset challenge works only while the account's address is still the one
  it was sent to (the reset UPDATE carries `users.email = target_email`;
  otherwise nothing changes).
- The `change-confirm` link points to `/verify-email?t=…` too: the page's
  `POST /api/auth/email/verify` accepts a CHANGE token and applies the
  change (answer `{ "verified": true, "changed": true }`).
  `POST /api/auth/email/change/confirm` accepts the same token.
- A verification for an address the account no longer has is consumed and
  verifies nothing (`invalid_token`).
- Expired and consumed challenges older than a day are deleted at most once
  an hour per process, on the next send.

### 4.2 What an unverified account may do

**`optional`:** everything, plus a banner.

**`required`:** the account is restricted only if all of these hold:
- it was created after `enforced_since`, or `existing_deadline` has passed;
- it is not the owner or an instance admin;
- it is not a guest.

Restricted accounts can still sign in, read, change settings and profile,
change email and delete the account. They cannot:
- send messages, DMs or reactions;
- get a voice token;
- create servers, channels or invites;
- upload files;
- create bots, bot tokens or webhooks;
- on the hub: publish plugins or list a community.

**Enforcement:**
- One helper on the server, `requireVerifiedEmail(user, action)`, refuses
  with 403 `{ "error": "email_unverified" }`.
- Apply it in every route for the actions above. Grep for each; don't miss
  the bot, webhook and upload routes.

**`required` safety:**
- The mode cannot be saved unless a transport is configured AND the last
  test succeeded. This is checked on the server and in the UI.
- If mail later breaks, sign-up still works and Doctor goes critical.

**As implemented** (`lib/mail/verification.ts`, gate placement):
- Signature: `requireVerifiedEmail(user: string | { id }, action)`, where
  `action` is one of `message`, `dm`, `reaction`, `voice`, `server_create`,
  `channel_create`, `invite_create`, `upload`, `bot_create`, `bot_token`,
  `webhook`, `plugin_publish`, `directory_listing`. Outside `required` it
  answers from the cached settings without touching the database; if the
  check itself fails it lets the request through (logged).
- "Owner or instance admin": the instance's only admin is the owner
  (`instance_settings.owner_user_id`). When the owner cannot be looked up,
  nobody is restricted (fail open, like unreadable settings).
- **Scope applies to the restriction too** (review, product decision): an
  account is restricted only when its sign-up channel is in the
  verification scope — `open` follows `open_register`, `invite` follows
  `invite_register` (default off: an invite is already a gate, like
  CAPTCHA's `invite_register`), `oauth` and `setup` never. An account
  with no channel (created before 0046) is covered by the
  `enforced_since` / existing-deadline rules as before. An out-of-scope
  account is not restricted even after the existing-accounts deadline.
- **`enforced_since` is set once** — the first time the mode is `required`
  — and never moves. Switching `required` off and on again later keeps the
  original timestamp, so accounts created in between (while the mode was
  `off` or `optional`) count as created after it and are restricted again
  when `required` comes back. GET `/api/admin/mail` returns
  `verification.enforcedSince`, so the screen can warn before re-enabling.
- Where it runs (each with a test in
  `lib/mail/__tests__/restriction-coverage.test.ts`, which also pins the list):

  | Action | Routes |
  |---|---|
  | `message` | `POST /api/servers/{id}/channels/{channelId}/messages`; `PATCH …/messages/{messageId}` when it changes the text (pinning is not gated); `POST …/commands/{commandId}/invoke` (it posts into the channel) |
  | `dm` | `POST /api/dm`, `POST /api/dm/{channelId}/messages` |
  | `reaction` | no HTTP route adds reactions — they travel over the LiveKit data channel, which needs a voice token, so the `voice` gate covers them |
  | `voice` | `POST /api/livekit/token` |
  | `server_create` | `POST /api/servers` (the hub) |
  | `channel_create` | `POST /api/servers/{id}/channels` |
  | `invite_create` | `POST /api/servers/{id}/invites` |
  | `upload` | `POST /api/users/me/avatar`; `POST /api/users/me/banner` and `POST /api/servers/{id}/banner` when they carry an image (the only upload routes) |
  | `bot_create` | `POST /api/servers/{id}/bots`, `PUT /api/servers/{id}/bots/builtin/{type}` |
  | `bot_token` | `POST /api/servers/{id}/bots/{botId}/token` |
  | `webhook` | `POST /api/servers/{id}/channels/{channelId}/webhooks`, `POST …/webhooks/{webhookId}/token` |
  | `plugin_publish` | `POST /api/marketplace/submit` |
  | `directory_listing` | `GET /api/directory/register/challenge`, `POST /api/directory/register` |
  | `join_request` | `POST /api/servers/{id}/join-requests/mine` when it carries a note (free text sent to the moderators); asking to join without one is not gated |

  Not gated: the Bot API and a bot's event endpoint (bot tokens, no
  account), the admin instance logo (owner only), activity (game) actions
  and renames (display name, nickname, server/channel names by those who may
  manage them) — they are bounded or moderated text, not new channels.
- **Uploads policy:** a restricted account cannot upload avatar or banner
  images — an image upload is an abuse channel (anything can be put in
  front of every member who sees the profile or the server). Text profile
  edits (display name, status, bio, nickname) stay allowed, and so does
  **removing** a banner (`POST …/banner` with `dataUrl: null`, or
  `DELETE /api/servers/{id}/banner`), so a restricted account can always
  take an image down. The UI follows the same policy: the upload controls
  are disabled for a restricted account, the text fields and "Remove
  banner" are not.
- **Switching to `required`:** 409 `test_required` applies when the mode
  CHANGES to `required` (from `off`/`optional`) unless the last recorded
  test passed for EXACTLY the configuration that would be in force (its
  fingerprint, §5) AND is less than 24 hours old
  (`REQUIRED_TEST_MAX_AGE_MS` in `lib/mail/types.ts`): credentials revoked at
  the provider since an old test must not unlock it. The admin screen says
  so ("staleTest"). While the resulting mode is `required` (saved, or from
  the environment), every save must leave a working transport: provider
  `none`, an undecryptable password or a missing piece is 409
  `transport_required`. Once `required`, the connection can still be
  changed to another working one (to fix broken mail); the last test then no
  longer describes it, and Doctor warns until a new test passes.

### 4.3 HTTP API (user side; the session is required unless noted)

- **`GET /api/auth/email/status`** returns
  `{ email, verified, mode, restricted, pendingChange: string|null, resendAvailableAt: ISO|null, mailConfigured }`.
- **`POST /api/auth/email/verify/send`** takes `{}` and returns 202
  `{ sent: true, resendAvailableAt }`. Errors:
  - 409 `already_verified`;
  - 429 `rate_limited` with `retryAfter`;
  - 503 `mail_unavailable` or `mail_quota`.
- **`POST /api/auth/email/verify`** takes `{ code }` (session) or
  `{ token }` (no session needed) and returns 200 `{ verified: true }`.
  Errors are 400: `invalid_code`, `expired`, `too_many_attempts` or
  `invalid_token`.
- **`POST /api/auth/email/change`** takes `{ newEmail, currentPassword }`.
  - In `off` mode with no transport, it changes the address directly and
    returns 200 `{ changed: true }`.
  - Otherwise it sends `change-confirm` to the new address and returns 202
    `{ pending: true }`.
  - Errors: 400 `invalid_password` or `invalid_email`; 409 `email_taken`;
    the same 429 and 503 as above.
- **`POST /api/auth/email/change/confirm`** takes `{ code }` or
  `{ token }`.
  - The address must still be free when the change is applied; otherwise
    409 `email_taken`.
  - Applying it sets `email_verified_at = now()`, sends `change-notice` to
    the old address, and revokes the other sessions.
- **`POST /api/auth/password/forgot`** has no session. It takes
  `{ email, captchaToken?, captchaProvider?, formToken?, website? }`.
  - It always answers 202 `{ sent: true }`, with the same body and roughly
    the same time whether or not the account exists.
  - The new CAPTCHA surface `password_reset` (default `on`; add it to
    `lib/captcha` surfaces, the admin card and `docs/CAPTCHA.md`) applies
    first.
  - With no transport it answers 503 `mail_unavailable`, so the UI can say
    "ask your administrator". That leaks only that mail is off, which is
    public anyway.
- **`POST /api/auth/password/reset`** has no session. It takes
  `{ token, newPassword }` or `{ email, code, newPassword }`.
  - The link is valid 60 minutes.
  - On success it sets the password (same policy as sign-up), marks the
    email verified, revokes ALL sessions and device cookies (the existing
    password-change machinery), and returns 200.
- **Pages:**
  - `/verify-email` (token confirmation);
  - `/forgot-password`;
  - `/reset-password?t=…`;
  - a code entry where the banner lives;
  - a settings section for email change.
  
  All of them use `Referrer-Policy: no-referrer`.

**As implemented** (the routes; every error body is `{ "error": code }`):
- Every route answers 400 `invalid_request` for a malformed body (the
  schemas are `.strict()`); a missing session is the usual 401.
- `status`: built by `emailStatusFor(userId, { user?, settings? })`
  (`lib/mail/status.ts`) — the ONE builder of this answer; the route and
  the page-render read `lib/email-status-ssr.ts` (`emailStatusForPage`,
  for the banner's first paint; it shows nothing to guests and answers
  `undefined` when it cannot tell) both return it, so they cannot drift.
  It answers null for a missing or deleted account (the route then 401s).
  `resendAvailableAt` is null when the limit store cannot be read.
  `email` is null for a guest; `pendingChange` is the address of a
  live change challenge; `resendAvailableAt` comes from the send limits
  (§4.4); `mailConfigured` is false when no transport is usable.
- `verify/send`: also 400 `no_email` (a guest or an account without an
  address).
- `verify` with `{ code }` on an already verified account answers 200
  `{ verified: true }`. A code whose challenge was consumed in between
  answers `expired`.
- `change`: also 400 `invalid_email` for the account's current address and
  400 `disposable_email` (when blocked). The current-password check shares
  the password change's per-account counter: over it, the generic 429
  `{ error: "Rate limit exceeded", retryAfter, resetAt }`. In `off` mode
  with a transport the change goes through confirmation (202) too; only
  `off` with no usable transport changes it directly (and clears
  `email_verified_at`, drops every live challenge and revokes the other
  sessions, like a confirmed change — `warning: "sessions_not_revoked"` if
  that fails). The sends share the verification limits (§4.4).
- `change/confirm`: 200 `{ changed: true, email }`. The other sessions are
  revoked; the confirming session survives when it is the account's own,
  so a link opened in another browser signs every session out.
  `warning: "sessions_not_revoked"` is added when the revocation failed (the
  change still applied).
- `forgot`: 400 `invalid_email` for a malformed address. The order is: zod
  → 503 `mail_unavailable` / `mail_quota` (both instance-wide facts) → the
  per-address send limit peeked → the CAPTCHA surface `password_reset` → the
  limit counted → 202. The account lookup, the per-target cap and the send
  run AFTER the answer, and every accepted request takes at least 250 ms, so
  neither the body nor the timing says whether the address exists. Guests
  and deleted accounts get nothing (same answer).
- `reset`: 400 `weak_password` below 12 characters (the sign-up policy; at
  most 128). **By code, every failure is the same 400 `invalid_code`** — a
  wrong, used-up or expired code, an unknown or guest account, an address
  that changed since the code was sent — and the attempts count in a budget
  of their own keyed by the address typed (`RESET_CODE_ATTEMPTS`, 10 / 15
  min, counted before the account is looked up, never shared with verify or
  change), so nothing tells one address from another. By link: 400
  `invalid_token` / `expired`. 200 `{ reset: true }` (+ `warning: "sessions_not_revoked"`).
  Besides revoking every session (none kept) it drops pending desktop
  handoff codes and clears the sign-in lock of the address; device cookies
  die with the old password hash. It never signs in.
- `POST /api/auth/register` (both deployment modes): 400 `disposable_email`
  before the challenge when blocked; when a verification email was started
  the 201 body also has `verificationEmailSent: true` (absent otherwise, so
  the old shape is unchanged).
- The Google callback marks the account verified on every sign-in where
  Google says `email_verified` AND the Google address is the account's
  address (`markUserEmailVerifiedForAddress`; a Google sign-up has no
  address, so it is never marked) (best effort; it never fails the sign-in).
- `Referrer-Policy: no-referrer` on the pages is the pages' (UI) concern.

### 4.4 Rate limits

Redis-backed, in the `auth-throttle` pattern. Behind an unknown address
(no trusted proxy), use an instance-wide backstop, as in
`lib/captcha/limits.ts`.

| What | Limit |
|---|---|
| Verification or change email, per account | 60 s cooldown; 5/hour; 10/day — each kind its own buckets (see below) |
| Same target address, across accounts | 3/hour |
| Sends per address | 10 / 15 min |
| Code attempts | 5 per code; 10 per account per 15 min |
| Token POSTs per address | 10/min |
| Forgot-password per target email | 3/hour (silently, keeping the same 202) |

**As implemented** (`lib/mail/limits.ts`): the send buckets (the account's
cooldown, hour and day, and the target's hour) are taken ATOMICALLY with
`reserveWindows` — one Redis script (one synchronous step in memory) that
counts a hit in every bucket or, when any is full, in none — so a burst of
concurrent sends gets exactly one through (tested). The routes still peek
the cooldown first, only so a client inside it hears 429 before any other
answer. Fixed windows in the
bot-protection store (Redis in production), keys
`lf:<env>:rate-limit:email-<name>:<sha256>` (accounts and addresses only
hashed; the documented e2e reset clears them). **Change emails have their
own per-account buckets** (`change-cooldown`, `change-hour`,
`change-day`: the same 60 s / 5 per hour / 10 per day) separate from the
verification email's (changed after e2e: fixing a typo right after sign-up
must not wait out the verification cooldown); the per-target bucket (3 an
hour) stays SHARED by both kinds — it protects the recipient's inbox. Each
send still takes all its buckets in one atomic step. "Sends per address"
covers verify/send, change and forgot. "Token POSTs" covers every code or
token submission (verify, change/confirm, reset). Code attempts per account
over the limit → 429 `rate_limited` (the reset route keys an unknown
address's attempts by the address). Without a trusted proxy the per-address
buckets become instance-wide backstops: 300 sends / 15 min and 600
submissions / min. Redis down in production → 429 `rate_limited` with
`retryAfter: 5` (fail closed).

### 4.5 Disposable domains

- Vendor the CC0 list `disposable-email-domains/disposable-email-domains`
  (`disposable_email_blocklist.conf`) as a data file, with a header saying
  where it came from and when.
- Add `scripts/update-disposable-domains.mjs` to refresh it.
- Subdomains match. Admin overrides go on top: allow wins over block.
- When `disposable_email_block` is on, sign-up and email change refuse
  with 400 `disposable_email`.

**As implemented:** the data file is
`apps/web/lib/mail/disposable-domains.json` — a JSON object whose header
fields (`source` pinned to the upstream commit, `commit`, `fetchedAt`,
`license: CC0-1.0`, `count`, `_comment`) say where it came from, then
`domains` (sorted, de-duplicated; 9,203 on 2026-10-04). Refresh with
`node scripts/update-disposable-domains.mjs` (or `--ref <sha>`; `--check`
validates the file; it refuses to write fewer than 1,000 domains). Matching
is by label: `x.mailinator.com` matches `mailinator.com`, `xmailinator.com`
does not. The admin lists are normalised (lower case, no `@` or trailing
dot) and may hold up to 1,000 domains each.

## 5. Admin (instance admin only; changes audited, never secrets)

**`GET /api/admin/mail`** returns:

```json
{
  "provider": "none", "region": null, "host": null, "port": null, "security": null,
  "username": null, "passwordSet": false, "passwordHint": null, "from": null,
  "dailyLimit": null, "sentToday": 0,
  "lastTest": { "at": null, "result": null },
  "verification": { "mode": "off", "scope": { "open_register": true, "invite_register": false },
                    "enforcedSince": null, "existingDeadline": null },
  "disposable": { "block": false, "allow": [], "blockExtra": [] },
  "locked": { "provider": false, "host": false, "port": false, "security": false,
              "username": false, "password": false, "from": false, "verification": false }
}
```

**`PUT /api/admin/mail`** takes the same shape without the read-only
fields. `password` is a string to set, `null` to clear, or omitted to keep.
Errors:
- 400 `invalid_settings` with `issues`;
- 400 `host_not_allowed`;
- 400 `password_required`: the save moves the connection (provider, host or
  user) while a password is set, without the password (added after review);
- 409 `locked_by_env` with `field` (also `field: "password"` when an
  environment password would follow a new host);
- 409 `test_required`: setting `required` without a passing test;
- 409 `transport_required`: the resulting mode is `required` but the
  resulting configuration is not a working transport (added after review);
- 503 `settings_unavailable`.

**`POST /api/admin/mail/test`** takes `{ to?: string, ...unsaved overrides }`.
- Errors (added after review): 400 `password_required` — the tested
  connection differs from the saved one and authenticates, but no
  `password` came with it (the saved one is never sent elsewhere); 409
  `locked_by_env` with `field` — an override of an environment-locked field.
- It sends the `test` template; the default recipient is the admin's own
  address.
- It records `mail_last_test_*` only when it ran against the SAVED
  configuration.
- It returns `{ result, detail? }`:
  - `result` is one of `ok`, `timeout`, `tls`, `auth`, `sender_rejected`,
    `recipient_rejected`, `connection`, `host_not_allowed` or
    `not_configured`;
  - `detail` is a code, never free text. For example, `try_port_2525`
    after a timeout on 25, 465 or 587.

**`POST /api/admin/users/{id}/verify-email`** marks the user verified and
writes an audit entry.

**Members list:** the admin members list shows the verification state.

**As implemented** (`lib/mail/admin.ts`; the routes use
`requireInstanceAdmin` — the owner's session or the emergency admin token):
- `PUT`: `password: ""` means keep (an empty write-only field); `""` in the
  other text fields means `null`. `issues` is `[{ path, message }]`, never
  the submitted values. A locked field is a 409 only when the value would
  CHANGE. `host_not_allowed` carries `detail` (`port_not_allowed`,
  `address_not_allowed`, `security_not_allowed`, `invalid_host`). With a
  provider set, the effective `from` is required and must parse
  (`Name <addr>` or `addr`) — `invalid_settings` on `from`; an unknown
  region is `invalid_settings` on `region`; a list entry that is not a
  domain is `invalid_settings` on `disposable.allow.<i>` /
  `disposable.blockExtra.<i>`. Body limit 64 KiB; rate limits 30 / min
  (GET), 10 / min (PUT, test, per address).
- **The password stays where it was saved** (review): a PUT that moves the
  connection to another provider, host or user — and still authenticates —
  while a password is set needs `password` in the same request: 400
  `{ "error": "password_required" }`; with the password from the environment
  it is 409 `{ "error": "locked_by_env", "field": "password" }` (set
  `LOBBYFORGE_SMTP_HOST`, `_USER` and the provider in the environment too).
  Port and security changes alone, a move to provider `none` and clearing
  the password need nothing; moving from `none` to a host does (parking the
  transport cannot launder the stored password).
- 409 `{ "error": "transport_required" }`: the resulting mode is `required`
  but the resulting configuration is not a working transport (§4.2).
- The last test is recorded with an HMAC **fingerprint** of the
  configuration it tested (provider, host, port, security, user, password,
  from — key derived from the session secret, so the stored value gives no
  offline handle on the password). It counts — for `required`, in the GET
  view's `lastTest` and for Doctor — only while the configuration in force
  has that fingerprint; otherwise `lastTest` reads `{ at: null, result:
  null }`. A test that started before a save records the fingerprint of
  what it tested, so it can never unlock `required` for the new settings.
  `enforcedSince` is set the first time the saved mode is `required`.
- Audit: `instance.mail_updated`, `metadata: { fields }` with names among
  `provider`, `region`, `host`, `port`, `security`, `username`, `password`,
  `from`, `dailyLimit`, `verificationMode`, `verificationScope`,
  `existingDeadline`, `disposableBlock`, `disposableAllow`,
  `disposableBlockExtra` — written only when something changed, filed under
  the first server like the CAPTCHA settings. Labels:
  `admin.audit.action.instance.mail_updated`,
  `admin.audit.event.mailUpdated`, `admin.audit.mailField.*` (en, tr).
- `PUT` when the stored row cannot be read: 503 `settings_unavailable`.
- `test` takes `{ to?, provider?, region?, host?, port?, security?,
  username?, password?, from? }`: it connects and authenticates
  (`verify()`), then sends; any override makes it an unsaved test (not
  recorded). **The saved (or environment) password is used only for the
  saved provider, host, port, security and user:** testing another
  connection needs `password` in the request (a string, or `null` to test
  without authentication) — 400 `{ "error": "password_required" }` when the
  tested connection has a user and no password was given. Overriding an
  environment-locked field (a different value; any `password` when it is
  locked) is 409 `{ "error": "locked_by_env", "field" }`. The detail codes:

  | `result` | `detail` |
  |---|---|
  | `timeout` | `try_port_2525` / `try_port_2587` (after 25, 465 or 587; whichever the provider offers) |
  | `tls` | `use_starttls` (implicit TLS on a STARTTLS port), `use_tls` (the reverse), `tls_certificate` |
  | `auth` | `check_credentials`, `gmail_app_password` |
  | `sender_rejected` | `sender_domain` (MAIL FROM refused), `message_rejected` (refused after DATA) |
  | `recipient_rejected` | — |
  | `connection` | `host_not_found`, `connection_refused`, or none |
  | `host_not_allowed` | `port_not_allowed`, `address_not_allowed`, `security_not_allowed`, `invalid_host` |
  | `not_configured` | `missing_host`, `missing_port`, `missing_from`, `missing_recipient` (no `to` and no admin address — the emergency token), `password_undecryptable` |

- `verify-email`: 200 `{ verified: true }` (also when it already was —
  nothing written, no audit), 400 `no_email` (guest / no address), 404
  `not_found`. The audit entry targets the user.
- Members list: the admin members page reads
  `listUserEmailVerification(db, userIds)` — `{ userId, hasEmail, isGuest,
  emailVerifiedAt }`, never the addresses — and shows verified /
  unverified / none, with a "mark verified" action calling the endpoint
  above.

### 5.1 Admin screen

Admin → Settings → **Email**, a new page or section:
- The provider picker is grouped: Professional (SES, Scaleway), Free (with
  their limits shown), Custom, and Development (mailpit) when available.
- Choosing a preset fills host, port and security, and shows the username
  and password hints, the free-tier limits, the data-region/KVKK note and
  a docs link.
- **Fields:**
  - region where applicable;
  - "from" address;
  - password, write-only with a hint;
  - daily limit;
  - the test button, which shows the classified result and hint;
  - verification mode, which disables `required` until a test passes;
  - scope;
  - existing-accounts deadline;
  - disposable-domain block, with allow and block lists.
- Environment-locked fields read "Set by LOBBYFORGE_…".
- Choosing a provider outside Türkiye shows a short KVKK note: the data
  leaves the country, so the privacy notice should name the provider.
- en/tr.

## 6. Doctor

- **Critical:**
  - `required` without a transport;
  - the password can't be decrypted.
- **Warning:**
  - the last test failed;
  - recent send failures or auth failures;
  - the daily limit is above 80%.
- **Hint:**
  - port 25 is chosen ("blocked on most VPS");
  - the "from" domain has no SPF TXT or `_dmarc` record (DNS lookup with a
    timeout);
  - a Gmail preset is used in production.

**As implemented** (`lib/mail/doctor.ts`, category `services`):
`mail_transport` and `mail_password` (critical), `mail_last_test` (warning:
failed, or `required` with settings not tested since they changed),
`mail_send_failures` (warning: failures in the last 24 h, auth failures
counted separately; **critical** in `required` mode while nothing has gone
out since the last failure — a successful send or test is remembered for 7
days in `lf:<env>:mail:last-success`), `mail_daily_limit` (warning from 80%), `mail_env` and
`mail_settings` (warning), and the hints `mail_port_25`, `mail_dns` and
`mail_gmail` — a hint is `ok: false` at level `info`, so it shows without
making the report unhealthy. The DNS lookups (2 s timeout) are skipped for
local hosts and mailpit; a lookup that fails (timeout, SERVFAIL) is not
reported as a missing record. When nothing is wrong, one info line `mail`
names the provider and the mode.

## 7. Official hub

The hub is configured by env, with no code special-casing beyond the
defaults:
- `LOBBYFORGE_EMAIL_VERIFICATION=required`;
- SES `eu-central-1`;
- the disposable-domain block on.

Setting up the AWS account and the DNS records is the owner's task. Write
the checklist in this file.

### 7.1 Checklist: mail for lobbyforge.org (owner)

**AWS account and SES** (region `eu-central-1`, Frankfurt):
1. Use (or create) the AWS account on a **paid account plan**; the free
   account plan restricts services. Set a billing alarm (e.g. $10/month) and
   turn on MFA for the root user.
2. SES → **Account dashboard**: since 21 July 2026 new accounts start on
   the **Essentials** plan ($0.16 / 1,000). Cancel it to return to
   pay-as-you-go ($0.10 / 1,000) — for an account put on Essentials by
   default, the first cancellation takes effect at once.
3. SES → **Identities** → create the domain identity `lobbyforge.org` with
   **Easy DKIM** (RSA 2048) and a custom **MAIL FROM** domain
   (`bounce.lobbyforge.org`).
4. Add the records SES shows to Cloudflare DNS (DNS only, not proxied):
   - the three DKIM `CNAME` records (`<token>._domainkey.lobbyforge.org`);
   - for the MAIL FROM domain: `MX bounce.lobbyforge.org →
     feedback-smtp.eu-central-1.amazonses.com` (priority 10) and
     `TXT bounce.lobbyforge.org "v=spf1 include:amazonses.com ~all"`;
   - SPF on the apex if mail is sent as `@lobbyforge.org` from elsewhere
     too: merge `include:amazonses.com` into the existing record (one SPF
     record per name);
   - `TXT _dmarc.lobbyforge.org "v=DMARC1; p=none; rua=mailto:dmarc@lobbyforge.org; adkim=r; aspf=r"`.
   Wait until SES shows the identity and DKIM as **Verified**.
5. SES → **SMTP settings** → **Create SMTP credentials** (creates an IAM
   user limited to `ses:SendRawEmail`). Store the SMTP user name and
   password in the password manager; the password is shown once. These are
   NOT the IAM access keys, and they work in `eu-central-1` only.
6. **Production access** (the account starts in the sandbox: verified
   recipients only, 200/day): SES → Account dashboard → Request production
   access. Mail type **Transactional**; website `https://lobbyforge.org`;
   describe the use (sign-up verification codes, email change, password
   reset — no marketing; users request every email themselves; bounces and
   complaints are handled by the SES feedback and the account suppression
   list). The first answer usually comes within 24 h.
7. Bounces and complaints: keep **email feedback forwarding** on (the
   default) to a monitored address, and the **account-level suppression
   list** on for bounces and complaints. (SNS → webhook is a later phase.)
   Watch the reputation dashboard: review starts at a 5% bounce / 0.1%
   complaint rate. Gmail sends no complaint data to SES — register the
   domain in **Google Postmaster Tools**.

**The hub's environment** (`.env.prod` on the hub server):

```
LOBBYFORGE_MAIL_PROVIDER=ses
LOBBYFORGE_SMTP_HOST=email-smtp.eu-central-1.amazonaws.com
LOBBYFORGE_SMTP_PORT=587            # 2587 if the host blocks 587
LOBBYFORGE_SMTP_SECURITY=starttls
LOBBYFORGE_SMTP_USER=<SES SMTP user name>
LOBBYFORGE_SMTP_PASSWORD=<SES SMTP password>
LOBBYFORGE_MAIL_FROM="LobbyForge <no-reply@lobbyforge.org>"
LOBBYFORGE_EMAIL_VERIFICATION=required
LOBBYFORGE_APP_ORIGIN=https://lobbyforge.org
```

Then, in Admin → Settings → Email (the env fields show as locked): turn on
**disposable address blocking** (the one hub default that is not an env
variable), send a **test email**, and check Admin → Health: no `mail_*`
warning, `mail_dns` silent. The verification mode is `required` from the
first boot with these variables; accounts created before that moment are
not restricted unless an existing-accounts deadline is set.

**After launch:** after two weeks of clean DMARC reports, raise DMARC to
`p=quarantine`. Check the sending quota SES granted (Account dashboard) before any
announcement, and ask for more in time. Fallback provider:
Scaleway TEM (`scaleway` preset) — switching is a change of the env
variables above plus its DKIM/SPF records.

## 8. Tests

- **Unit:**
  - the transport with a fake SMTP server or a mocked nodemailer;
  - registry integrity: every preset has a docs URL, ports and hints in
    en/tr;
  - the secret box (CAPTCHA ciphertext compatibility);
  - tokens and codes: expiry, attempts, single use, double-submit race;
  - restriction coverage: one test per protected action;
  - forgot-password: identical answers;
  - rate limits.
- **Real Postgres:** migration 0046 and its backfill, and the token
  consumption race.
- **e2e with mailpit:** the e2e stack gets `LOBBYFORGE_SMTP_HOST=mailpit`;
  Playwright reads mailpit's HTTP API. Cover:
  - sign-up → verify by code;
  - verify by link from a second browser;
  - the `required` restrictions;
  - change email;
  - forgot → reset;
  - the admin test email.

**As implemented** (server side; the e2e specs and the e2e compose
`LOBBYFORGE_SMTP_HOST=mailpit` wiring are not part of this change):
- `packages/db`: `email-migration.test.ts` (file, journal, snapshot) and
  `email.integration.test.ts` (real Postgres, in CI's real-PG step): the
  backfill, the settings and their CHECKs, one live challenge per user and
  purpose, the attempt cap, expiry, and the consumption race (8 concurrent
  submissions, exactly one wins; two changes racing for one address).
- `apps/web`: `lib/__tests__/secret-box.test.ts`; `lib/mail/__tests__/`
  — `providers` (registry integrity, hints in every complete language),
  `host-rules`, `transport` (nodemailer mocked: options, pool, error
  classification), `settings`, `templates-disposable`,
  `tokens-verification`, `limits-doctor-send`, `restriction-coverage`
  (one test per protected action); route suites
  `app/api/auth/email/__tests__/email-routes.test.ts`,
  `app/api/auth/password/__tests__/forgot-reset.test.ts` (identical forgot
  answers, double-submit), `app/api/admin/mail/__tests__/admin-mail.test.ts`,
  plus the Google callback and CAPTCHA admin suites.
