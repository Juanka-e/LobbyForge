# Analysis and Recommendations — Config & SDK Scaffolding (Milestone 2)

This document provides complete, copy-pasteable file configurations and code recommendations for `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, and `@lobbyforge/bot-sdk` in the LobbyForge monorepo. It also analyzes the sharing strategy for TypeScript and Vitest configurations.

---

## 1. Analysis: Shared vs Per-Package Configurations

### TypeScript Configurations (`tsconfig.json`)
- **Sharing Strategy**: **Hybrid / Base Inheritance**
  - **Shared Base (`tsconfig.base.json`)**: We recommend defining a single base configuration inside `@lobbyforge/config` (i.e. `packages/config/tsconfig.base.json`). This ensures uniform compilation standards across the monorepo, such as enforcing modern ESM (`module: "NodeNext"`), strict type-checking, source map generation, and declaration output.
  - **Per-Package Config (`tsconfig.json`)**: Each package must have a local `tsconfig.json` extending the shared base. This local config specifies target paths, `outDir` (typically `./dist`), entry points, exclusions (e.g. `node_modules`, `dist`), and specific needs (e.g. `"jsx": "react-jsx"` for React-based environments, which UI/Plugin SDKs need but config/bot-sdk do not).

### Vitest Configurations (`vitest.config.ts`)
- **Sharing Strategy**: **Per-Package Settings with Global Monorepo Workspace Integration**
  - **Root Workspace Integration (`vitest.workspace.ts`)**: We recommend using a Vitest workspace configuration file at the monorepo root. This allows Vitest to automatically detect and run all test files across all folders using `pnpm test` or `pnpm test:unit` from the root.
  - **Per-Package Config (`vitest.config.ts`)**: Each package should have its own local configuration. This is necessary because of environmental differences:
    - Pure TypeScript utility and SDK packages (`@lobbyforge/config`, `@lobbyforge/bot-sdk`) run in the lightweight, fast `"node"` environment.
    - Front-end / UI packages (like `@lobbyforge/ui` or React components in `apps/web`) require a browser-like DOM environment like `"jsdom"` or `"happy-dom"` and support for JSX rendering.
    - Grouping all logic into one monolithic test config makes it difficult to optimize execution speeds or handle target-specific setup files (e.g. Testcontainers for backend integration tests).

---

## 2. Package Recommendation: `@lobbyforge/config`

This package houses the shared TypeScript base configurations and provides basic runtime configuration parsing and validation.

### Required Dependencies
- `dependencies`: `zod` (used for schema-based environment configuration validation)
- `devDependencies`: `typescript`, `vitest`

### Development Scripts
- `build`: `tsc` (compiles source to `./dist`)
- `typecheck`: `tsc --noEmit` (checks types without outputting files)
- `test`: `vitest run` (runs unit tests)

### Files to Create in `packages/config/`

#### 2.1. `package.json`
```json
{
  "name": "@lobbyforge/config",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./tsconfig.base.json": "./tsconfig.base.json"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

#### 2.2. `tsconfig.base.json` (Base configuration extended by other packages)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true
  }
}
```

#### 2.3. `tsconfig.json`
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### 2.4. `vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

#### 2.5. `src/index.ts`
```typescript
import { z } from 'zod';

export const AppConfigSchema = z.object({
  env: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(3000),
  host: z.string().default('localhost'),
  databaseUrl: z.string().url(),
  redisUrl: z.string().url(),
  livekit: z.object({
    url: z.string().url(),
    apiKey: z.string(),
    apiSecret: z.string(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(envSource: Record<string, string | undefined> = process.env): AppConfig {
  return AppConfigSchema.parse({
    env: envSource.NODE_ENV,
    port: envSource.PORT,
    host: envSource.HOST,
    databaseUrl: envSource.DATABASE_URL,
    redisUrl: envSource.REDIS_URL,
    livekit: {
      url: envSource.LIVEKIT_URL,
      apiKey: envSource.LIVEKIT_API_KEY,
      apiSecret: envSource.LIVEKIT_API_SECRET,
    },
  });
}
```

#### 2.6. `src/__tests__/config.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../index';

