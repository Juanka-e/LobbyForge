# Plugin SDK — Aşama 3 / Plugin SDK minimal

The `@lobbyforge/plugin-sdk` package is the contract between the web app
(plugin host) and the plugins in `plugins/*`. It exports:

- The `GamePlugin` / `RegisteredGamePlugin` / `GamePluginContext` /
  `PluginManifest` / `PluginPermission` types every plugin or host registry
  uses.
- The `registerGamePlugin` helper that erases a strongly typed plugin into the
  host-side registry shape without exposing `any` at every call site.
- The `createTestHarness` test helper (subpath export `@lobbyforge/plugin-sdk/testing`)
  that gives a plugin test a fully-mocked context so the plugin's
  reducer can be exercised in isolation.

This document covers the SDK's surface, the `GamePlugin` contract, and
how to author a new plugin. The HTTP host side (the routes that
dispatch actions to the plugin) is documented in [`docs/ACTIVITIES.md`](./ACTIVITIES.md).

## Exports

```ts
import {
  PluginPermission,
  type PluginManifest,
  type PlayersSubContext,
  type MessagesSubContext,
  type StateSubContext,
  type CacheSubContext,
  type PubSubSubContext,
  type TimerSubContext,
  type VotesSubContext,
  type ScoresSubContext,
  type VoiceSubContext,
  type GamePlugin,
  type RegisteredGamePlugin,
  type GamePluginContext,
  registerGamePlugin,
  // M19 shared locale helper (also exported from the
  // @lobbyforge/plugin-sdk/locale subpath for callers who want
  // the import path to scream "this is locale code"):
  tFor,
  loadPluginLocale,
  registerPluginLocale,
  listPluginLocales,
  detectLocale,
  pickBestLocale,
} from '@lobbyforge/plugin-sdk';

// Test helper (subpath export):
import { createTestHarness, type TestHarnessOptions } from '@lobbyforge/plugin-sdk/testing';
```

The `PluginPermission` constant is an enum-like object whose values
are short lowercase strings (`read_room_participants`,
`send_room_message`, `manage_game_session`, etc.) that the host
displays in the "this plugin wants to …" dialog when a server
enables it (M17+ scope).

## Manifest fields for app catalog

The SDK manifest is also the source for the official App Catalog.
`manifest.catalog` exposes enough product metadata for lobby and registry UI
without letting the registry read private instance state:

```ts
type PluginCatalogMetadata = {
  category?: "game" | "bot" | "integration" | "utility";
  summary?: string;
  publisher?: string;
  trustLevel?: "official" | "verified-community" | "unverified";
  playerConfig?: {
    minPlayers?: number;
    maxPlayers?: number;
    defaultMaxPlayers?: number;
    supportsSpectators?: boolean;
    supportsQueue?: boolean;
    overflowPolicy?: "spectator" | "queue" | "split" | "reject";
  };
  requiresVoiceRoom?: boolean;
  externalAccountRequired?: boolean;
  externalAccountProvider?: string;
  compatibleAppVersion?: string;
  tags?: string[];
};
```

`externalAccountRequired` means the app needs an explicit account-linking
flow for a third-party service. It must not silently replace instance auth.
The host still authorizes the user through the local instance session and
then lets the app request a scoped external connection when needed.

Official plugins should fill `publisher`, `trustLevel`, `playerConfig`,
`requiresVoiceRoom`, and `tags`. The `/api/plugins` listing returns this
catalog metadata alongside the stable `id`, `name`, `version`, and `type`.

## The `GamePlugin<TState, TAction, TProps>` contract

```ts
interface GamePlugin<TState = unknown, TAction = unknown, TProps = unknown> {
  manifest: PluginManifest;
  actionPolicies?: Record<string, GamePluginActionPolicy>;
  createInitialState: (ctx: GamePluginContext<TState>) => TState;
  handleAction: (ctx: GamePluginContext<TState>, state: TState, action: TAction) => TState;
  migrateState?: (raw: unknown) => TState;
  renderClient: (props: TProps) => ReactNode;
}
```

- `manifest.id` is the stable string the registry, the database, and
  the audit log all key on. It must match `[a-z0-9-]{1,64}` and be
  unique across `PLUGINS`.
- `createInitialState(ctx)` is called by the host when an activity
  starts. The returned value is the row's initial `state` JSONB.
- `handleAction(ctx, state, action)` is a pure reducer. The host
  calls it from the `actions` route; the return value is what
  `setGameSessionState` writes. Most plugins (quiz included) treat
  this as a `switch (action.type)` and never touch `ctx` — the SDK
  shape is the same for HTTP and voice-room hosts.
