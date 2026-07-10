# Activities — Aşama 3 / Plugin SDK minimal

The activities layer is the plugin-host surface in the web app. It
exposes a small set of HTTP endpoints under
`/api/servers/{id}/...` that the voice room's "Start Activity"
picker calls, and a `gameSessions` query helper in
`@lobbyforge/db` that the host uses to persist plugin state.

This document covers:
- The plugin registry (`apps/web/lib/plugin-registry.ts`).
- The `gameSessions` query helpers.
- The 5 activity HTTP endpoints.
- The audit-log actions an activity produces.
- The `START_ACTIVITY` permission gate.
- The `ActivityPicker` and `ActivityPanel` UI in the voice room.

The plugin SDK contract (`GamePlugin` / `GamePluginContext` /
`createTestHarness`) is documented in [`docs/PLUGIN_SDK.md`](./PLUGIN_SDK.md).

## The plugin registry

`apps/web/lib/plugin-registry.ts` is the host's compiled-in list of
plugins. M16 ships with exactly one plugin (`@lobbyforge/quiz`,
used as the "dummy plugin" for the Aşama 3 success criterion).

```ts
import { quizPlugin } from '@lobbyforge/quiz';
import { registerGamePlugin, type RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';

export const PLUGINS: readonly RegisteredGamePlugin[] = [
  registerGamePlugin(quizPlugin),
] as const;

export function getPlugin(id: string): RegisteredGamePlugin | null {
  return PLUGINS.find((p) => p.manifest.id === id) ?? null;
}

export function listPluginSummaries(): PluginSummary[] {
  return PLUGINS.map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    type: p.manifest.type,
    catalog: p.manifest.catalog ?? null,
  }));
}
```

The registry is a static array (not dynamic import). Adding a new
plugin is a code change + redeploy today; M17+ will add hot-reload.
The `PluginId` type — `(typeof PLUGINS)[number]['manifest']['id']` —
narrows the route params + audit-log metadata at compile time.

## The `gameSessions` query helpers

`packages/db/src/queries/gameSessions.ts` is the DB layer for the
host. The schema (`game_sessions` + `game_session_players` +
`plugin_events`) was created in M3; M16 wires the helpers.

- `createGameSession(db, { serverId, channelId, pluginId, createdBy, state })`
  — inserts a new session with `status = 'lobby'`. The plugin's
  `createInitialState` is what produces the `state` argument.
- `getGameSessionById(db, sessionId)` — returns the row only if
  `status <> 'ended'` and `endedAt IS NULL`. The read path treats
  ended sessions as gone.
- `listGameSessionsForChannel(db, channelId)` — same filter, newest
  first, bounded to 50.
- `setGameSessionState(db, sessionId, state, publicSummary?)` —
  patches the `state` JSONB and optionally the `publicSummary`
  (used by the list view to avoid a full-state read).
