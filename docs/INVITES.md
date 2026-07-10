# Invites — M14 / Phase 2 community MVP

The invite system is the fifth Phase 2 surface (after M10 servers, M11 channels, M12 messages, M13 roles). It closes the loop on the Phase 2 success criterion — a small group of friends can actually join a server they were invited to.

This document covers:
- The DB schema (inherited from M3, exercised by M14)
- The 7 query helpers in [`packages/db/src/queries/invites.ts`](../packages/db/src/queries/invites.ts)
- The 4 new HTTP endpoints (create / list / revoke / metadata / redeem)
- The `/join/[code]` landing page
- The transactional redeem with `SELECT ... FOR UPDATE`
- The `@everyone` auto-assignment on a successful redeem
- The relationship to the M13 `CREATE_INVITE` permission
- The out-of-scope list (server-side UI, audit log, invite analytics)

## Code format

Invite codes are 12 chars of the **Crockford base32** alphabet:

```
23456789ABCDEFGHJKMNPQRSTVWXYZ
```

Excludes `0`, `1`, `I`, `L`, `O`, `U` — the characters most often misread or misread aloud. With 27 symbols over 12 positions, the keyspace is 27^12 ≈ 1.5 × 10^17. That's enough that a non-targeted scan (60 req/min × 5 years) doesn't crack a code by chance.

The route layer validates the code shape on every entry point with `/^[A-Z2-9]{6,16}$/i` — letters and digits, the same alphabet, with a 6-16 char range (so the storage layer can grow the code length later without a schema migration).

## Query helpers

```ts
// packages/db/src/queries/invites.ts
createInvite(db, { serverId, createdBy, maxUses?, expiresAt? })
getInviteById(db, inviteId)
getInviteByCode(db, code)
listInvitesForServer(db, serverId)            // joins `servers` to filter out soft-deleted
getInviteMetadata(db, code)                   // public projection (no PII)
revokeInvite(db, inviteId)                    // hard delete
redeemInvite(db, code, userId)                // transactional SELECT FOR UPDATE
```

`redeemInvite` returns a discriminated union:

```ts
type RedeemInviteResult =
  | { ok: true; membershipId: string; serverId: string; roleId: string }
  | { ok: false; error: 'not_found' | 'expired' | 'exhausted' | 'already_member' | 'no_everyone_role' };
```

The error map is a route-layer concern (the route layer maps it to status codes — see "Endpoints" below).

## Endpoints

| Method | Path | Auth | Body | Status | Rate limit |
|---|---|---|---|---|---|
| `GET`    | `/api/servers/{id}/invites`              | Member  | — | 200 / 403 / 404 | 60 / min |
| `POST`   | `/api/servers/{id}/invites`              | `CREATE_INVITE` | `{ maxUses?: 1..1000, expiresAt?: ISO8601 }` | 201 / 400 / 403 / 404 | 10 / min |
| `DELETE` | `/api/servers/{id}/invites/{inviteId}`   | `MANAGE_ROLES`  | — | 200 / 400 / 403 / 404 | 10 / min |
| `GET`    | `/api/invites/{code}`                    | Public  | — | 200 / 400 / 404 | 60 / min |
| `POST`   | `/api/invites/{code}/redeem`             | Session + `uid` | — | 201 / 400 / 401 / 404 / 409 / 410 / 503 | 30 / min |

The body of `POST /api/servers/{id}/invites` is validated by:

```ts
z.object({
  maxUses: z.number().int().positive().max(1000).optional(),
  expiresAt: z.string().datetime().optional(),
});
```