- `migrateState(raw)` (M19+) is the migration seam. The host runs
  it on every read against `game_sessions.state`; whatever the
  function returns is what the reducer + `renderClient` see. The
  function must be **idempotent** — the same blob may be re-read
  many times. When the plugin's state shape evolves, the plugin
  author adds a new step to the migrator chain and bumps the
  internal `version` field; the next read automatically upgrades
  old sessions in the database. The Hushle reducer is the worked
  example — see `migrateHushleState` in `plugins/hushle/src/state.ts`.
- `renderClient(props)` is the React component for the activity
  panel. M17 wires this from the voice room's `ActivityPanel` — see
  [Per-plugin renderClient](#per-plugin-renderclient) below for the
  props contract and the worked example (`plugins/hushle/src/renderClient.tsx`).

## Registry adapter

Plugin packages should export a strongly typed `GamePlugin<TState, TAction,
TProps>`. A host catalog, however, stores many different plugins in one list.
Use `registerGamePlugin()` at the catalog boundary:

```ts
import { registerGamePlugin, type RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { quizPlugin } from '@lobbyforge/quiz';

export const PLUGINS: readonly RegisteredGamePlugin[] = [
  registerGamePlugin(quizPlugin),
] as const;
```

`RegisteredGamePlugin` keeps `manifest` and `actionPolicies` visible while its
runtime calls accept `unknown` state/action payloads. The host owns validation,
authorization, and persistence at that boundary; plugin authors still get their
specific reducer types inside their own package and tests.

## Action policies

The host authorizes every action before it calls `handleAction`.
Unknown action types default to `host`, so new actions are safe by default.

```ts
type GamePluginActionPolicy = {
  role: "host" | "member" | "player";
  actorFields?: string[];
};
```

- `host`: only the session creator can perform the action. A user with
  `START_ACTIVITY` can also perform it for moderation/admin control.
- `member`: any server member can perform the action.
- `player`: the user must be an active player in `game_session_players`.
- `actorFields`: fields overwritten by the host with `ctx.actorUserId`.
  Use this for `playerId`, `voterId`, `hostId`, and similar identity fields.

Do not trust actor identity fields sent by the browser.

## The `GamePluginContext` sub-contexts

The context has `actorUserId` plus nine sub-contexts, all part of the SDK contract:

| Sub-context | Sync / async | Used for |
|---|---|---|
| `actorUserId` | sync | Local user id that triggered the current action |
| `players` | sync (M16) | `list()` returns active player ids, `get(id)` returns `{ id, name }` |
| `messages` | async | `sendGameMessage(text)` posts to the channel |
| `state` | async | `save(state)` — the HTTP host treats this as a no-op (it persists state itself) |
| `cache` | async | `get` / `set` with TTL — HTTP host returns `undefined` / no-op |
| `pubsub` | async | `publish` / `subscribe` — HTTP host is a no-op |
| `timer` | async | `start(seconds)` / `stop` — HTTP host is a no-op |
| `votes` | async | `create(question, options)` — HTTP host is a no-op |
| `scores` | async | `add(playerId, score)` — HTTP host is a no-op |
| `voice` | sync | `getParticipants()` — HTTP host returns `[]` |

The HTTP host (`apps/web/lib/plugin-context.ts:buildHttpPluginContext`)
implements the contract with the sub-contexts a plugin would
expect, but most of them are intentionally inert. A plugin that
calls `state.save` doesn't get an error — it just doesn't get
persistence, because the host persists the post-`handleAction`
state itself. This keeps the plugin's `handleAction` honest (it
can call `state.save` if it wants) while the host stays in control
of the read-modify-write cycle.

## Authoring a new plugin

1. Create a package under `plugins/{id}/` with the standard layout:
   ```
   plugins/{id}/
   ├── package.json     # name: "@lobbyforge/{id}", workspace dep on @lobbyforge/plugin-sdk
   ├── src/
   │   ├── index.ts     # exports the GamePlugin + any action / state types
   │   └── __tests__/
   │       └── {id}.test.ts  # uses createTestHarness
   └── tsconfig.json
   ```
2. Define `TState` and `TAction` types in `src/index.ts`. Keep the action
   shape small and add `actionPolicies` for public action types. Any actor
   identity field must be listed in `actorFields`.
3. Implement `createInitialState` and `handleAction` as pure
   reducers. Use the `createTestHarness` from
   `@lobbyforge/plugin-sdk/testing` to test them in isolation.
