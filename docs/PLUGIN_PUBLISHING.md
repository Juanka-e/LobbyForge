# Plugin Publishing Guide

How to build, publish and install a LobbyForge plugin through the
marketplace, without contributing to the core repository.

## Overview

LobbyForge plugins follow a **two-tier distribution model**:

| Tier | Where | How it runs | Example |
|------|-------|-------------|---------|
| **Official (in-repo)** | `plugins/`, compiled into the app | in the app process, React panel in the app | Hushle, Quiz |
| **Community (marketplace)** | published by you, installed at runtime | sandboxed: QuickJS in the plugin worker, UI in a sandboxed iframe | your game |

Community plugins do **not** need to be in the LobbyForge repository. You
publish the bundle on your own hosting (GitHub Releases, a CDN) and submit
its URL to the marketplace of the instance that will run it. The catalog
is **per instance**: an entry approved on one instance (including the
official one) does not appear on any other. After that instance's owner
approves it, the owner can install it there.

Since ADR-007 ([ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)) a
marketplace plugin is installed **without trusting its author**:

- its server code (`server.js`) runs in a QuickJS WebAssembly VM inside
  the `plugin-worker` container: plain JavaScript, no Node APIs, no
  network, no file system, no timers, a fresh VM for every call;
- its UI (`ui/`, optional) runs in `<iframe sandbox="allow-scripts">` with
  an opaque origin and no network;
- it gets what official plugins get from the host: action policies
  (`host` / `member` / `player`, `actorFields`, `joinsRoster`, `audit`),
  `validateAction`, and **per-viewer hidden state** through `projectState`.

The marketplace path is still off by default
(`LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true` turns it on), the Apps page and
the activity picker list compiled-in plugins only (enable and start a
marketplace plugin through the API, Step 6), and there is no end-to-end
test on a running stack yet.

## The bundle: `sdk: "sandbox-v1"`

```
my-game/
  manifest.json   ← metadata + action policies (data the host enforces)
  server.js       ← the game logic: plain JavaScript, no imports
  ui/             ← optional: index.html + assets for the sandboxed iframe
    index.html
```

The example in the repository is a complete, working plugin to copy:
[`examples/plugins/sandbox-buzzer/`](../examples/plugins/sandbox-buzzer/).

### `manifest.json`

```json
{
  "id": "sandbox-buzzer",
  "name": "Sandbox Buzzer",
  "version": "0.1.0",
  "sdk": "sandbox-v1",
  "ui": true,
  "minPlayers": 1,
  "maxPlayers": 50,
  "requiresVoiceRoom": true,
  "locales": ["en", "tr"],
  "actionPolicies": {
    "open-round": { "role": "host" },
    "buzz": { "role": "member", "actorFields": ["playerId"], "joinsRoster": true },
    "reveal": { "role": "host" },
    "reset": { "role": "host" }
  }
}
```

| Field | Rules |
|-------|-------|
| `id` | 2–64 characters, letters, digits, `-`, `_`, starting with a letter or digit. Must equal the catalog `pluginId`. Use lowercase. |
| `name` | 1–80 characters. |
| `version` | strict semver (`1.0.0`, `2.0.0-beta.1`). Must equal the catalog `version`. |
| `sdk` | exactly `"sandbox-v1"`. |
| `ui` | `true` or `false`. `true` requires `ui/index.html`. |
| `actionPolicies` | an object (may be empty), at most 64 action types of 1–64 characters (`A-Z a-z 0-9 _ . : -`). Each value: `role` (`host`, `member` or `player`), optional `actorFields` (up to 8 field names; not `type`), `joinsRoster` (boolean), `audit` (boolean), `allowOutsideVoice` (boolean). Unknown keys are refused, so a typo cannot silently fall back to host-only. |
| `minPlayers`, `maxPlayers` | optional integers 1–500, min ≤ max. |
| `requiresVoiceRoom` | optional `true` / `false` (default `false`). `true`: the game is played over voice — the host refuses `member` / `player` actions from anyone who is not in the activity's voice room (403, `code: "voice_required"`), except actions marked `allowOutsideVoice` (leaving). Reading the state (spectating) is never voice-checked, nor are `host` actions. It also turns on host hand-over when the host leaves the room ([PLUGIN_SDK.md → Voice, hosting and play again](PLUGIN_SDK.md#voice-hosting-and-play-again)). |
| `locales` | optional, 1–32 language codes (`en`, `pt-BR`); defaults to `["en"]`. |