- `endGameSession(db, sessionId)` — sets `status = 'ended'` and
  `endedAt = now()`. Idempotent: re-ending a session is a no-op
  (the row's `status` is already `'ended'`).
- `addPlayerToSession(db, sessionId, userId)` /
  `removePlayerFromSession(db, sessionId, userId)` /
  `listPlayersForSession(db, sessionId)` — manage the
  `game_session_players` table. Player membership is a richer
  concept than the SDK's `players.list` snapshot, so the table
  carries `joinedAt`, `leftAt`, `characterName`, `characterData`,
  `status`, and `score`. M16 only uses the snapshot path
  (`listPlayersForSession` → cached at the start of the call); the
  per-player history is M17+.

## The 5 activity HTTP endpoints

All 5 are behind `withApiSecurity` and use
`getUserPermissions` + `isServerMember` (the same gate pattern as
the M13 routes). Audit writes follow the M15.2 fire-and-forget
pattern.

Security invariants:

- A voice/stage channel can have only one active activity at a time.
- Activity start requires `START_ACTIVITY`.
- Activity actions are authorized by `plugin.actionPolicies` before the
  plugin reducer runs.
- Unknown action types default to host-only.
- Actor identity fields such as `playerId`, `voterId`, and `hostId` must be
  host-overwritten through `actorFields`, not trusted from the browser.

### `POST /api/servers/{id}/channels/{channelId}/activities` — start

Body: `{ pluginId: string }`. Requires `START_ACTIVITY` (admin-only,
seeded into `DEFAULT_ADMIN_PERMISSIONS` in M15.2). The route
resolves the plugin via `getPlugin`, calls
`plugin.createInitialState(buildHttpPluginContext(...))` to
compute the initial state, inserts the row via `createGameSession`,
and audit-logs `activity.create` with `{ pluginId, channelId }`.
Rate limit: 10 req/min. 404 on unknown plugin; 400 on malformed
body; 201 on success.

Current hardening:

- The route verifies that `channelId` belongs to `{id}`.
- The channel must be `voice` or `stage`.
- The route calls `getActiveGameSessionForChannel` and returns 409 when the
  channel already has an active `lobby`, `running`, or `paused` session.
- The selected plugin must be installed and enabled for the server in
  `plugins_enabled`.

### `GET /api/servers/{id}/channels/{channelId}/activities` — list

Returns the active sessions in the channel as summaries
(`{ id, serverId, channelId, pluginId, status, publicSummary, ... }`)
without the full `state` blob. Membership-gated (owner shortcut or
`isServerMember` = true). 60 req/min.

### `GET /api/servers/{id]/activities/{sessionId}` — read

Returns the full session detail: `{ id, pluginId, status, state,
publicSummary, players: [...] }`. Membership-gated. 404 if the
session is ended, doesn't exist, or belongs to a different server
than the URL says (defence-in-depth — the URL encodes the server,
but a malicious caller shouldn't be able to cross-invoke). 60
req/min.

### `POST /api/servers/{id]/activities/{sessionId]/actions` — dispatch

Body: any JSON object with at least a `type: string` field. The
route loads the session, resolves the plugin via
`getPlugin(session.pluginId)`, and calls
`plugin.handleAction(ctx, state, body)`. The return value is
persisted via `setGameSessionState`. Audit `activity.action` with
`{ pluginId, actionType }`. Membership-gated. 409 if the session
is for a plugin the registry no longer ships. 30 req/min.

Before `handleAction` runs, the host evaluates the plugin's action policy:

- `host`: session creator or a user with `START_ACTIVITY`.
- `member`: any member of the server.
- `player`: active player in `game_session_players`.
- missing policy: treated as `host`.

If the policy has `actorFields`, the host overwrites those fields with the
local `session.uid`. For example, `vote.voterId`, `join.playerId`, and
`set-video.hostId` should be actor-bound by the host.

### `POST /api/servers/{id]/activities/{sessionId]/end` — end

Two paths: the host (session's `createdBy`) can end without
`START_ACTIVITY`; everyone else needs the admin permission.
Audit `activity.end` with `{ pluginId, wasHost }`. 10 req/min.

### `GET /api/plugins` — registry listing

A small `apps/web/app/api/plugins/route.ts` that returns
`listPluginSummaries()`. No auth (the picker is inside a server
gated by the voice room). 60 req/min. Summaries include optional
`manifest.catalog` metadata such as publisher, trust level, tags,
player limits, spectator/queue support, and overflow policy.

### `GET/POST/DELETE /api/servers/{id}/apps` — installed apps

The server-scoped installed-apps route joins the compiled-in catalog with the
server's `plugins_enabled` rows:

- `GET` requires server membership and returns every known catalog app with
  `installed`, `enabled`, `settings`, and `installedAt`.
- `POST` requires `MANAGE_SERVER`, validates `pluginId`, and upserts
  `enabled` plus supported settings (`allowedChannelIds`, `allowedRoleIds`,
  `defaultMaxPlayers`, `overflowPolicy`).
- `DELETE` requires `MANAGE_SERVER` and removes the server-local install row.

The route never installs arbitrary package code. It can only enable plugins
already compiled into `apps/web/lib/plugin-registry.ts`.

## The `ActivityPicker` and `ActivityPanel` UI

The voice room page at `apps/web/app/room/[roomName]/page.tsx`
embeds two subcomponents:

- **ActivityPicker.** A `<select>` populated by
  `GET /api/servers/{id}/apps` filtered to installed+enabled apps, plus a
  "Start activity" button that POSTs to the channel's `activities` route.
  Hidden if the URL doesn't carry `serverId` + `channelId`, or if an activity
  is already active in this view.
- **ActivityPanel.** Renders only while `activeSessionId` is set.
  Polls `GET /api/servers/{id]/activities/{sessionId}` every 2s
  and shows: the plugin name, the session `status`, the player
  count, the current `state` (as a JSON dump), a free-form "send
  action" input (the action is parsed as JSON and POSTed to the
  `actions` route), and an "End" button. 404 from the poll
  triggers an `onEnd` (the session was ended from another tab).

The panel's free-form JSON action input is M16's "good enough" UI
for the dummy plugin. M17+ will swap to a per-plugin
`renderClient` that knows its own action types.

## Product UI direction for Games

The user-facing language should be **Apps** at the catalog level and
**Games / Bots / Integrations** as subcategories. "Plugin" remains a
developer term.

Voice-room game picking should stay compact and action-oriented:

```txt
Start Activity
- Hushle              4-12 players   Official
- Vampire Village    6-24 players   Official
- Quiz               2-50 players   Official
- Watch Party        2-100 sync-only Official
```

The broader official lobby / registry view can use richer app cards:

- trust label: official, verified community, unverified self-host
- install state: installed, available, incompatible, update available
- player range and spectator support
- required capabilities summarized in user language
- account requirement: none, optional account linking, external account required
- primary action: `Start`, `Install to server`, `Open in official hub`, `Connect account`

MVP invariant:

```txt
1 voice room = 1 active activity session
```

The start route must reject a second active session in the same voice
channel. This keeps voice state, host controls, mute/deafen behavior,
and LiveKit data-channel routing predictable.

## The `START_ACTIVITY` permission

`CorePermission.START_ACTIVITY` was added in M15.2 and lives in
`DEFAULT_ADMIN_PERMISSIONS` (not `DEFAULT_EVERYONE_PERMISSIONS`).
The `end` route allows the host (the session's `createdBy`) to
end without the permission, on the "I started this, I can stop it"
principle. The start route requires the permission — anyone who
can start an activity can spam the channel, so the gate is tight.

## The audit log

Activity events land in `audit_logs` with these `action` strings:

- `activity.create` — `targetType: 'session'`, `targetId: <sessionId>`,
  `metadata: { pluginId, channelId }`.
- `activity.action` — `targetType: 'session'`, `targetId: <sessionId>`,
  `metadata: { pluginId, actionType }`.
- `activity.end` — `targetType: 'session'`, `targetId: <sessionId>`,
  `metadata: { pluginId, wasHost }`.

The audit log surface is owner-only (via `VIEW_AUDIT_LOG`, which is
admin-only). See [`docs/ROLES.md`](./ROLES.md).

## Reference

- `packages/db/src/queries/gameSessions.ts` — query helpers.
- `apps/web/lib/plugin-registry.ts` — compiled-in plugin list.
- `apps/web/lib/plugin-context.ts` — HTTP host's
  `buildHttpPluginContext` (the `GamePluginContext` adapter).
- `apps/web/app/api/plugins/route.ts` — `GET /api/plugins`.
- `apps/web/app/api/servers/[id]/channels/[channelId]/activities/route.ts`
  — start + list.
- `apps/web/app/api/servers/[id]/activities/[sessionId]/route.ts` — read.
- `apps/web/app/api/servers/[id]/activities/[sessionId]/actions/route.ts`
  — dispatch.
- `apps/web/app/api/servers/[id]/activities/[sessionId]/end/route.ts`
  — end.
- `apps/web/app/room/[roomName]/page.tsx` — the picker + panel UI.