4. Add the plugin to the registry in
   `apps/web/lib/plugin-registry.ts`:
   ```ts
   import { yourPlugin } from '@lobbyforge/your-id';
   import { registerGamePlugin } from '@lobbyforge/plugin-sdk';

   export const PLUGINS = [
     registerGamePlugin(quizPlugin),
     registerGamePlugin(yourPlugin),
   ] as const;
   ```
5. If the plugin needs a workspace dep in `apps/web` (it does, for
   the registry import to resolve), add it to `apps/web/package.json`'s
   `dependencies` and re-run `pnpm install`.

## The `createTestHarness` test helper

```ts
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import { quizPlugin, type QuizState, type QuizAction } from '@lobbyforge/quiz';

const harness = createTestHarness<QuizState, QuizAction>({
  plugin: quizPlugin,
  players: ['p1', 'p2'],
});

await harness.startGame();
const initial = harness.getState(); // { questions: [], currentIndex: 0, ... }

await harness.performAction('p1', { type: 'set-questions', questions: [] });
await harness.performAction('p1', { type: 'answer', index: 0 });
const after = harness.getState(); // { ..., totalAnswered: 1 }
```

The harness exposes:
- `context` — the full `GamePluginContext` if your reducer needs to
  assert on sub-context calls.
- `startGame()` — calls `plugin.createInitialState(ctx)`.
- `performAction(playerId, action)` — calls `plugin.handleAction(ctx, state, action)`.
- `getState()` — the current state. Throws if `startGame()` wasn't called.
- `advanceTimer(seconds)` — for plugins that use `timer.start`; the
  harness counts down and the timer's callback fires when it hits 0.

The mock sub-contexts are documented in
`packages/plugin-sdk/src/testing.ts`. The `cache.get` / `set` are
in-memory `Map`s, the `scores.add` updates an in-memory score
table, and the `pubsub.publish` / `subscribe` are no-ops. The
`players.list` returns whatever ids the test passed in.

## What M16 doesn't do

- **No community sandbox yet.** Official plugins now have host-side action
  policies, but community plugins still require package signing, capability
  review, sandboxing, install approval, and rollback before they can be enabled.
- **No plugin-specific UI.** The `ActivityPanel` in
  `apps/web/app/room/[roomName]/page.tsx` is generic; the plugin's
  `renderClient` is unused. M17+ will dynamic-import each plugin's
  `renderClient` based on the session's `pluginId`.
- **Limited plugin settings.** The host now reads `plugins_enabled` and exposes
  `/api/servers/{id}/apps` plus a basic Server Apps tab for install,
  enable/disable, `defaultMaxPlayers`, and `overflowPolicy`. Per-channel,
  per-role, and plugin-specific settings screens are still M17+.
- **No real-time updates.** The activity panel polls
  `GET /api/servers/{id}/activities/{sessionId}` every 2s.
  Server-Sent Events or WebSocket are M17+.

## Shared locale helper (M19)

Adding a new language to a plugin (or to a bot — the bot SDK has the
same helper) is intentionally a single-place change:

```ts
// plugins/{id}/src/renderClient.tsx
import { loadPluginLocale, pickBestLocale, detectLocale, tFor } from '@lobbyforge/plugin-sdk';
import en from '../locales/en.json';
import tr from '../locales/tr.json';

loadPluginLocale('hushle', { en, tr });

const locale = pickBestLocale('hushle', detectLocale('en'));
const text = tFor('hushle', locale, 'lobby.title', undefined, 'en');
```

The whole pattern is:

1. The plugin ships `locales/{lang}.json` bundles.
2. At module load, `loadPluginLocale(pluginId, { en, tr })` registers
   each table against the shared registry keyed by `pluginId`.
3. `tFor(pluginId, locale, key, params?, fallback?)` resolves a
   string for the active locale, with `{name}`-style interpolation.
4. `listPluginLocales(pluginId)` returns the locales the plugin
   actually supports in registration order (so the first registered
   is the primary fallback when the user's preference isn't shipped).
5. `pickBestLocale(pluginId, preferred, fallback)` matches a
   region-tagged preference against the plugin's set
   (`tr-TR` → `tr`), then falls back to `fallback`, then to the
   first registered.

The bot SDK ships the same surface (`@lobbyforge/bot-sdk/locale`):

```ts
import { loadBotLocale, tFor } from '@lobbyforge/bot-sdk';
import en from './locales/en.json';
loadBotLocale('music-bot', { en });
```

Why a per-plugin registry and not a single shared JSON bundle?

- The plugin is the source of truth for what strings it needs.
- Community plugins ship their own loaders without touching the SDK
  or the host.
