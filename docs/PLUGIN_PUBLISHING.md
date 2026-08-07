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
submit the URL to the marketplace. After admin review, other instances can
discover and install it.

## Step 1 — Write the plugin

Use the Plugin SDK. Create a new directory:

```
my-awesome-game/
  package.json
  tsconfig.json
  src/
    index.ts        ← exports `plugin: GamePlugin`
    state.ts         ← your game state types + reducer
    renderClient.tsx ← the React panel players see
```

### `package.json`

```json
{
  "name": "my-awesome-game",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc"
  },
  "peerDependencies": {
    "@lobbyforge/plugin-sdk": "*",
    "react": "^19"
  }
}
```

**Critical:** list `@lobbyforge/plugin-sdk` and `react` as
`peerDependencies`, not regular dependencies. The host provides them at
runtime — your bundle must externalize them (not bundle them in).

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

This produces `dist/index.js` (ESM), `dist/renderClient.js`, and type files.
Verify the output is ESM:

```sh
head -1 dist/index.js
# Should start with: import { ... } or export { ... }
```

## Step 3 — Package as a tarball

```sh
cd dist
tar czf ../my-awesome-game-1.0.0.tgz .
cd ..
```

The tarball must contain `index.js` at the root level (no `package/` wrapper).
Verify:

```sh
tar tzf my-awesome-game-1.0.0.tgz | head -5
# Should show: ./index.js, ./renderClient.js, etc.
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

On the official LobbyForge instance:

```sh
curl -X POST https://app.lobbyforge.dev/api/marketplace/submit \
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

Or use the UI at `/marketplace` → "Submit a plugin".

## Step 6 — Admin review

Your submission enters the review queue with `reviewStatus: 'pending'`.
An admin reviews it at `/admin/moderation`:

- **Approve** → plugin appears in the public marketplace browse page.
- **Reject** → you get feedback and can resubmit.

Once approved, any LobbyForge instance admin can:
1. Browse it at `/marketplace`
2. Click **Install** → the server downloads the tarball, extracts it to
   `plugins/installed/<pluginId>/<version>/`, and the dynamic loader picks
   it up at boot (or immediately via reload).
3. Enable it per-server via the existing Apps panel.

## Versioning & updates

To release a new version:

1. Bump `version` in your plugin's `manifest` and `package.json`.
2. Build + tarball + publish the new version.
3. Re-submit to the marketplace with the same `pluginId` but new `version`
   + updated `manifestUrl`. The catalog entry is upserted.

Installing a new version overwrites the old one on disk (the install path
includes the version directory).

## Security notes

- Your bundle runs **server-side** (the reducer) and **client-side** (the
  React panel). It executes in the host process — there is no sandbox.
- The host wraps your `handleAction` and `createInitialState` in `try/catch`
  so a crash won't take down the API, but you should still test thoroughly.
- Do not import `@lobbyforge/db`, `ioredis`, `postgres`, or any Node-only
  module — your plugin should be a pure reducer + React component.
- The `permissions` array in your manifest declares what your plugin can
  do. Be honest — overstating permissions may delay review.

## Template

A starter repo is planned at `github.com/lobbyforge/plugin-template`. For
now, copy `plugins/hushle/` as a reference — it's a complete, shipping
example.