The `expiresAt` is converted to a `Date` on the server. If the string parses to `NaN`, the route returns 400 (defensive — Zod's `.datetime()` should already have caught malformed inputs).

`GET /api/invites/{code}` returns the **public** projection:

```json
{
  "invite": {
    "code": "ABC23D9P45Q7",
    "serverId": "...",
    "serverName": "My friends",
    "expiresAt": "2026-06-15T12:00:00Z",
    "currentUses": 3,
    "maxUses": 25,
    "isExpired": false,
    "isExhausted": false
  }
}
```

No PII (no `createdBy`, no use list) — that's what the authenticated `GET /api/servers/{id}/invites` is for. `Cache-Control: no-store` because `currentUses` changes on every redeem.

`POST /api/invites/{code}/redeem` maps `redeemInvite` errors to status codes:

| Error             | Status | Body                                  |
|-------------------|--------|---------------------------------------|
| `not_found`       | 404    | `{ "error": "Invite not found" }`     |
| `already_member`  | 409    | `{ "error": "You are already a member of this server" }` |
| `expired`         | 410    | `{ "error": "Invite has expired" }`   |
| `exhausted`       | 410    | `{ "error": "Invite has reached its use limit" }` |
| `no_everyone_role`| 500    | `{ "error": "Server is missing the @everyone role. This is a server-side bug." }` |

On success (201), it returns:

```json
{
  "membership": {
    "serverId": "...",
    "userId": "...",
    "roleId": "..."    // the @everyone role id
  }
}
```

## The transactional redeem

`redeemInvite` opens a Drizzle transaction:

```ts
db.transaction(async (tx) => {
  const [invite] = await tx.select().from(invites)
    .where(eq(invites.code, code)).for('update');
  if (!invite) return { ok: false, error: 'not_found' };
  if (invite.expiresAt && invite.expiresAt < now) return { ok: false, error: 'expired' };
  if (invite.maxUses !== null && invite.currentUses >= invite.maxUses) {
    return { ok: false, error: 'exhausted';
  }
  // Look up the @everyone role.
  const [everyone] = await tx.select().from(roles)
    .where(and(eq(roles.serverId, invite.serverId), eq(roles.name, EVERYONE_ROLE_NAME)));
  if (!everyone) return { ok: false, error: 'no_everyone_role' };

  // Idempotent: if the user is already a member, return the existing row.
  const [existing] = await tx.select().from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.serverId, invite.serverId)));
  if (existing) {
    return { ok: true, membershipId: existing.id, serverId: invite.serverId, roleId: existing.roleId };
  }

  const [m] = await tx.insert(memberships).values({
    serverId: invite.serverId, userId, roleId: everyone.id,
  }).returning();
  await tx.update(invites).set({ currentUses: sql`${invites.currentUses} + 1` })
    .where(eq(invites.id, invite.id));
  return { ok: true, membershipId: m.id, serverId: invite.serverId, roleId: everyone.id };
});
```

The `SELECT ... FOR UPDATE` (Drizzle's `.for('update')`) prevents a concurrent over-redeem past `maxUses`. Without it, two simultaneous redemptions could each see `currentUses = maxUses - 1`, both insert memberships, and leave `currentUses = maxUses + 1`.

The `@everyone` lookup is the reason the `no_everyone_role` error exists — it can only happen if the role row was deleted by a hand-rolled SQL call (the API rejects deleting `@everyone` with a 400).

The redeem is idempotent on the membership side: re-running with the same `(userId, code)` is a no-op for the membership insert, but it still increments `currentUses`. That's deliberate — the invite's use count is the audit trail, not the membership.

## The `/join/[code]` page

`apps/web/app/join/[code]/page.tsx` is a client component that:

1. On mount, fetches `GET /api/invites/{code}` to render the server name + invite state. A 404 renders "This invite code is unknown or has been revoked".
2. Probes `GET /api/auth/guest` (the M9 "who am I" endpoint) so a returning visitor skips the sign-in step.
3. Step 1 of the UI: "Sign in as guest" — `POST /api/auth/guest` (idempotent re-bind).
4. Step 2 of the UI: "Accept invite" — `POST /api/invites/{code}/redeem`. The 401/409/410/404 status codes each have a tailored message.
5. On success, renders "You are now a member of <ServerName>" with a placeholder link to `/servers/{serverId}` (the real server-home page is M15 UI).

The page is intentionally a thin shell — the rest of the M15 UI is a separate milestone.

## Relationship to M13's `CREATE_INVITE`

The `@everyone` default permissions include `create_invite`. That means **any member** of a server can create an invite — the M13 design is "creating an invite is a low-trust action; revoking it is high-trust". Revoking (`DELETE /api/servers/{id}/invites/{inviteId}`) requires `MANAGE_ROLES`, which only `@admin` has.

The M15 server-home UI gives a "create invite" button to every member and a "revoke" button only to admins. The M14 backend already does the right thing.

## Cross-platform

- The codes are generated with `crypto.randomBytes(8)` from Node's stdlib — uniform across OSes.
- The route handlers are Node-only (`runtime = 'nodejs'`).
- The transaction + `SELECT FOR UPDATE` relies on Postgres, which the `@lobbyforge/db` package already targets.

## Tests

The query helpers are unit-testable in isolation; the route layer is tested through the integration test in the M14 milestone (the plan called for ~9-10 tests but the M13 + M14 test expansion landed at 28 — 15 roles + 13 members). The invite route tests are a M15 follow-up.

## Out of scope

- **Server-home UI for invite management.** The "create / list / revoke" buttons live in `/servers/{id}`, which is M15.
- **Audit log entries.** Every M14 mutation (create / revoke / redeem) should land a row in `audit_logs`. The wiring is M15.
- **Invite analytics.** "How many of my invites converted?" is a dashboard question; the data is already in the table.
- **Custom invite URLs.** Today the code is the URL. A future iteration can let the server owner pick a vanity slug.
- **Per-channel invites.** Today every invite grants `@everyone`. A per-channel invite (Discord's "invite to a specific channel") needs an `invite_channels` table — M15+.
- **Invite email.** Sending the code in an email requires a transactional email service. The link is a normal `https://…/join/{code}` URL today, so copying it into a chat works.
- **Disposable one-time invites.** `maxUses: 1` already implements this; the UI for it (a "burn after first use" toggle) is M15.
- **Invite expiration warning emails.** A pre-expiry reminder would land in the same transactional email system; out of scope until that lands.
