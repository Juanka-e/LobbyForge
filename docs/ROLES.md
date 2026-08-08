# Roles & Permissions — M13 / Phase 2

The roles + permissions system is the fourth Phase 2 surface (after M10's servers, M11's channels, M12's messages). It replaces the M10 + M11 "owner-only" / "owner override" mutation rules with a real permission check, and adds role management + membership listing endpoints.

This document covers:
- The DB query helpers ([`packages/db/src/queries/roles.ts`](../packages/db/src/queries/roles.ts), extended [`packages/db/src/queries/memberships.ts`](../packages/db/src/queries/memberships.ts))
- The 14 permission constants in [`@lobbyforge/core`](../packages/core/src/permissions.ts)
- The 8 new HTTP endpoints (5 role-management + 3 membership)
- The default `@everyone` + `Owner` seed on server creation
- The `getUserPermissions` helper that powers every mutation route
- The relationship to M10 + M11 + M12
- The out-of-scope list (invites, bans, audit log, role reordering UI)

## Permission model

The `roles` table holds a `permissions` JSONB column — an array of permission strings from `CorePermission`. The 14 constants cover every authorization decision the API makes today and the ones M14+ will need:

```ts
// packages/core/src/permissions.ts
export const CorePermission = {
  ADMINISTRATOR: 'administrator',
  MANAGE_SERVER: 'manage_server',
  MANAGE_CHANNELS: 'manage_channels',
  MANAGE_ROLES: 'manage_roles',
  KICK_MEMBERS: 'kick_members',
  BAN_MEMBERS: 'ban_members',
  CREATE_INVITE: 'create_invite',
  SEND_MESSAGES: 'send_messages',
  MANAGE_MESSAGES: 'manage_messages',
  ADD_REACTIONS: 'add_reactions',
  CONNECT_VOICE: 'connect_voice',
  SPEAK: 'speak',
  MUTE_MEMBERS: 'mute_members',
  DEAFEN_MEMBERS: 'deafen_members',
  START_ACTIVITY: 'start_activity',
} as const;
```

`hasPermission(userPermissions, required)` is the single authorization primitive. It short-circuits to `true` if `ADMINISTRATOR` is in the array — that's the "owner override" M11 + M12 used, but now it's data-driven instead of code-driven.

## Default role seeding

`createServer` in `queries/servers.ts` calls `seedDefaultRoles(serverId, ownerUserId)` after inserting the server + owner membership. The seed is idempotent (looks up by `(serverId, name)` first) and inserts two roles:

| Name | Position | Default permissions | Assigned to |
|---|---|---|---|
| `@everyone` | 0 | `send_messages`, `connect_voice`, `speak`, `add_reactions`, `create_invite` | Every future member (the seed only assigns the owner; M14's invite-redeem will assign it to new joiners) |
| `Owner` | 100 | `administrator`, `manage_server`, `manage_channels`, `manage_roles`, `manage_messages`, `kick_members`, `ban_members`, `mute_members`, `deafen_members`, `start_activity` | The owner, on create |

`Administrator` is a permission, not a reserved display name. The initial owner receives the ordinary `Owner` role carrying that permission. `@everyone` remains the structural base permission layer and is not rendered as a profile badge.

## Display hierarchy and member grouping

Roles are ordered by descending `position`. A member's highest assigned non-`@everyone` role supplies the visible name color and role icon. Profiles show all assigned non-structural roles.

`displaySeparately` is independent from permissions. When enabled, online members whose highest separately displayed role is that role appear under its own heading in the right member list. Each member appears once. Other online members remain under Online, and offline members remain under Offline.

The owner's `@admin` assignment means the freshly created server has the same capabilities the M10 + M11 hardcoded "owner-only" rules used to enforce — `MANAGE_CHANNELS`, `MANAGE_MESSAGES`, `MANAGE_ROLES`, etc. all flow through `hasPermission([administrator], anything) === true`.

## The `getUserPermissions` shortcut

```ts
// packages/db/src/queries/roles.ts
export async function getUserPermissions(
  db: DbClient,
  userId: string,
  serverId: string
): Promise<string[]> {
  // 1. Owner shortcut: return [ADMINISTRATOR] without joining.
  const server = await getServerById(db, serverId);
  if (server.ownerUserId === userId) return [CorePermission.ADMINISTRATOR];

  // 2. Member join: read the role's permissions column.
  const rows = await db
    .select({ permissions: roles.permissions })
    .from(memberships)
    .leftJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.userId, userId), eq(memberships.serverId, serverId)))
    .limit(1);
  return (rows[0]?.permissions as string[] | null) ?? [];
}
```

The owner shortcut is what makes the "owner always has ADMINISTRATOR" rule work without a separate code path in every route. A freshly created server's owner has `getUserPermissions() === [administrator]` even if the role hasn't been seeded yet (defensive coding — the seed is the happy path, but the shortcut doesn't depend on it).

`authorizeServerPermission(userId, serverId, required)` in `apps/web/lib/permissions.ts` wraps this with the standard `403 Forbidden` response shape. Every mutation route leans on it.

## Endpoints

### Roles

| Method | Path | Body | Description | Rate limit |
|---|---|---|---|---|
| `GET`    | `/api/servers/{id}/roles`         | — | List the server's roles, ordered by `position ASC`. Members can read. | 60 / min |
| `POST`   | `/api/servers/{id}/roles`         | `{ name, color?, icon?, displaySeparately?, position?, permissions }` | Create a role. Requires `MANAGE_ROLES`. | 10 / min |
| `GET`    | `/api/servers/{id}/roles/{roleId}` | — | Fetch a single role. Members can read. | 60 / min |
| `PATCH`  | `/api/servers/{id}/roles/{roleId}` | `{ name?, color?, icon?, displaySeparately?, position?, permissions? }` | Partial update. Requires `MANAGE_ROLES`. Renaming `@everyone` is rejected. | 30 / min |
| `DELETE` | `/api/servers/{id}/roles/{roleId}` | — | Delete a role. Requires `MANAGE_ROLES`. Deleting `@everyone` is rejected (it's structural, not a real role). Best-effort clears the `roleId` on memberships that pointed at the role. | 10 / min |

### Members

| Method | Path | Body | Description | Rate limit |
|---|---|---|---|---|
| `GET`    | `/api/servers/{id}/members`                  | — | List the server's members with their role, permissions, and an `isOwner` flag. The owner is decorated with `ADMINISTRATOR` so the UI can render the badge without a second lookup. | 60 / min |
| `DELETE` | `/api/servers/{id}/members/{userId}`         | — | Kick a member. Requires `KICK_MEMBERS` (or self-leave — the caller can always leave a server they're a member of, no permission required). The owner cannot be kicked (use server transfer or softDeleteServer). | 20 / min |
| `PUT`    | `/api/servers/{id}/members/{userId}/role`    | `{ roleIds: uuid[] }` | Assign / clear the member's roles. Requires `MANAGE_ROLES`. All roles must belong to the same server. | 20 / min |

All eight sit behind `withApiSecurity(...)` (now generic over `TContext` for the `[roleId]` and `[userId]` segments).

### Atomic Position Shifting (M15.6)

`updateRole` now performs an atomic "move-and-shift" operation when the `position` is updated. It uses a database transaction to reorder sibling roles, ensuring no gaps or duplicates in the position sequence.

### Multi-role per member (M15.5)

Members can now hold multiple roles. The `memberships.roleId` remains the primary/display role, but additional roles are stored in the `membership_roles` join table. `getUserPermissions` returns the union of permissions from all assigned roles. `PUT /api/servers/{id}/members/{userId}/role` now accepts an array of `roleIds`.

### Body / response shapes

```ts
// Role JSON (toJson in roles/route.ts)
interface RoleJson {
  id: string;             // uuid
  serverId: string;       // uuid
  name: string;           // 1..64 chars
  color: string | null;   // '#RRGGBB' or null
  icon: string | null;
  displaySeparately: boolean;
  position: number;       // dense, server-scoped
  permissions: string[];  // subset of CorePermission values
  createdAt: string;      // ISO-8601
}

// Member JSON (listMembersForServer + decoration)
interface MemberJson {
  userId: string;
  roleId: string | null;
  roleName: string | null;
  rolePosition: number | null;
  permissions: string[];  // empty for a member with no role assigned
  isOwner: boolean;       // owner is always true + has ADMINISTRATOR injected
}
```

### Status codes

| Code | When |
|---:|---|
| 200 | `GET` / `PATCH` / `PUT` / `DELETE` success |
| 201 | `POST` (role create) success |
| 400 | Body fails zod validation, unknown permission string in `permissions`, renaming `@everyone`, deleting `@everyone`, kicking the owner |
| 401 | Cookie missing or signature invalid |
| 403 | Caller is not a member (read) or lacks the required permission (write) |
| 404 | Server not found, role not found in this server, member not found |
| 500 | Drizzle threw (wrapped with a sanitized message) |
| 503 | Cookie has no `uid` (DB not migrated / down) — see "503 contract" below |

### The 503 contract

Same as M10–M12: a `null` `uid` in the cookie (guest minted but the `users` row never materialized) returns **503** with `howToFix: "Re-issue POST /api/auth/guest"`.

## Permission checks on M11 + M12 routes

M13 retrofits the M11 + M12 mutation routes with real permission checks. The M10 read-only routes are unchanged.

| Route | Old rule (M11 / M12) | New rule (M13) |
|---|---|---|
| `POST /api/servers/{id}/channels` | Any member | `MANAGE_CHANNELS` |
| `PATCH /api/servers/{id}/channels/{channelId}` | Owner only | `MANAGE_CHANNELS` |
| `DELETE /api/servers/{id}/channels/{channelId}` | Owner only | `MANAGE_CHANNELS` |
| `POST /api/servers/{id}/channels/{channelId}/messages` | Any member (placeholder) | `SEND_MESSAGES` |
| `PATCH /api/servers/{id}/channels/{channelId}/messages/{messageId}` | Author OR owner | Author OR `MANAGE_MESSAGES` |
| `DELETE /api/servers/{id}/channels/{channelId}/messages/{messageId}` | Author OR owner | Author OR `MANAGE_MESSAGES` |

The "owner override" survives as a data fact (the owner has `ADMINISTRATOR` via the seed) instead of a code fact. The route handlers are simpler: they call `authorizeServerPermission` and the helper does the rest.

## Query helpers

```ts
// packages/db/src/queries/roles.ts
seedDefaultRoles(db, serverId, ownerUserId)
  // Idempotent. Creates @everyone + Owner and assigns Owner to the owner.
  // Returns { everyoneRoleId, adminRoleId }.

createRole(db, { serverId, name, color?, position?, permissions })
  // Asserts the server exists. Normalizes the permissions array (drops
  // unknown strings, dedupes). Returns the new row.

listRolesForServer(db, serverId)
  // Joins servers (filters soft-deleted), sorts by position ASC.

getRoleById(db, roleId)
  // Returns null for unknown ids. Does NOT join servers (the route
  // layer validates the role belongs to the URL's server).

updateRole(db, roleId, { name?, color?, position?, permissions? })
  // Partial update. Empty patch is allowed (returns the current row).

deleteRole(db, roleId)
  // Hard delete. Best-effort clears the `roleId` on memberships that
  // pointed at the role. The FK on `memberships.roleId` is `ON DELETE
  // SET NULL` (per the schema) so this is redundant but defensive.

getUserPermissions(db, userId, serverId)
  // Returns the union of permissions. Owner shortcut returns
  // [administrator] without joining.

listMembersForServer(db, serverId)
  // Returns { userId, roleId, roleName, rolePosition, permissions }
  // for every member of the server. The route decorates the owner
  // with isOwner + ADMINISTRATOR.
```

```ts
// packages/db/src/queries/memberships.ts (additions)
assignRole(db, serverId, userId, roleId | null)
  // Updates the membership's `roleId`. Throws if the user is not a
  // member of the server. `roleId: null` is a valid clear.

removeMember(db, serverId, userId)
  // Hard delete. Throws if the user is not a member. Used by the
  // kick endpoint; bans are a different code path (M14).
```

## Testing

The M11 channels test and M12 messages test are updated to mock `getUserPermissions` so the new permission gates are exercised. Two new test cases were added to `channels.test.ts`:

- `POST /channels` with a non-owner member who has `send_messages` but not `manage_channels` → **403**
- `PATCH /channels/{id}` with a non-owner member who has `send_messages` but not `manage_channels` → **403**

The M12 messages test adds `getUserPermissions` mocks to the existing scenarios; the PATCH 403 + DELETE 403 cases now return 403 (instead of 500) because `getUserPermissions` returns the right shape.

| Workspace | New tests |
|---|---:|
| `apps/web/app/api/servers/[id]/channels/__tests__/channels.test.ts` | +2 (now 16 total) |
| `apps/web/app/api/servers/[id]/channels/[channelId]/messages/__tests__/messages.test.ts` | unchanged shape; +`getUserPermissions` mock (now 16 total) |

The role-management + membership routes do not yet have a dedicated test file. The query helpers in `queries/roles.ts` are unit-testable (in `packages/db`); the route tests are a follow-up once M14 lands the audit-log + invite-redeem code that the role system leans on.

## Relationship to M10 + M11 + M12

- `M10 createServer` now calls `seedDefaultRoles` after inserting the server + owner membership. The function signature is unchanged — callers don't need to know roles exist.
- `M11 channels` routes' "owner-only" mutation rule is now a `MANAGE_CHANNELS` check. The owner's `getUserPermissions` returns `[administrator]`, which `hasPermission` accepts for any required permission. A freshly created server still has its "general" channel editable by the owner.
- `M12 messages` routes' "author OR owner" mutation rule is now "author OR `MANAGE_MESSAGES`". Same owner-shortcut applies.
- `isServerMember` (M11) is still the read-side primitive. The role system doesn't replace it — it adds the write-side gate on top.

## Out of scope (deferred to later milestones)

- **Invite-redeem.** The `invites` table is in the M3 schema and the `@everyone` default permissions include `CREATE_INVITE`, but there's no `POST /api/servers/{id}/invites` or `POST /api/invites/{code}/redeem` yet. M14.
- **Bans.** The `server_bans` table is in the M3 schema. The `BAN_MEMBERS` permission is seeded on `@admin`, but no route writes to it. M14.
- **Audit log.** The `audit_logs` table is in the M3 schema. Every M13 mutation (role create / update / delete, member kick, role assignment) should land a row; the wiring is M14.
- **Role reordering UI.** `PATCH` accepts a new `position` but doesn't renumber siblings (same shape as the M11 channel reordering). The "move and shift" helper is M14.
- **Multiple roles per member.** The `memberships.roleId` column is a single FK, not a join table. A user can be in at most one role per server today. The "many roles" expansion is M14 if a server needs nuanced capability sets.
- **Permissions UI.** The role management routes exist; a UI to assign permissions through checkboxes is M15+ (the `@lobbyforge/ui` design system).
- **Permission inheritance.** `@everyone` grants a default set; specific roles add on top. The "union of role permissions" semantics is the M13 model. A "deny" flag or per-channel overrides is out of scope.
- **Role deletion cascading.** `deleteRole` clears the `roleId` on memberships but doesn't tell the user "this role was deleted, these N members lost the role". A follow-up audit-log entry lands with M14.
- **Distributed rate limit / Redis-backed presence.** The `app/api/presence/route.ts` route (M14, added by the user) leans on `lib/redis.ts` to set a 90-second-TTL presence key. The route is gated by `withApiSecurity` and a real session check, but the rate-limit identifier is shared across all users (the `presence-update` rate-limit is in-process). The Redis-backed limit lands with M14's full moderation pass.
- **Per-channel permission overrides.** Today the role's permissions apply to every channel the member can see. Discord's "this channel denies @everyone read access" is a future feature.
