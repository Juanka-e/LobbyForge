# Plugin Publishing Guide

How to build, publish, and distribute a LobbyForge plugin through the
marketplace — without contributing to the core repository.

## Overview

LobbyForge plugins follow a **two-tier distribution model**:

| Tier | Where | Trust | Example |
|------|-------|-------|---------|
| **Official (in-repo)** | `plugins/` directory, compiled into the app | `official` | Hushle, Quiz |
| **Community (marketplace)** | Published independently, installed dynamically | `verified-community` after review | Your game |

Community plugins do **not** need to be in the LobbyForge repository. You
publish the built bundle on your own hosting (GitHub Releases, CDN, npm) and
submit the URL to the marketplace of the instance that will run it. The
catalog is **per instance**: an entry approved on one instance (including
the official one) does not appear on any other. After that instance's
owner approves it, the owner can install it there.

**Know the limits first.** The marketplace path is off by default and
experimental. A marketplace plugin runs only in the isolated
`plugin-worker` container. It has no panel (`renderClient` is never
called, see ADR-002 in [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)),
all its actions are host-only, and viewers receive its full state. If you
need any of that, compile the plugin into your image instead
([EXTENDING.md §3.3–3.5](EXTENDING.md#33-path-a-compile-your-plugin-into-your-image-recommended)).

## Step 1 — Write the plugin

Use the Plugin SDK. Create a new directory:

```
my-awesome-game/
  package.json
  tsconfig.json
  src/
    index.ts        ← exports `plugin: GamePlugin`
    state.ts         ← your game state types + reducer
    renderClient.tsx ← the React panel (not rendered for marketplace plugins yet)
```

### `package.json`

```json
{
  "name": "my-awesome-game",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "esbuild src/index.ts --bundle --format=esm --platform=node --target=node22 --jsx=automatic --outfile=bundle/index.js"
  },
  "devDependencies": {
    "@lobbyforge/plugin-sdk": "*",
    "esbuild": "^0.28.0",
    "react": "^19"
  }
}
```

**Critical:** the bundle must be **self-contained**. The plugin-worker
imports it from the install directory, where no `node_modules` exist, so
nothing is provided at runtime: `react`, `@lobbyforge/plugin-sdk` and
every other import are bundled into `index.js`. A bundle that leaves one
external is refused at install with `ERR_MODULE_NOT_FOUND … bundle every
dependency`. Inside the LobbyForge monorepo, point `@lobbyforge/plugin-sdk`
at `workspace:*` and run `pnpm build:packages` first.

### `src/index.ts`

```ts
import type { GamePlugin } from '@lobbyforge/plugin-sdk';

export const plugin: GamePlugin<MyState, MyAction, MyProps> = {
  manifest: {
    id: 'my-awesome-game',
    name: 'My Awesome Game',
    version: '1.0.0',
    type: 'game',
    minAppVersion: '0.2.0',
    permissions: ['create_game_session'],
    locales: ['en'],
    entryClient: './renderClient.js',
    catalog: {
      category: 'game',
      summary: 'A fast-paced word guessing game.',
      publisher: 'Your Name',
      trustLevel: 'unverified',
      tags: ['word', 'party', 'fun'],
      playerConfig: {
        minPlayers: 2,
        maxPlayers: 12,
        defaultMaxPlayers: 8,
        supportsSpectators: true,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: true,
    },
  },

  actionPolicies: {
    'start-game': { role: 'host' },
    'submit-guess': { role: 'player' },
  },

  createInitialState: (ctx) => ({ phase: 'lobby', scores: {} }),

  handleAction: (ctx, state, action) => {
    // Your pure reducer logic here
    return state;
  },

  migrateState: (raw) => raw as MyState,

  renderClient: (props) => {
    // Return your React panel JSX here
    return null; // placeholder
  },
};
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "outDir": "./dist",
    "strict": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

## Step 2 — Build

```sh
pnpm install
pnpm build
```

This produces one ESM file, `bundle/index.js`. Check that no package
import is left in it (this should print nothing):

```sh
grep -nE "^import .* from ['\"][^./]" bundle/index.js
```

## Step 3 — Package as a tarball

```sh
tar -czf my-awesome-game-1.0.0.tgz -C bundle .
```

The tarball must contain `index.js` at the root level (no `package/`
wrapper); the installer refuses it otherwise. Verify:

```sh
tar tzf my-awesome-game-1.0.0.tgz | head -5
# Should show: ./ and ./index.js
```

## Step 4 — Publish the tarball

Host the `.tgz` file somewhere publicly accessible:

- **GitHub Releases** (free, versioned, CDN-backed):
  ```sh
  gh release create v1.0.0 my-awesome-game-1.0.0.tgz
  ```
  URL: `https://github.com/you/my-awesome-game/releases/download/v1.0.0/my-awesome-game-1.0.0.tgz`

- **npm** (if you prefer): `npm publish` → URL becomes the tarball download.

- **Your own CDN / S3 / object storage**.

## Step 5 — Submit to the marketplace

On the instance that will run the plugin (the catalog is per instance),
as any signed-in user:

```sh
curl -X POST https://chat.example.com/api/marketplace/submit \
  -H "Origin: https://chat.example.com" \
  -H "Content-Type: application/json" \
  -H "Cookie: lf_guest=..." \
  -d '{
    "pluginId": "my-awesome-game",
    "name": "My Awesome Game",
    "version": "1.0.0",
    "type": "game",
    "publisher": "Your Name",
    "summary": "A fast-paced word guessing game.",
    "category": "game",
    "tags": ["word", "party"],
    "permissions": ["create_game_session"],
    "manifestUrl": "https://github.com/you/my-awesome-game/releases/download/v1.0.0/my-awesome-game-1.0.0.tgz",
    "requiresVoiceRoom": true
  }'
```

There is no submit form; use the API.

## Step 6 — Admin review

Your submission enters the review queue with `reviewStatus: 'pending'`.
The instance owner reviews it at `/admin/moderation`:

- **Approve** → the server downloads the tarball and pins its SHA-256 and
  size; the plugin appears on that instance's `/marketplace` page.
- **Reject** → you get feedback and can resubmit.

Once approved, the instance owner can (with
`LOBBYFORGE_DYNAMIC_PLUGINS_ENABLED=true`):
1. Browse it at `/marketplace`.
2. Click **Install** → the server downloads the tarball again, checks it
   against the pinned digest, extracts it to
   `<LOBBYFORGE_PLUGIN_INSTALL_DIR>/<pluginId>/<version>/` (compose sets
   `/app/plugins/installed`, on the volume the plugin-worker mounts
   read-only), has the worker load that exact version and only then
   records it as the active one.
3. Enable it per server with `POST /api/servers/{id}/apps`
   `{"pluginId":"…","enabled":true}`. The Apps panel and the activity
   picker list compiled-in plugins only.

## Versioning & updates

To release a new version:

1. Bump `version` in your plugin's `manifest` and `package.json`.
2. Build + tarball + publish the new version.
3. Re-submit to the marketplace with the same `pluginId` but new `version`
   + updated `manifestUrl`. The catalog entry is updated and goes back to
   `pending`: it must be approved again (which pins the new bundle)
   before it can be installed.

Installing the new version extracts it next to the old one. The old
version keeps running until the worker has loaded the new one; then the
old folder is deleted. If the worker refuses the new bundle, the old
version stays active. The active version and a digest of its files are
recorded in `<pluginId>/active.json`, and every worker call names that
exact version — the worker refuses anything else. Running sessions carry
on with the new reducer, and their saved state goes through your
`migrateState` first, so version your state.

## Security notes

- Your bundle runs **server-side only**, in the isolated `plugin-worker`
  container: a fresh child process per call with an empty environment, a
  128 MB heap and a 10 s budget, no host secrets, a read-only plugin
  directory and an internal network only. Your panel is not rendered
  (ADR-002). The worker is built for **reviewed** code, not hostile code
  (ADR-001), so expect the instance owner to read your bundle.
- The host turns a crash or timeout in your code into a failed request,
  so it won't take down the API, but you should still test thoroughly.
- `ctx.storage` reaches the host's database through a short-lived
  capability scoped to one community and your plugin.
- Do not import `@lobbyforge/db`, `ioredis`, `postgres`, or any Node-only
  module — your plugin should be a pure reducer + React component.
- The `permissions` array in your manifest declares what your plugin can
  do. Be honest — overstating permissions may delay review.

## Template

A starter repo is planned at `github.com/lobbyforge/plugin-template`. For
now, copy `plugins/hushle/` as a reference — it's a complete, shipping
example.