describe('AppConfig', () => {
  it('should successfully parse valid environment variables', () => {
    const validEnv = {
      NODE_ENV: 'test',
      PORT: '4000',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/lobbyforge',
      REDIS_URL: 'redis://localhost:6379',
      LIVEKIT_URL: 'https://livekit.example.com',
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret',
    };

    const config = loadConfig(validEnv);

    expect(config.env).toBe('test');
    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.livekit.apiKey).toBe('test-key');
  });

  it('should throw validation error when required variables are missing', () => {
    const invalidEnv = {
      NODE_ENV: 'test',
    };

    expect(() => loadConfig(invalidEnv)).toThrow();
  });
});
```

---

## 3. Package Recommendation: `@lobbyforge/plugin-sdk`

Extracted from real plugin interfaces, this SDK standardizes game manifests, lifecycle hooks, host context, and simulation testing utilities.

### Required Dependencies
- `dependencies`: None
- `peerDependencies`: `react` (to type-annotate user interfaces rendering on client side)
- `devDependencies`: `@lobbyforge/config` (from workspace), `@types/react`, `react`, `typescript`, `vitest`

### Development Scripts
- `build`: `tsc`
- `typecheck`: `tsc --noEmit`
- `test`: `vitest run`

### Files to Create in `packages/plugin-sdk/`

#### 3.1. `package.json`
```json
{
  "name": "@lobbyforge/plugin-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "import": "./dist/testing.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "@types/react": "^18.3.3",
    "react": "^18.3.1",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

#### 3.2. `tsconfig.json`
```json
{
  "extends": "@lobbyforge/config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### 3.3. `vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

#### 3.4. `src/index.ts`
```typescript
import { ReactNode } from 'react';

// Plugin Permissions
export type PluginPermission =
  | 'read_room_participants'
  | 'send_room_message'
  | 'create_game_session'
  | 'manage_game_session'
  | 'use_voice_state'
  | 'send_data_channel_event'
  | 'manage_timer'
  | 'manage_scores'
  | 'play_audio_as_bot'
  | 'read_plugin_settings'
  | 'write_plugin_settings';

// Plugin Manifest
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

// Sub-contexts within GamePluginContext
export interface PlayersSubContext {
  list: () => string[];
  get: (playerId: string) => { id: string; name: string } | undefined;
}

export interface MessagesSubContext {
  sendGameMessage: (message: string) => Promise<void>;
}

export interface StateSubContext<T = any> {
  save: (state: T) => Promise<void>;
}

export interface CacheSubContext {
  get: (key: string) => Promise<any>;
  set: (key: string, value: any, ttlSeconds?: number) => Promise<void>;
}

export interface PubSubSubContext {
  publish: (topic: string, data: any) => Promise<void>;
  subscribe: (topic: string, callback: (data: any) => void) => Promise<void>;
}

export interface TimerSubContext {
  start: (seconds: number) => Promise<void>;
  stop: () => Promise<void>;
}

export interface VotesSubContext {
  create: (question: string, options: string[]) => Promise<void>;
}

export interface ScoresSubContext {
  add: (playerId: string, score: number) => Promise<void>;
}

export interface VoiceSubContext {
  getParticipants: () => string[];
}

// Injected by the host
export interface GamePluginContext<TState = any> {
  players: PlayersSubContext;
  messages: MessagesSubContext;
  state: StateSubContext<TState>;
  cache: CacheSubContext;
  pubsub: PubSubSubContext;
  timer: TimerSubContext;
  votes: VotesSubContext;
  scores: ScoresSubContext;
  voice: VoiceSubContext;
}

// Main Interface GamePlugin
export interface GamePlugin<TState = any, TAction = any, TProps = any> {
  manifest: PluginManifest;
  createInitialState: (ctx: GamePluginContext<TState>) => TState;
  handleAction: (ctx: GamePluginContext<TState>, state: TState, action: TAction) => TState;
  renderClient: (props: TProps) => ReactNode;
}
```

#### 3.5. `src/testing.ts` (Testing Helper Stubs / Harness)
```typescript
import { GamePlugin, GamePluginContext } from './index';

export interface TestHarnessOptions<TState, TAction> {
  plugin: GamePlugin<TState, TAction>;
  players: string[];
  settings?: Record<string, any>;
}

export interface TestHarness<TState, TAction> {
  startGame: () => Promise<void>;
  performAction: (playerId: string, action: TAction) => Promise<void>;
  getState: () => TState;
  advanceTimer: (seconds: number) => Promise<void>;
  context: GamePluginContext<TState>;
}

export function createTestHarness<TState = any, TAction = any>(
  options: TestHarnessOptions<TState, TAction>
): TestHarness<TState, TAction> {
  let state: TState;
  let currentTimerSeconds = 0;
  let timerCallback: (() => Promise<void>) | null = null;

  // Mock sub-contexts
  const playersContext = {
    list: () => options.players,
    get: (id: string) => (options.players.includes(id) ? { id, name: `Player ${id}` } : undefined),
  };

  const messagesContext = {
    sendGameMessage: async (msg: string) => {},
  };

  const stateContext = {
    save: async (newState: TState) => {
      state = newState;
    },
  };

  const cacheContext = {
    store: new Map<string, any>(),
    get: async (key: string) => cacheContext.store.get(key),
    set: async (key: string, value: any) => {
      cacheContext.store.set(key, value);
    },
  };

  const pubsubContext = {
    publish: async (topic: string, data: any) => {},
    subscribe: async (topic: string, callback: (data: any) => void) => {},
  };

  const timerContext = {
    start: async (seconds: number) => {
      currentTimerSeconds = seconds;
    },
    stop: async () => {
      currentTimerSeconds = 0;
    },
  };

  const votesContext = {
    create: async (question: string, options: string[]) => {},
  };

  const scoresContext = {
    store: new Map<string, number>(),
    add: async (playerId: string, score: number) => {
      const current = scoresContext.store.get(playerId) || 0;
      scoresContext.store.set(playerId, current + score);
    },
  };

  const voiceContext = {
    getParticipants: () => options.players,
  };

  const context: GamePluginContext<TState> = {
    players: playersContext,
    messages: messagesContext,
    state: stateContext,
    cache: cacheContext,
    pubsub: pubsubContext,
    timer: timerContext,
    votes: votesContext,
    scores: scoresContext,
    voice: voiceContext,
  };

  return {
    context,
    startGame: async () => {
      state = options.plugin.createInitialState(context);
    },
    performAction: async (playerId: string, action: TAction) => {
      state = options.plugin.handleAction(context, state, action);
    },
    getState: () => {
      if (state === undefined) {
        throw new Error('Game has not started yet. Call startGame() first.');
      }
      return state;
    },
    advanceTimer: async (seconds: number) => {
      if (currentTimerSeconds > 0) {
        currentTimerSeconds = Math.max(0, currentTimerSeconds - seconds);
        if (currentTimerSeconds === 0 && timerCallback) {
          await timerCallback();
        }
      }
    },
  };
}
```

#### 3.6. `src/__tests__/plugin-sdk.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { GamePlugin } from '../index';
import { createTestHarness } from '../testing';

interface MockState {
  score: number;
  phase: 'lobby' | 'playing' | 'ended';
}

type MockAction = { type: 'increment' } | { type: 'end' };

const mockPlugin: GamePlugin<MockState, MockAction> = {
  manifest: {
    id: 'mock-plugin',
    name: 'Mock Plugin',
    version: '1.0.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: ['manage_scores'],
    locales: ['en'],
    entryClient: './client.js',
  },
  createInitialState: (ctx) => ({
    score: 0,
    phase: 'lobby',
  }),
  handleAction: (ctx, state, action) => {
    switch (action.type) {
      case 'increment':
        return { ...state, score: state.score + 1 };
      case 'end':
        return { ...state, phase: 'ended' };
      default:
        return state;
    }
  },
  renderClient: () => null,
};

describe('plugin-sdk and createTestHarness', () => {
  it('should initialize and process actions correctly using test harness', async () => {
    const harness = createTestHarness({
      plugin: mockPlugin,
      players: ['player1', 'player2'],
    });

    await harness.startGame();
    expect(harness.getState()).toEqual({ score: 0, phase: 'lobby' });

    await harness.performAction('player1', { type: 'increment' });
    expect(harness.getState().score).toBe(1);

    await harness.performAction('player2', { type: 'end' });
    expect(harness.getState().phase).toBe('ended');
  });

  it('should throw error when accessing state before game start', () => {
    const harness = createTestHarness({
      plugin: mockPlugin,
      players: ['player1'],
    });

    expect(() => harness.getState()).toThrow('Game has not started yet. Call startGame() first.');
  });
});
```

---

## 4. Package Recommendation: `@lobbyforge/bot-sdk`

Defines permission sets, manifests, and lifecycle structures for internal, plugin, and external bots.

### Required Dependencies
- `dependencies`: None
- `devDependencies`: `@lobbyforge/config` (from workspace), `typescript`, `vitest`

### Development Scripts
- `build`: `tsc`
- `typecheck`: `tsc --noEmit`
- `test`: `vitest run`

### Files to Create in `packages/bot-sdk/`

#### 4.1. `package.json`
```json
{
  "name": "@lobbyforge/bot-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

#### 4.2. `tsconfig.json`
```json
{
  "extends": "@lobbyforge/config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### 4.3. `vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

#### 4.4. `src/index.ts`
```typescript
// Bot Permissions
export type BotPermission =
  | 'read_messages'
  | 'send_messages'
  | 'join_voice'
  | 'publish_audio'
  | 'read_presence'
  | 'moderate_messages'
  | 'manage_game_session'
  | 'manage_music_queue'
  | 'read_audit_log';

// Bot Lifecycle States
export type BotLifecycleState = 'idle' | 'connecting' | 'active' | 'disconnected';

// Bot Manifest
export interface BotManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions: BotPermission[];
}

// Bot Message Structure
export interface BotMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: Date;
}

// Bot Events interface
export interface BotEvents {
  onMessage?: (message: BotMessage) => void | Promise<void>;
  onStateChange?: (oldState: BotLifecycleState, newState: BotLifecycleState) => void | Promise<void>;
  onVoiceJoin?: (channelId: string) => void | Promise<void>;
  onVoiceLeave?: (channelId: string) => void | Promise<void>;
}

// Base Bot interface for client and core runtime
export interface Bot {
  manifest: BotManifest;
  state: BotLifecycleState;
  connect: (token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  sendMessage: (channelId: string, content: string) => Promise<void>;
}
```

#### 4.5. `src/__tests__/bot-sdk.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { Bot, BotLifecycleState, BotManifest } from '../index';

class MockBot implements Bot {
  manifest: BotManifest;
  state: BotLifecycleState = 'idle';
  sentMessages: { channelId: string; content: string }[] = [];

  constructor(manifest: BotManifest) {
    this.manifest = manifest;
  }

  async connect(token: string) {
    this.state = 'connecting';
    this.state = 'active';
  }

  async disconnect() {
    this.state = 'disconnected';
  }

  async sendMessage(channelId: string, content: string) {
    if (this.state !== 'active') {
      throw new Error('Bot is not active');
    }
    this.sentMessages.push({ channelId, content });
  }
}

describe('bot-sdk and Bot class compliance', () => {
  it('should manage bot lifecycle state and simulate message sending', async () => {
    const manifest: BotManifest = {
      id: 'music-bot',
      name: 'Music Bot',
      version: '1.0.0',
      permissions: ['join_voice', 'publish_audio'],
    };

    const bot = new MockBot(manifest);
    expect(bot.state).toBe('idle');
    expect(bot.manifest.permissions).toContain('publish_audio');

    await bot.connect('dummy-token');
    expect(bot.state).toBe('active');

    await bot.sendMessage('general-channel', 'Now playing: Ambient Beats');
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.sentMessages[0]).toEqual({
      channelId: 'general-channel',
      content: 'Now playing: Ambient Beats',
    });

    await bot.disconnect();
    expect(bot.state).toBe('disconnected');
  });

  it('should throw error when sending message if bot is not active', async () => {
    const bot = new MockBot({
      id: 'test-bot',
      name: 'Test Bot',
      version: '1.0.0',
      permissions: ['send_messages'],
    });

    await expect(bot.sendMessage('channel-1', 'hello')).rejects.toThrow('Bot is not active');
  });
});
```

---

## 5. Global Monorepo Integration & Verification

To verify all workspaces simultaneously under Vitest and manage dependency links correctly, we propose creating a root workspace definition file for Vitest:

### Root `vitest.workspace.ts`
Create `d:\livekittest\vitest.workspace.ts`:
```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
  'plugins/*/vitest.config.ts'
]);
```

### Verification Command Chain
Once the files are created, the workspace linking and functionality can be verified by running:
1. `pnpm install` — Installs external dependencies and links internal workspaces (`@lobbyforge/config` -> `@lobbyforge/plugin-sdk` & `@lobbyforge/bot-sdk`).
2. `pnpm typecheck` — Type-checks all modules.
3. `pnpm build` — Compiles the SDK files to make sure build configurations are valid and write correct ESM bundles.
4. `pnpm test` or `pnpm test:unit` — Runs the complete set of unit tests in all packages using the global Vitest workspace framework.
