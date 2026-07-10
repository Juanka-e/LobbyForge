# Monorepo Package Scaffolding Recommendations: `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, and `@lobbyforge/bot-sdk`

This report provides the architectural recommendations, precise configuration definitions, source code files, and testing setups for the foundations of the LobbyForge platform (Milestone 2).

---

## 1. Shared Configuration Strategy Analysis

Managing configurations (TypeScript compilation and Vitest runner execution) across a `pnpm` monorepo requires balancing consistency with flexibility.

### 1.1 TypeScript Configuration (`tsconfig.json`)
* **Recommended Strategy**: **Extensible Shared Configuration Base**.
* **Details**: 
  - Standardizing TS settings across all packages guarantees that runtime behavior, module resolution (e.g. ESM vs CJS), and compiler constraints remain consistent.
  - A base config `tsconfig.base.json` should reside inside `@lobbyforge/config` and be published as part of the package exports.
  - A package-specific config `tsconfig.package.json` (also in `@lobbyforge/config`) sets general compilation directions for libraries (outputting to `dist/`, excluding test files from output build).
  - Each individual package (e.g. `packages/bot-sdk/tsconfig.json`) extends the shared package config and specifies its own `include` paths and paths references if necessary.
* **Benefits**: Prevents config drift, simplifies maintenance, and enables one-line updates for all projects.

### 1.2 Vitest Configuration (`vitest.config.ts`)
* **Recommended Strategy**: **Hybrid Workspace Approach (Per-Package Configs + Root Workspace Config)**.
* **Details**:
  - Pure packages (like `@lobbyforge/config` or `@lobbyforge/bot-sdk`) require a basic Node environment.
  - Interactive/UI packages (like `@lobbyforge/plugin-sdk` or `@lobbyforge/ui`) may depend on React rendering and require browser-like simulation (such as `jsdom`).
  - Running a single configuration at the monorepo root is brittle. Instead, define package-specific `vitest.config.ts` files inside packages that need special environments or setups, and place a `vitest.workspace.ts` file in the monorepo root.
  - The root `vitest.workspace.ts` aggregates all workspaces so that running `pnpm test` at the root tests the entire monorepo in one run.
* **Benefits**: Decouples testing environments for different package types while maintaining a unified developer experience.

---

## 2. Package Recommendation: `@lobbyforge/config`

This package standardizes TypeScript setups and runtime/environment schema configurations across the monorepo.

### 2.1 File Structure
```
packages/config/
├── package.json
├── tsconfig.json
├── tsconfig.base.json
├── tsconfig.package.json
└── src/
    ├── index.ts
    └── __tests__/
        └── config.test.ts
```

### 2.2 File Definitions

#### `packages/config/package.json`
```json
{
  "name": "@lobbyforge/config",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    },
    "./tsconfig.base.json": "./tsconfig.base.json",
    "./tsconfig.package.json": "./tsconfig.package.json"
  },
  "files": [
    "dist",
    "tsconfig.base.json",
    "tsconfig.package.json"
  ],
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts",
    "dev": "tsup src/index.ts --format cjs,esm --dts --watch",
    "lint": "eslint src/**/*.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "tsup": "^8.0.2",
    "vitest": "^1.6.0"
  }
}
```

#### `packages/config/tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

#### `packages/config/tsconfig.package.json`
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "src/__tests__/**/*"]
}
```

#### `packages/config/tsconfig.json`
```json
{
  "extends": "./tsconfig.package.json",
  "include": ["src/**/*"],
  "compilerOptions": {
    "rootDir": "./src"
  }
}
```

#### `packages/config/src/index.ts`
```typescript
import { z } from 'zod';

/**
 * LobbyForge Shared Application Config Schema
 */
export const AppConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(3000),
  databaseUrl: z.string().url().optional(),
  redisUrl: z.string().url().optional(),
  livekit: z.object({
    apiUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
  }).optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Parses environment variables into a typed LobbyForge application configuration.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return AppConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    livekit: env.LIVEKIT_API_URL || env.LIVEKIT_API_KEY || env.LIVEKIT_API_SECRET ? {
      apiUrl: env.LIVEKIT_API_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
    } : undefined,
  });
}
```

#### `packages/config/src/__tests__/config.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../index';