Unknown top-level keys are ignored. The manifest is validated by the
installer and again every time the plugin loads; the host enforces **the
manifest's** policies, never anything plugin code says.

Action policies work exactly as for official plugins
([EXTENDING.md §3.2](EXTENDING.md#32-the-contract-packagesplugin-sdksrcindexts)):
an action type that is not listed is host-only; `member` lets any member
who can see the channel send it; `player` requires being on the activity's
roster; `actorFields` are overwritten with the caller's id (so `playerId`
cannot be forged); `joinsRoster` adds the caller to the roster when the
action changes state; `audit` defaults to `true` for host actions only.

### `server.js`

Plain JavaScript (ES2023) that assigns `globalThis.plugin`:

```js
'use strict';

globalThis.plugin = {
  // Required.
  createInitialState(ctx) {
    return { phase: 'idle', round: 0, scores: {} };
  },
  // Required. Pure and synchronous. Return the SAME object to refuse.
  handleAction(ctx, state, action) {
    if (action.type === 'open-round' && state.phase !== 'open') {
      return { ...state, phase: 'open', round: state.round + 1, openedAt: ctx.now };
    }
    return state;
  },
  // Optional: an error string rejects the request with a 400; null accepts.
  validateAction(action) {
    return typeof action.type === 'string' ? null : 'An action needs a type.';
  },
  // Optional: what THIS viewer may see. Without it, the state is public.
  projectState(state, viewerId, ctx) {
    return state;
  },
  // Optional: upgrade an older stored shape. Runs on every read; idempotent.
  migrateState(raw) {
    return raw;
  },
};
```

Rules the sandbox enforces:

- **No imports.** There is no module loader: `require`, `import` and
  `import()` do nothing. Bundle everything into one file if you write
  modules (for example `esbuild src/server.ts --bundle --format=iife
  --platform=neutral --outfile=server.js`, with your entry assigning
  `globalThis.plugin`). Do not bundle `react` or `@lobbyforge/plugin-sdk`
  into `server.js`; neither is usable there.
- **Synchronous.** Return values, never Promises (a Promise fails the
  call). There are no timers.
- **JSON in, JSON out.** Arguments arrive as parsed JSON and results are
  serialised with `JSON.stringify`. `createInitialState`, `handleAction`,
  `migrateState` and `projectState` must return an **object**.
- **Refusing an action**: return the `state` argument itself. The host
  then writes nothing to the roster or the audit log for it.
- **Time and randomness come from `ctx`**: `ctx.now` (ms since the epoch,
  one value per call) and `ctx.random()` (uniform in [0, 1), from the
  host's CSPRNG). `Math.random()` draws from the same values inside a
  call and throws while `server.js` loads. A call gets 1024 values; when
  they run out the call fails, so shuffle large decks in one pass.
- **Nothing persists between calls.** Each call runs in a fresh VM:
  top-level variables are re-initialised every time. The state is your
  only memory. There is no plugin storage in sandbox v1.

`ctx` in `createInitialState` and `handleAction`:

| Field | What it is |
|-------|-----------|
| `players` | `[{ id, name }]` — the activity's roster (plus the caller while a `joinsRoster` action runs) |
| `actorId` | the user performing the call (the creator, for `createInitialState`) |
| `hostId` | the activity's host (its creator) |
| `now` | the server clock, ms |
| `random()` | CSPRNG floats, see above |
| `locale` | the caller's language as a hint (`en`, `tr`, …) |
| `sessionId`, `serverId` | ids of the activity and the community |

`projectState(state, viewerId, ctx)` gets only `ctx.sessionId`,
`ctx.serverId`, `ctx.hostId` and `ctx.now` — no players, no locale, no
random values — because the same projection is served over REST, SSE and
the WebSocket gateway and must not differ between them. Localise in the
UI, not in the projection.

### Hidden information

Every path a viewer reads state through — the activity GET, the SSE
snapshot and updates, the response to their own action, the WebSocket
gateway — calls `projectState(state, viewerId)` for that viewer. Put
secrets in the state and strip them per viewer in `projectState`, the way
the example hides who buzzed until the host reveals. A failed projection
fails the request; it never falls back to the full state.

Without `projectState`, every viewer receives the full state and the lobby
shows "This app doesn't hide information". That is fine for open games
(a shared board, a public scoreboard), wrong for anything with secrets.

### `ui/` (optional)

`ui/index.html` and its assets are served from
`/api/plugin-ui/{pluginId}/{version}/…` into a sandboxed iframe. The page
talks to the lobby with postMessage protocol v1 (`init`, `state`,
`action`, `resize`) and always receives the state **already projected**
for its viewer. Use `@lobbyforge/plugin-sdk/frame`; see "Marketplace
plugin UI (sandboxed iframe)" in [PLUGIN_SDK.md](PLUGIN_SDK.md). Inside
the frame there is no network (`connect-src 'none'`) and no external
script or stylesheet.

## Limits

| What | Limit |
|------|-------|
| VM memory per call | 32 MB (including the parsed state and action) |
| VM stack per call | 256 KiB |
| Time per call | 2 s by default (`PLUGIN_CALL_BUDGET_MS` on the worker); a call that does not return shortly after is killed with its executor thread |
| Result | 4 MiB of JSON |
| Request to the worker | 8 MiB (state + action + ctx) |
| Random values | 1024 per `createInitialState` / `handleAction` call (`PLUGIN_RANDOM_VALUES`) |
| `server.js` | 2 MiB |
| `manifest.json` | 64 KiB |
| Archive | 10 MB compressed, 50 MB unpacked, 500 entries, regular files and folders only |

Keep state in kilobytes: every action and every read passes it through the
VM, and every viewer's read runs `projectState` once. Keep `server.js`
small too: a fresh VM parses it on every call (measured: about 3 ms per
call for the 5 KiB example, about 50 ms for a 500 KiB file).

## Step 1 — Write and test the plugin

Start from the example: copy `examples/plugins/sandbox-buzzer/`, change
`manifest.json`, write `server.js`.

To run your `server.js` through the real sandbox from a checkout of the
LobbyForge repository (after `pnpm install`):

```js
// try-plugin.mjs — run from apps/plugin-worker: node try-plugin.mjs ../../path/to/server.js
import { readFileSync } from 'node:fs';
import { runInSandbox } from './src/sandbox-core.mjs';

const source = readFileSync(process.argv[2], 'utf8');
const call = async (input) => {
  const r = await runInSandbox({
    source, input: JSON.stringify(input),
    budgetMs: 2000, memoryBytes: 32 << 20, stackBytes: 256 << 10, maxOutputBytes: 4 << 20,
  });
  if (!r.ok) throw new Error(`${r.kind}: ${r.error}`);
  return JSON.parse(r.output); // { r: result } or { u: 1 } (refused)
};
const ctx = { players: [{ id: 'u1', name: 'Ann' }], now: Date.now(), hostId: 'u1', actorId: 'u1' };
let { r: state } = await call({ op: 'createInitialState', ctx, random: [0.42] });
console.log(await call({ op: 'handleAction', ctx, state, action: { type: 'open-round' }, random: [0.1, 0.2] }));
console.log(await call({ op: 'projectState', state, viewerId: 'u1', ctx }));
```

`apps/plugin-worker/src/__tests__/sandbox-buzzer.test.ts` tests the example
this way, projection included.

## Step 2 — Pack

```sh
node examples/plugins/sandbox-buzzer/pack.mjs path/to/my-game --out dist
# → dist/my-game-1.0.0.tgz and dist/my-game-1.0.0.tgz.sha256
```

`pack.mjs` has no dependencies; copy it into your project. It checks the
manifest basics, puts `./manifest.json`, `./server.js` and `./ui/…` in a
reproducible archive (same sources, same bytes, so a reviewer can rebuild
the digest), and prints the SHA-256. The installer extracts with
`--strip-components=1`, so the files must sit one level down, as
`./server.js` — which is what `tar -czf my-game-1.0.0.tgz -C my-game .`
also produces. An archive without `manifest.json` and `server.js` at that
root is refused before anything is extracted.

## Step 3 — Publish the tarball

Host the `.tgz` at a public HTTPS URL: GitHub Releases
(`gh release create v1.0.0 dist/my-game-1.0.0.tgz`), a CDN, object
storage. Private, loopback and `.local` / `.internal` hosts are refused.

## Step 4 — Submit to the marketplace

On the instance that will run the plugin, as any signed-in user (there is
no submit form; use the API):

```sh
curl -X POST https://chat.example.com/api/marketplace/submit \
  -H "Origin: https://chat.example.com" \
  -H "Content-Type: application/json" \
  -H "Cookie: lf_guest=..." \
  -d '{
    "pluginId": "my-game",
    "name": "My Game",
    "version": "1.0.0",
    "type": "game",
    "publisher": "Your Name",
    "summary": "A fast-paced guessing game.",
    "category": "game",
    "manifestUrl": "https://github.com/you/my-game/releases/download/v1.0.0/my-game-1.0.0.tgz",
    "requiresVoiceRoom": true
  }'
```

`pluginId` and `version` must equal the manifest's.

## Step 5 — Review and install

The owner reviews the entry at `/admin/moderation`:

- **Approve** → the server downloads the tarball and pins its SHA-256 and
  size; the plugin appears on that instance's `/marketplace` page.
- **Reject** → you get feedback and can resubmit.

With `LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true`, the owner clicks
**Install** on `/marketplace` (or `POST /api/marketplace/install
{"pluginId":"my-game"}`). The server downloads the tarball again, checks it
against the pin, refuses anything but a valid sandbox-v1 bundle for that id
and version, extracts it to
`<LOBBYFORGE_PLUGIN_INSTALL_DIR>/<pluginId>/<version>/`, has the worker
load that exact version and only then records it as active.

## Step 6 — Enable and start

The Apps page and the activity picker list compiled-in plugins only:

```sh
POST /api/servers/{id}/apps                           {"pluginId":"my-game","enabled":true}
POST /api/servers/{id}/channels/{channelId}/activities {"pluginId":"my-game"}
```

## Versioning & updates

1. Bump `version` in `manifest.json`, pack, publish.
2. Re-submit with the same `pluginId`, the new `version` and the new
   `manifestUrl`. The entry goes back to `pending` and must be approved
   again (which pins the new bundle).

Installing the new version extracts it next to the old one. The old
version keeps running until the worker has loaded the new one; then the
old folder is deleted. If the new bundle is refused, the old version stays
active. The active version and a digest of its files are recorded in
`<pluginId>/active.json`, and every worker call names that exact version —
the worker refuses anything else. Running sessions carry on with the new
`server.js`, and their saved state goes through your `migrateState` first,
so version your state.

## Migrating a Node bundle (`index.js`)

Bundles built for the old model — one ESM `index.js` exporting `plugin`,
run as Node in a child process — **no longer install or load**. An active
legacy install stays on disk but is not loaded (the loader logs why). To
migrate:

1. Move `manifest.id`, `name` and `version` into `manifest.json`, add
   `"sdk": "sandbox-v1"`, `"ui"` and your `actionPolicies` (the same
   object you had in the plugin).
2. Turn the plugin object into `globalThis.plugin = { … }` in a plain
   script: no `export`, no `import`. Bundle with
   `--format=iife --platform=neutral` if you used modules.
3. Replace `ctx.players.list()` / `get()` with the `ctx.players` array,
   `Date.now()` with `ctx.now`, `Math.random()` with `ctx.random()`.
   `ctx.storage`, `ctx.messages`, `ctx.timer` and the other stubs do not
   exist in the sandbox.
4. Make every function synchronous and return objects.
5. If your state has secrets, add `projectState`.
6. Drop `renderClient` and React; if you want a UI, ship `ui/` (above).
7. Pack, publish, re-submit, re-install.

## Security notes

- **What the sandbox guarantees.** `server.js` cannot reach Node, the file
  system, the network, the environment, timers or another call's memory;
  each call gets a fresh WebAssembly instance. A loop, a memory bomb or
  runaway recursion fails that call, never the worker. The worker
  container is the outer layer: read-only file system, no capabilities,
  memory and pid caps, no secrets except its own RPC token, and a network
  only the web app joins.
- **Authorization is the host's.** Who may send an action is decided by
  your manifest's `actionPolicies`, as read and validated by the web app;
  `actorFields` are filled in by the host. Your code cannot widen them.
- **What review is still for.** A plugin can show misleading text inside
  its own frame, waste its own call budget (and slow other marketplace
  plugins while it does), or leak its own game's secrets through a careless
  `projectState`. Review the manifest and read `server.js` before
  approving.
- **Your users' data.** The only data your code sees is its own activity
  state, the roster's ids and names, and the ids in `ctx`.