- Adding a language to one plugin doesn't require touching every
  other plugin or every other bot.
- The host's UI language switcher (when it ships) reads
  `listPluginLocales(pluginId)` to discover what's available.

The plugin-sdk subpath `@lobbyforge/plugin-sdk/locale` exports the
same surface for callers who prefer the dedicated import path.

## Per-plugin renderClient

M17 wires the plugin's `renderClient` into the voice room's
`ActivityPanel`. The contract between the host and the plugin is:

```ts
interface HushlePanelClientProps {
  state: TState;                            // server-authoritative reducer output
  dispatch: (action: TAction) => void | Promise<void>;  // POSTs to /actions, no return value
  actorUserId: string;                      // current user (the panel reads actor/host for gating)
  hostUserId: string | null;                // session creator, may be null if creator left
  players: Array<{ userId: string; name?: string | null }>;  // for name lookups
}
```

Plugins should declare a typed props interface (e.g.
`HushlePanelClientProps`) and have the SDK-bound `renderClient` cast
on the way in:

```ts
export const hushlePlugin: GamePlugin<HushleState, HushleAction> = {
  // …
  renderClient: (props: unknown) => HushlePanel(props as HushlePanelClientProps),
};
```

The host's `ActivityPanel` resolves the plugin from the registry, then:

```tsx
const plugin = getPlugin(activity.pluginId);
const ui = plugin ? plugin.client.renderClient({
  state: activity.state,
  dispatch: (action) => fetch(`/api/servers/${serverId}/activities/${sessionId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  }),
  actorUserId,
  hostUserId,
  players: activity.players,
}) : null;
return ui ?? <JsonStatePanel state={activity.state} />;
```

A few conventions plugins should follow:

1. **Mark the file with `"use client"`.** The renderClient is React
   client code — it uses hooks, accesses `document.documentElement.lang`,
   etc. Without the directive the Next.js bundler refuses to import it
   from a server component route.
2. **Inline-style the UI.** The host doesn't ship a CSS framework to
   the plugin; the panel must look right with no external stylesheets.
   Use the same dark `#0e1218` / `#1c2530` / `#e6e8eb` palette as the
   rest of the voice room.
3. **Bundle your own locales.** `plugins/{id}/locales/{en,tr}.json` is
   the convention; a tiny `t(key, params)` helper inside the
   renderClient file is enough. Don't depend on `@lobbyforge/i18n` —
   the plugin should be self-contained.
4. **Gate every action through `dispatch`.** No `fetch`, no DB calls,
   no side effects in the panel. Every state transition is a reducer
   call that the host persists.
5. **Return `null` if you have no UI.** The host falls back to the
   generic JSON panel. This is what `quizPlugin.renderClient` does
   today and is the right answer for plugins whose state is best
   inspected raw.

The full worked example is `plugins/hushle/src/renderClient.tsx`
(~660 lines). It demonstrates the four-phase machine pattern
(`lobby → team_setup → playing → ended`), the host-only / member /
guessers branching, and the locale loader.

## State versioning + migrators (M19)

`GamePlugin.migrateState?: (raw: unknown) => TState` is the
migration seam. The host runs it on every read against
`game_sessions.state`:

```ts
// Activity read route
const plugin = getPlugin(row.pluginId);
const state = plugin?.migrateState ? plugin.migrateState(row.state) : row.state;
```

The migrator must be **idempotent** — the same blob may be re-read
many times. The recommended shape is:

```ts
// plugins/hushle/src/state.ts
export const HUSHLE_STATE_VERSION = 1;

export function migrateHushleState(raw: unknown): HushleState {
  if (!raw || typeof raw !== 'object') return createHushleInitialState();
  const version = typeof (raw as any).version === 'number' ? (raw as any).version : 0;
  if (version === HUSHLE_STATE_VERSION) return raw as HushleState;
  let state: unknown = raw;
  if (version < 1) state = migrateV0ToV1(state);
  // if (version < 2) state = migrateV1ToV2(state);   ← add when v2 lands
  return state as HushleState;
}
```

When the plugin evolves its state shape:

1. Bump `HUSHLE_STATE_VERSION` (or your equivalent).
2. Add a step `migrateV1ToV2(state)` that takes v1 and returns v2.
3. Wire it into the chain: `if (version < 2) state = migrateV1ToV2(state)`.
4. Update the reducer to produce v2.

The next time the host reads a row persisted by the older build, the
migrator runs and the reducer sees v2 — no migration script, no
downtime, no `UPDATE` over the table. This is the right pattern for
state that lives in a JSONB column: the schema doesn't change, only
the contents.

