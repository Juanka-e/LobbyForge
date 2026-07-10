# Servers API — M10 / Phase 2

The `servers` API is the first Phase 2 surface. It gives an authenticated user
the ability to list, create, and read the Discord-like guilds ("servers") that
they own. M10 wires the API to the real Postgres schema; it does not yet
expose membership / channel / role / invite endpoints — those are scheduled
for the next Phase 2 milestones.

This document covers:
- The DB schema additions (just `users.guest_key` — see [`packages/db/src/schema.ts`](../packages/db/src/schema.ts))
- The query helpers ([`packages/db/src/queries/users.ts`](../packages/db/src/queries/users.ts), [`packages/db/src/queries/servers.ts`](../packages/db/src/queries/servers.ts))
- The DB singleton in the web app ([`apps/web/lib/db.ts`](../apps/web/lib/db.ts))
- The HTTP endpoints ([`apps/web/app/api/servers/route.ts`](../apps/web/app/api/servers/route.ts), [`apps/web/app/api/servers/[id]/route.ts`](../apps/web/app/api/servers/[id]/route.ts))
- How it composes with the M9 guest auth cookie

## Auth flow (recap)

All three endpoints require a valid `lf_guest` cookie (see [`docs/GUEST_AUTH.md`](GUEST_AUTH.md)). The cookie's `gid` is the stable per-session identity; the `uid` is the UUID of the materialized `users` row.

```
┌────────┐  POST /api/auth/guest   ┌──────────────┐  INSERT users    ┌─────────┐
│Browser ├────────────────────────▶│ auth/guest   ├─────────────────▶│ Postgres│
│        │  Set-Cookie: lf_guest   │ route        │  ON CONFLICT     │ users   │
│        │◀────────────────────────┤ (M9 + M10)   │  DO NOTHING      └─────────┘
└────────┘                         └──────────────┘
     │
     │  POST /api/servers
     │  Cookie: lf_guest
     ▼
┌──────────────┐  readGuestSession  ┌─────────┐
│ servers      ├───────────────────▶│ Cookie  │
│ route        │  uid from payload  │ payload │
│ (M10)        │◀───────────────────┤         │
│              │                    └─────────┘
│              │  createServer(db,  ┌─────────┐
│              ├───────────────────▶│ Postgres│
│              │   { ownerUserId }) │ servers  │
│              │                    │ + memberships │
└──────────────┘                    └─────────┘
```

The `uid` field is what makes M10 work: the cookie minted in M9 had no
materialized user record, so Phase 1 routes (`/api/auth/guest`,
`/api/livekit/token`) could work anonymously. Phase 2 routes — anything
that touches the `servers` or `memberships` table — refuse to run unless
the cookie carries a `uid`. The auth flow above materializes the user
in the same request that mints the cookie, so the very first call from a
fresh browser already has a `uid`.

## Endpoints

| Method | Path | Body | Description | Rate limit |
|---|---|---|---|---|
| `GET`  | `/api/servers`        | — | List servers the caller is a member of (owner rows included). | 60 / min |
| `POST` | `/api/servers`        | `{ name, slug?, isPublic?, defaultLocale? }` | Create a server. The caller is set as the owner and auto-added as a member. | 10 / min |
| `GET`  | `/api/servers/{id}`   | — | Fetch a single server. **Owner-only** in M10 (membership check is M11). | 60 / min |

All three are wrapped in `withApiSecurity(...)` from [`apps/web/lib/security-headers.ts`](../apps/web/lib/security-headers.ts), which adds the standard `X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy` headers, enforces the method allowlist with a `405 + Allow` response, and applies an in-process token-bucket rate limit (per-identifier, defaults to "servers-list" / "servers-create" / "servers-get-one").

### Common response shapes

```ts
// Server JSON (toJson in route.ts)
interface ServerJson {
  id: string;            // uuid
  name: string;          // 2..32 chars
  slug: string | null;   // kebab-case when present
  ownerUserId: string;   // uuid
  iconUrl: string | null;
  defaultLocale: string; // "en", "tr", …
  isPublic: boolean;
  createdAt: string;     // ISO-8601
  deletedAt: string | null;
}
```

### Status codes

| Code | When |
|---:|---|
| 200 | `GET /api/servers` and `GET /api/servers/{id}` (owner) success |
| 201 | `POST /api/servers` success |
| 400 | Malformed body / fails zod validation (name too short, slug invalid, etc.) |
| 401 | Cookie missing or signature invalid |
| 403 | `GET /api/servers/{id}` called by a non-owner |
| 404 | `GET /api/servers/{id}` for an unknown id |
| 500 | Drizzle threw (wrapped with a sanitized message — see "Error surfacing" below) |
| 503 | The cookie has a `gid` but no `uid` — usually means Postgres is down or the schema is not migrated. The body includes `howToFix: "Re-issue POST /api/auth/guest"` |

### `POST /api/servers` body

```ts
interface CreateServerBody {
  name: string;          // 2..32 chars (ServerNameSchema in @lobbyforge/core)
  slug?: string;         // kebab-case (SlugSchema), optional
  isPublic?: boolean;    // default false
  defaultLocale?: string; // 2..8 chars, default "en"
}
```