describe('@lobbyforge/config package tests', () => {
  it('should load configuration with default values', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toBeUndefined();
  });

  it('should parse environment overrides correctly', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/db',
      LIVEKIT_API_URL: 'https://livekit.example.com',
    });

    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(8080);
    expect(config.databaseUrl).toBe('postgresql://postgres:pass@localhost:5432/db');
    expect(config.livekit?.apiUrl).toBe('https://livekit.example.com');
  });

  it('should throw validation error on invalid input formats', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow();
  });
});
```

---

## 3. Package Recommendation: `@lobbyforge/plugin-sdk`

This package defines plugin manifests, permission scopes, game contexts, game lifecycle specifications, and provides the test harness utilities.

### 3.1 File Structure
```
packages/plugin-sdk/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── testing.ts
    └── __tests__/
        └── plugin-sdk.test.ts
```

### 3.2 File Definitions

#### `packages/plugin-sdk/package.json`
```json
{
  "name": "@lobbyforge/plugin-sdk",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "import": "./dist/testing.mjs",
      "require": "./dist/testing.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup src/index.ts src/testing.ts --format cjs,esm --dts",
    "dev": "tsup src/index.ts src/testing.ts --format cjs,esm --dts --watch",
    "lint": "eslint src/**/*.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "@types/react": "^18.0.0 || ^19.0.0",
    "typescript": "^5.4.5",
    "tsup": "^8.0.2",
    "vitest": "^1.6.0"
  }
}
```

#### `packages/plugin-sdk/tsconfig.json`
```json
{
  "extends": "@lobbyforge/config/tsconfig.package.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

#### `packages/plugin-sdk/src/index.ts`
```typescript
/**
 * Official and custom activity plugin permission list
 */
export enum PluginPermission {
  READ_ROOM_PARTICIPANTS = 'read_room_participants',
  SEND_ROOM_MESSAGE = 'send_room_message',
  CREATE_GAME_SESSION = 'create_game_session',
  MANAGE_GAME_SESSION = 'manage_game_session',
  USE_VOICE_STATE = 'use_voice_state',
  SEND_DATA_CHANNEL_EVENT = 'send_data_channel_event',
  MANAGE_TIMER = 'manage_timer',
  MANAGE_SCORES = 'manage_scores',
  PLAY_AUDIO_AS_BOT = 'play_audio_as_bot',
  READ_PLUGIN_SETTINGS = 'read_plugin_settings',
  WRITE_PLUGIN_SETTINGS = 'write_plugin_settings',
}

/**
 * Standard plugin manifest description metadata
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: 'game' | 'activity' | 'utility';
  minAppVersion: string;
  permissions: PluginPermission[];
  locales: string[];
  entryClient: string;
  entryServer?: string;
}

/**
 * The execution context supplied to the activity plugin by the parent host container
 */
export interface GamePluginContext {
  players: {
    list(): Array<{ id: string; name: string }>;
  };
  messages: {
    sendGameMessage(message: string): void;
  };
  state: {
    save(state: any): Promise<void>;
  };
  cache: {
    get(key: string): Promise<any>;
    set(key: string, value: any, ttl?: number): Promise<void>;
  };
  pubsub: {
    publish(topic: string, data: any): void;
    subscribe(topic: string, callback: (data: any) => void): () => void;
  };
  timer: {
    start(duration: number, callback?: () => void): void;
    stop(): void;
  };
  votes: {
    create(options: { title: string; choices: string[] }): Promise<any>;
  };
  scores: {
    add(playerId: string, score: number): void;
    get(): Record<string, number>;
  };
  voice: {
    getParticipants(): Array<{ id: string; isSpeaking: boolean; isMuted: boolean }>;
  };
}

/**
 * Core interface that all official/custom game/activity plugins must implement.
 */
export interface GamePlugin<TState = any, TAction = any, TProps = any> {
  manifest: PluginManifest;
  createInitialState(ctx: GamePluginContext): TState;
  handleAction(ctx: GamePluginContext, state: TState, action: TAction): TState;
  renderClient(props: TProps): any; // Renders the client React Node UI view
}
```

#### `packages/plugin-sdk/src/testing.ts`
```typescript
import { GamePlugin, GamePluginContext } from './index';

export interface TestHarnessOptions<TState, TAction> {
  plugin: GamePlugin<TState, TAction, any>;
  players: string[];
  settings?: Record<string, any>;
}

/**
 * Simulates game/activity flow for testing and rapid development cycle validation.
 */
export function createTestHarness<TState, TAction>(options: TestHarnessOptions<TState, TAction>) {
  let state: TState;
  const players = options.players.map(p => ({ id: p, name: p }));
  const scores: Record<string, number> = {};
  let activeTimer: { duration: number; elapsed: number; callback?: () => void } | null = null;
  const pubsubCallbacks = new Map<string, Array<(data: any) => void>>();

  const context: GamePluginContext = {
    players: {
      list: () => players,
    },
    messages: {
      sendGameMessage: (msg: string) => {
        // Mock stdout behavior for game messaging
      },
    },
    state: {
      save: async (newState: any) => {
        state = newState;
      },
    },
    cache: {
      get: async () => undefined,
      set: async () => {},
    },
    pubsub: {
      publish: (topic: string, data: any) => {
        const callbacks = pubsubCallbacks.get(topic) || [];
        callbacks.forEach(cb => cb(data));
      },
      subscribe: (topic: string, callback: (data: any) => void) => {
        const callbacks = pubsubCallbacks.get(topic) || [];
        callbacks.push(callback);
        pubsubCallbacks.set(topic, callbacks);
        return () => {
          const list = pubsubCallbacks.get(topic) || [];
          pubsubCallbacks.set(topic, list.filter(cb => cb !== callback));
        };
      },
    },
    timer: {
      start: (duration: number, callback?: () => void) => {
        activeTimer = { duration, elapsed: 0, callback };
      },
      stop: () => {
        activeTimer = null;
      },
    },
    votes: {
      create: async (opts) => ({ id: 'test-vote-id', ...opts, active: true }),
    },
    scores: {
      add: (playerId: string, amount: number) => {
        scores[playerId] = (scores[playerId] || 0) + amount;
      },
      get: () => scores,
    },
    voice: {
      getParticipants: () => players.map(p => ({ id: p.id, isSpeaking: false, isMuted: false })),
    },
  };

  // Run initial state initializer
  state = options.plugin.createInitialState(context);

  return {
    getContext: () => context,
    getState: () => state,
    startGame: async () => {
      // Stub hook to signal game startup lifecycle phases
    },
    performAction: async (playerId: string, action: TAction) => {
      // Advance and update state
      state = options.plugin.handleAction(context, state, action);
      return state;
    },
    advanceTimer: async (seconds: number) => {
      if (activeTimer) {
        activeTimer.elapsed += seconds;
        if (activeTimer.elapsed >= activeTimer.duration) {
          const cb = activeTimer.callback;
          activeTimer = null;
          if (cb) cb();
        }
      }
    },
  };
}
```

#### `packages/plugin-sdk/src/__tests__/plugin-sdk.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { GamePlugin, PluginPermission } from '../index';
import { createTestHarness } from '../testing';

interface TestState {
  score: number;
  phase: string;
}

type TestAction = { type: 'INCREMENT' } | { type: 'TIMEOUT' };

const testPlugin: GamePlugin<TestState, TestAction> = {
  manifest: {
    id: 'test-game',
    name: 'Test Game',
    version: '0.1.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [PluginPermission.MANAGE_SCORES, PluginPermission.MANAGE_TIMER],
    locales: ['en'],
    entryClient: './index.js',
  },
  createInitialState: () => ({
    score: 0,
    phase: 'lobby',
  }),
  handleAction: (ctx, state, action) => {
    if (action.type === 'INCREMENT') {
      ctx.scores.add('player_1', 10);
      return { ...state, score: state.score + 10, phase: 'running' };
    }
    if (action.type === 'TIMEOUT') {
      return { ...state, phase: 'ended' };
    }
    return state;
  },
  renderClient: () => 'Test UI View',
};

describe('@lobbyforge/plugin-sdk simulation test harness', () => {
  it('should create initial state on load', () => {
    const harness = createTestHarness({
      plugin: testPlugin,
      players: ['player_1', 'player_2'],
    });

    expect(harness.getState().score).toBe(0);
    expect(harness.getState().phase).toBe('lobby');
  });

  it('should accept actions and update state + context scores', async () => {
    const harness = createTestHarness({
      plugin: testPlugin,
      players: ['player_1', 'player_2'],
    });

    const state = await harness.performAction('player_1', { type: 'INCREMENT' });
    expect(state.score).toBe(10);
    expect(state.phase).toBe('running');
    expect(harness.getContext().scores.get()['player_1']).toBe(10);
  });

  it('should handle simulated timer timeouts', async () => {
    const harness = createTestHarness({
      plugin: testPlugin,
      players: ['player_1'],
    });

    let triggered = false;
    harness.getContext().timer.start(5, () => {
      triggered = true;
      harness.performAction('player_1', { type: 'TIMEOUT' });
    });

    await harness.advanceTimer(3);
    expect(triggered).toBe(false);
    expect(harness.getState().phase).toBe('lobby');

    await harness.advanceTimer(2);
    expect(triggered).toBe(true);
    expect(harness.getState().phase).toBe('ended');
  });
});
```

---

## 4. Package Recommendation: `@lobbyforge/bot-sdk`

This package defines permissions, manifests, metadata definitions, and connection states for bots (internal, plugin, and external bot services).

### 4.1 File Structure
```
packages/bot-sdk/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    └── __tests__/
        └── bot-sdk.test.ts
```

### 4.2 File Definitions

#### `packages/bot-sdk/package.json`
```json
{
  "name": "@lobbyforge/bot-sdk",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts",
    "dev": "tsup src/index.ts --format cjs,esm --dts --watch",
    "lint": "eslint src/**/*.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "typescript": "^5.4.5",
    "tsup": "^8.0.2",
    "vitest": "^1.6.0"
  }
}
```

#### `packages/bot-sdk/tsconfig.json`
```json
{
  "extends": "@lobbyforge/config/tsconfig.package.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

#### `packages/bot-sdk/src/index.ts`
```typescript
/**
 * Permissions allocated to Bot users
 */
export enum BotPermission {
  READ_MESSAGES = 'read_messages',
  SEND_MESSAGES = 'send_messages',
  JOIN_VOICE = 'join_voice',
  PUBLISH_AUDIO = 'publish_audio',
  READ_PRESENCE = 'read_presence',
  MODERATE_MESSAGES = 'moderate_messages',
  MANAGE_GAME_SESSION = 'manage_game_session',
  MANAGE_MUSIC_QUEUE = 'manage_music_queue',
  READ_AUDIT_LOG = 'read_audit_log',
}

/**
 * Active lifecycle states of a bot connection session
 */
export type BotLifecycleState = 'idle' | 'connecting' | 'active' | 'disconnected';

/**
 * Metadata definition profile of a bot application
 */
export interface BotManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  permissions: BotPermission[];
  developerName: string;
}

/**
 * Interface representing a running bot process instance
 */
export interface BotInstance {
  manifest: BotManifest;
  state: BotLifecycleState;
  tokenHash?: string;
  connect(roomSessionId: string): Promise<void>;
  disconnect(): Promise<void>;
}
```

#### `packages/bot-sdk/src/__tests__/bot-sdk.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { BotPermission, BotManifest, BotInstance, BotLifecycleState } from '../index';

class MockMusicBot implements BotInstance {
  state: BotLifecycleState = 'idle';
  manifest: BotManifest = {
    id: 'ambient-music-bot',
    name: 'Ambience Player',
    version: '0.1.0',
    permissions: [BotPermission.JOIN_VOICE, BotPermission.PUBLISH_AUDIO],
    developerName: 'LobbyForge System',
  };

  async connect(roomSessionId: string): Promise<void> {
    this.state = 'connecting';
    // Simulate async connection delay
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.state = 'active';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }
}

describe('@lobbyforge/bot-sdk verification tests', () => {
  it('should instantiate and configure bot metadata successfully', () => {
    const bot = new MockMusicBot();
    expect(bot.manifest.id).toBe('ambient-music-bot');
    expect(bot.manifest.permissions).toContain(BotPermission.PUBLISH_AUDIO);
    expect(bot.state).toBe('idle');
  });

  it('should transition through lifecycle states correctly', async () => {
    const bot = new MockMusicBot();
    const connectionPromise = bot.connect('channel-session-123');
    expect(bot.state).toBe('connecting');

    await connectionPromise;
    expect(bot.state).toBe('active');

    await bot.disconnect();
    expect(bot.state).toBe('disconnected');
  });
});
```

---

## 5. Verification Strategy & Root Tasks

### 5.1 Root Workspace Test Configurations

To run all package tests simultaneously from the monorepo root via a single process, a `vitest.workspace.ts` file should be placed at the root of the workspace.

#### `vitest.workspace.ts` (Root)
```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*',
]);
```

### 5.2 Verification Commands

With the structures above, you can verify packages using standard workspace filters:

```bash
# Verify typechecking for all workspaces
pnpm -r typecheck

# Build all package workspaces (creates dist/ bundles)
pnpm -r build

# Run all unit test suites using Vitest
pnpm test
```