The migrator is also called in the `actions` route before the
reducer runs, so a fresh action on an old session also upgrades the
state in the same write — the next read sees v_current without any
extra work.

## Server-only subpath exports (M18)

Plugins that ship server-only helpers (seeders, scheduled jobs,
websocket handlers, anything that pulls in `postgres` or other
Node.js modules via `@lobbyforge/db`) **must not** re-export those
helpers from the main entry point. The main entry is loaded by
the client bundle for any page that calls `getPlugin()` (the room
page, the activity picker, etc.), and pulling `postgres` into the
client bundle breaks the Next.js build with "Can't resolve 'fs'".

The fix is a **subpath export**:

```jsonc
// plugins/hushle/package.json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    },
    "./builtInPacks": {
      "types": "./src/builtInPacks.ts",
      "import": "./src/builtInPacks.ts"
    }
  }
}
```

```ts
// plugins/hushle/src/index.ts (client-safe — no @lobbyforge/db import)
export { HUSHLE_BUILTIN_PACKS, getDefaultPackSlugForLanguage, getLanguageForPackSlug } from './decks';
// Do NOT re-export the seeder from here.
```

```ts
// apps/web/lib/plugin-content-seeder.ts (server-side only)
import { seedBuiltinHushlePacks } from '@lobbyforge/hushle/builtInPacks';
```

The rule: if a plugin helper imports `@lobbyforge/db` (or anything
that transitively imports `postgres`), it goes in a separate file
behind a subpath export. The Hushle `builtInPacks` seeder is the
worked example; every new plugin that adds server-only helpers
should follow the same shape.

## Versioned component data migrations

Official plugins can ship built-in content (card decks, scenario packs,
sound clips) as trusted, versioned data migrations. Hushle's server-only
seeder remains isolated behind its subpath export:

```ts
// plugins/hushle/src/builtInPacks.ts
import { seedBuiltInPacks, type DbClient } from '@lobbyforge/db';
import { HUSHLE_BUILTIN_PACKS } from './decks';

export const HUSHLE_PLUGIN_ID = 'hushle';

export async function seedBuiltinHushlePacks(db: DbClient) {
  return seedBuiltInPacks(db, HUSHLE_PLUGIN_ID, HUSHLE_BUILTIN_PACKS);
}
```

The host registers immutable migrations in
`apps/web/lib/component-migrations.ts`:

```ts
{
  componentType: 'game',
  componentId: 'hushle',
  migrations: [{ version: 1, checksum: 'sha256:<64 hex>', run }],
}
```

The first server-side feature that needs official component content runs these
plans. PostgreSQL transaction advisory locks prevent concurrent instances from
applying the same step twice. Versions must start at 1 and remain contiguous;
checksums are immutable. Schema changes still belong to the host's committed
Drizzle SQL and run before web startup. Next instrumentation must not import the
DB because its development webpack target is Edge-compatible. Untrusted
community plugins do not get raw DB migration callbacks.

## Deferred plugins

`plugins/quiz`, `plugins/vampire-village`, and `plugins/watch-party`
ship as stubs since the M16 plugin SDK minimal work. The stubs
export a single `GamePlugin` and let the registry resolve them, but
they don't yet render custom UI (they fall back to the generic JSON
panel) and they don't ship built-in content yet. Each will be its
own aşama milestone:

- **Quiz** — Aşama 4 quiz MVP is M20+.
- **Vampire Village** — Aşama 4 village mechanics are M21+.
- **Watch Party** — Aşama 4 YouTube / Together sync is M22+.

Until then, Hushle is the only fully-wired game plugin in the
catalog and the only one the `apps/web/lib/plugin-registry.ts`
treats as `installed`/`enabled` by default.

## Reference

- `packages/plugin-sdk/src/index.ts` — the `GamePlugin` type.
- `packages/plugin-sdk/src/locale.ts` — the shared locale helper.
- `packages/plugin-sdk/src/testing.ts` — the `createTestHarness` helper.
- `plugins/hushle/src/index.ts` + `renderClient.tsx` — first fully-UI'd plugin; see
  [`docs/HUSHLE.md`](./HUSHLE.md) for the full Hushle walkthrough.
- `apps/web/lib/plugin-registry.ts` — the host's compiled-in plugin list.
- `apps/web/lib/plugin-context.ts` — the HTTP host's `buildHttpPluginContext`.
- `apps/web/lib/activity-bus.ts` — Redis pub/sub for activity state changes (M19).
- `apps/web/app/api/servers/[id]/activities/[sessionId]/stream/route.ts` — SSE route (M19).