The first server a user creates is always allowed; the schema grants
ownership implicitly. The "subsequent creations need MANAGE_SERVER or
START_ACTIVITY" rule is documented in the route but not yet enforced —
the role system lands with M13.

### Error surfacing

Errors from Drizzle are caught at the route boundary and the `err.message`
is copied into the response body as `detail`. This is intentionally
verbose in dev (the same string ends up in the in-process logger). In a
real deployment, a future PR swaps this for a stable error code + a
sanitized message, and the full error is shipped to the audit-log table.

## DB schema delta (M10 only)

The only migration required for M10 is the addition of `users.guest_key`:

```ts
// packages/db/src/schema.ts (excerpt)
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  locale: text('locale').notNull().default('en'),
  isGuest: boolean('is_guest').notNull().default(false),
  // NEW in M10: a stable per-guest key, sourced from the cookie's gid.
  // Null for non-guest users; unique when present.
  guestKey: text('guest_key').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  guestKeyIdx: index('idx_users_guest_key').on(table.guestKey).where(sql`guest_key IS NOT NULL`),
}));
```

The `guestKey` index is partial (`WHERE guest_key IS NOT NULL`) because the
column is null for every real (non-guest) user; the partial index keeps
the unique-constraint lookup cheap even at large row counts.

The `servers` and `memberships` tables were already in the M3 schema — M10
just exercises them for the first time via the API.

## Query helpers

```ts
// packages/db/src/queries/users.ts
findOrCreateGuestUser(db, { guestKey, displayName, locale? })
  // Idempotent: insert with ON CONFLICT DO NOTHING, then select.
  // Returns the materialized UserRow (with a real uuid), or null if the
  // row was deleted between the conflict and the select.

getUserById(db, id)
softDeleteUser(db, id)
```

```ts
// packages/db/src/queries/servers.ts
createServer(db, { name, ownerUserId, slug?, defaultLocale?, isPublic? })
  // Inserts the server, then auto-inserts an owner membership in the
  // same call (so the server is visible in the owner's list immediately).

getServerById(db, id)            // excludes soft-deleted
listServersForUser(db, userId)   // joins memberships, orders by recency, limit 100
softDeleteServer(db, id)
```

The queries are intentionally thin: they take a `DbClient` as the first
argument, never read from `process.env`, and never cache anything. This
makes them trivially mockable in route-level tests and re-usable from
the desktop app or a future CLI.

## Web app DB singleton

[`apps/web/lib/db.ts`](../apps/web/lib/db.ts) holds a single Drizzle client
per Node process. The instance is stashed on `globalThis` so it survives
Next.js's hot-reload re-imports (the same trick Prisma's docs recommend).
A test-only `__setDbForTests(client)` hook lets route tests swap in a
mock without going through the real connection string.

```ts
import { getDb } from '@/lib/db';
import { createServer } from '@lobbyforge/db';

const row = await createServer(getDb(), { name, ownerUserId });
```

If `DATABASE_URL` is missing, `getDb()` throws at first call — fail-loud
at startup, not on the first DB-touching request.

## Testing

`apps/web/app/api/servers/__tests__/servers.test.ts` covers the three
endpoints with `vi.mock` for `@lobbyforge/db` and `@/lib/security-headers`:

| Scenario | Expected status |
|---|---:|
| `POST` without cookie | 401 |
| `POST` with a cookie whose `uid` is `null` | 503 |
| `POST` with a name below the 2-char minimum | 400 |
| `POST` happy path | 201, `createServer` called with the caller's `uid` |
| `GET` happy path | 200, server list passed through unchanged |
| `GET` without cookie | 401 |
| `GET /{id}` for an unknown id | 404 |
| `GET /{id}` for a non-owner | 403 |
| `GET /{id}` for the owner | 200 |

The tests use a real signed `lf_guest` cookie (built via
`buildGuestSessionCookie` from `@/lib/guest-session`) so the route's
`readGuestSession` sees the same code path it does in production.

## Out of scope (deferred to later milestones)

- **Membership queries.** `listServersForUser` joins the `memberships` table, but there is no `GET /api/servers/{id}/members` yet. M11.
- **Channel / role / invite endpoints.** M11 + M12 (channels: M11 done; messages: M12 done) per the roadmap. Roles land with M13.
- **Official/self-host creation split.** `POST /api/servers` is enabled only
  when `LOBBYFORGE_DEPLOYMENT_MODE=official`. Self-host deployments fail closed
  and provision their initial instance through the installer/bootstrap flow.
- **Audit logging.** The route catches errors and returns 500, but doesn't write to the audit log. The shape is in the `withApiSecurity` wrapper, the table lands with M14.
- **Rate limiting.** Production uses Redis atomically; tests and local
  development use the in-process fallback unless explicitly configured.
- **Slug uniqueness constraint enforcement at the schema level.** Today, two servers with the same slug will both succeed; the UI dedupes. The unique index is M11.
- **Server icon upload.** `iconUrl` is null; the upload pipeline is M15.
