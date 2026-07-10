# Detailed Analysis and Recommendations: Config & SDK Scaffolding (Milestone 2)

This document details the exact configurations, `package.json`, `tsconfig.json`, `vitest.config.ts`, and source files recommended for scaffolding the `@lobbyforge/config`, `@lobbyforge/plugin-sdk`, and `@lobbyforge/bot-sdk` workspace packages.

---

## 1. Architectural Strategy: Shared vs. Per-Package Settings

In a monorepo workspace environment, balancing consistency with autonomy is crucial. Below is the rationale for how TypeScript (tsconfig) and Vitest settings are distributed.

### A. TypeScript (`tsconfig.json`) Configuration
- **Shared Base File (`@lobbyforge/config/tsconfig.base.json`)**: Contains standard compiler settings (e.g. strict typechecking, Node 22 compatibility, `NodeNext` module resolution, and output definition maps). This ensures code quality is uniform and prevents drift.
- **Per-Package Extensions (`tsconfig.json`)**: Each package has a local configuration that extends the base config. This is required because:
  1. IDEs (such as VS Code/WebStorm) use the root package `tsconfig.json` to define language service boundaries.
  2. Input/output path roots (e.g. `rootDir: "./src"`, `outDir: "./dist"`) are evaluated relative to the file location, so they must be declared in each local package.
- **UI Base Extension (`@lobbyforge/config/tsconfig.react.json`)**: Formulates rules specifically for React apps/packages (like `@lobbyforge/ui` and `apps/web`), defining `"jsx": "react-jsx"` and adding `DOM` libs.

### B. Vitest (`vitest.config.ts`) Configuration
- **Shared Base File (`@lobbyforge/config/vitest.config.ts`)**: Defines global default options, glob patterns for tests, and the 80% coverage threshold.
- **Per-Package Configs (`vitest.config.ts`)**: Each package imports and merges the base configuration using Vitest's `mergeConfig` utility. This allows packages to customize their runtime environment (e.g. `@lobbyforge/ui` uses `jsdom`, while SDKs use `node`) without copying boilerplate.
- **Root Script Alignment**: Since the root `package.json` executes tests via `"test": "pnpm -r --if-present test"`, each package must have its own script and configuration to run locally.

---

## 2. Package 1: `@lobbyforge/config`

This package standardizes configurations across the monorepo.

### A. `packages/config/package.json`
```json
{
  "name": "@lobbyforge/config",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist",
    "tsconfig.base.json",
    "tsconfig.react.json"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./tsconfig.base.json": "./tsconfig.base.json",
    "./tsconfig.react.json": "./tsconfig.react.json",
    "./vitest.config": "./vitest.config.ts"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

### B. `packages/config/tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

### C. `packages/config/tsconfig.react.json`
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx"
  }
}
```

### D. `packages/config/tsconfig.json`
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

### E. `packages/config/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export const baseVitestConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    }
  }
});

export default baseVitestConfig;
```

### F. `packages/config/src/index.ts`
```typescript
/**
 * Global application-wide configuration settings.
 */
export const APP_CONFIG = {
  defaultPort: 3000,
  defaultHost: 'localhost',
  env: process.env.NODE_ENV || 'development'
};
```

### G. `packages/config/src/__tests__/config.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { APP_CONFIG } from '../index';

describe('App Config Defaults', () => {
  it('should resolve standard defaults', () => {
    expect(APP_CONFIG.defaultPort).toBe(3000);
    expect(APP_CONFIG.defaultHost).toBe('localhost');
    expect(APP_CONFIG.env).toBeDefined();
  });
});
```

---

## 3. Package 2: `@lobbyforge/plugin-sdk`

Defines interfaces, contracts, and simulation testing harness for official and third-party plugins.

### A. `packages/plugin-sdk/package.json`
```json
{
  "name": "@lobbyforge/plugin-sdk",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "default": "./dist/testing.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@lobbyforge/config": "workspace:*"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0"
  },
  "peerDependenciesMeta": {
    "react": {
      "optional": true
    }
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "react": "^18.3.1",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

### B. `packages/plugin-sdk/tsconfig.json`
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

### C. `packages/plugin-sdk/vitest.config.ts`
```typescript
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseVitestConfig } from '@lobbyforge/config/vitest.config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      // Injects react rendering context if needed in the future
    }
  })
);
```

### D. `packages/plugin-sdk/src/index.ts`
```typescript
/**
 * Permissions required by a plugin during sandbox verification.
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
  WRITE_PLUGIN_SETTINGS = 'write_plugin_settings'
}

/**
 * Metadata declaring the metadata, entry points, and capabilities.
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

export interface GamePlayer {
  id: string;
  name: string;
  role?: string;
  isHost?: boolean;
}

/**
 * Host services API injected directly into each plugin.
 */
export interface GamePluginContext {
  players: {
    list(): GamePlayer[];
    get(id: string): GamePlayer | undefined;
  };
  messages: {
    sendGameMessage(text: string): Promise<void>;
  };
  state: {
    save(state: any): Promise<void>;
  };
  cache: {
    get<T = any>(key: string): Promise<T | undefined>;
    set(key: string, value: any, ttlSeconds?: number): Promise<void>;
  };
  pubsub: {
    publish(event: string, payload: any): Promise<void>;
    subscribe(event: string, callback: (payload: any) => void): () => void;
  };
  timer: {
    start(durationSeconds: number, onComplete: () => void): string;
    cancel(timerId: string): void;
  };
  votes: {
    create(question: string, options: string[], durationSeconds?: number): Promise<string>;
    submit(voteId: string, playerId: string, optionIndex: number): Promise<void>;
  };
  scores: {
    add(playerId: string, points: number): Promise<void>;
    get(playerId: string): Promise<number>;
    list(): Promise<Record<string, number>>;
  };
  voice: {
    getParticipants(): string[];
  };
}

/**
 * Contract that plugins must export to be managed by the platform.
 * Supports framework-agnostic rendering using TNode (e.g. ReactElement).
 */
export interface GamePlugin<TState = any, TAction = any, TNode = any> {
  manifest: PluginManifest;
  createInitialState(ctx: GamePluginContext): TState;
  handleAction(ctx: GamePluginContext, state: TState, action: TAction): TState;
  renderClient(props: {
    ctx: GamePluginContext;
    state: TState;
    sendAction: (action: TAction) => void;
  }): TNode;
}
```

### E. `packages/plugin-sdk/src/testing.ts`
```typescript
import { GamePlugin, GamePluginContext, GamePlayer } from './index';

export interface HarnessOptions<TPlugin extends GamePlugin = GamePlugin> {
  plugin: TPlugin;
  players: (string | GamePlayer)[];
  settings?: Record<string, any>;
}

/**
 * Standard test runner simulator to test plugins in isolation.
 */
export class PluginTestHarness<TPlugin extends GamePlugin = GamePlugin> {
  public readonly plugin: TPlugin;
  public readonly ctx: GamePluginContext;
  
  private state: any = null;
  private players: GamePlayer[];
  private timers: Map<string, { callback: () => void; remaining: number }> = new Map();
  private messages: string[] = [];
  private scores: Record<string, number> = {};
  private cache: Map<string, any> = new Map();
  private subscribers: Map<string, Set<(payload: any) => void>> = new Map();

  constructor(options: HarnessOptions<TPlugin>) {
    this.plugin = options.plugin;
    this.players = options.players.map((p, idx) => {
      if (typeof p === 'string') {
        return { id: p, name: p, isHost: idx === 0 };
      }
      return p;
    });
    this.players.forEach(p => {
      this.scores[p.id] = 0;
    });
    this.ctx = this.createMockContext();
  }

  private createMockContext(): GamePluginContext {
    return {
      players: {
        list: () => this.players,
        get: (id) => this.players.find(p => p.id === id)
      },
      messages: {
        sendGameMessage: async (text) => {
          this.messages.push(text);
        }
      },
      state: {
        save: async (newState) => {
          this.state = newState;
        }
      },
      cache: {
        get: async (key) => this.cache.get(key),
        set: async (key, value) => {
          this.cache.set(key, value);
        }
      },
      pubsub: {
        publish: async (event, payload) => {
          this.subscribers.get(event)?.forEach(cb => cb(payload));
        },
        subscribe: (event, callback) => {
          if (!this.subscribers.has(event)) {
            this.subscribers.set(event, new Set());
          }
          this.subscribers.get(event)!.add(callback);
          return () => {
            this.subscribers.get(event)?.delete(callback);
          };
        }
      },
      timer: {
        start: (durationSeconds, onComplete) => {
          const id = Math.random().toString(36).substring(2, 9);
          this.timers.set(id, { callback: onComplete, remaining: durationSeconds });
          return id;
        },
        cancel: (id) => {
          this.timers.delete(id);
        }
      },
      votes: {
        create: async (question, options) => {
          return Math.random().toString(36).substring(2, 9);
        },
        submit: async () => {}
      },
      scores: {
        add: async (playerId, points) => {
          this.scores[playerId] = (this.scores[playerId] || 0) + points;
        },
        get: async (playerId) => this.scores[playerId] || 0,
        list: async () => this.scores
      },
      voice: {
        getParticipants: () => this.players.map(p => p.id)
      }
    };
  }

  async startGame(): Promise<void> {
    this.state = this.plugin.createInitialState(this.ctx);
  }

  async performAction(playerId: string, action: any): Promise<void> {
    this.state = this.plugin.handleAction(this.ctx, this.state, { ...action, playerId });
  }

  async advanceTimer(seconds: number): Promise<void> {
    for (const [id, timer] of Array.from(this.timers.entries())) {
      timer.remaining -= seconds;
      if (timer.remaining <= 0) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }

  getState(): any {
    return this.state;
  }

  getMessages(): string[] {
    return this.messages;
  }

  getScores(): Record<string, number> {
    return this.scores;
  }
}

export function createTestHarness<TPlugin extends GamePlugin>(
  options: HarnessOptions<TPlugin>
): PluginTestHarness<TPlugin> {
  return new PluginTestHarness<TPlugin>(options);
}
```

### F. `packages/plugin-sdk/src/__tests__/plugin-sdk.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { PluginPermission, GamePlugin } from '../index';

describe('Plugin SDK Interfaces', () => {
  it('should match matching enum permissions', () => {
    expect(PluginPermission.READ_ROOM_PARTICIPANTS).toBe('read_room_participants');
    expect(PluginPermission.SEND_ROOM_MESSAGE).toBe('send_room_message');
  });

  it('correctly builds type-safe plugin modules', () => {
    const mockPlugin: GamePlugin<{ count: number }, { type: 'inc' }> = {
      manifest: {
        id: 'counter-plugin',
        name: 'Counter',
        version: '1.0.0',
        type: 'game',
        minAppVersion: '1.0.0',
        permissions: [PluginPermission.READ_ROOM_PARTICIPANTS],
        locales: ['en'],
        entryClient: './client.js'
      },
      createInitialState: () => ({ count: 0 }),
      handleAction: (ctx, state, action) => {
        if (action.type === 'inc') return { count: state.count + 1 };
        return state;
      },
      renderClient: () => null
    };

    expect(mockPlugin.manifest.id).toBe('counter-plugin');
  });
});
```

### G. `packages/plugin-sdk/src/__tests__/testing.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { GamePlugin } from '../index';
import { createTestHarness } from '../testing';

describe('Plugin Test Harness Simulation', () => {
  it('correctly simulates timer triggers and state modifications', async () => {
    let fired = false;
    const testPlugin: GamePlugin<{ timerStarted: boolean }, { type: 'start' }> = {
      manifest: {
        id: 'test',
        name: 'test',
        version: '1.0.0',
        type: 'utility',
        minAppVersion: '1.0.0',
        permissions: [],
        locales: ['en'],
        entryClient: 'main.js'
      },
      createInitialState: () => ({ timerStarted: false }),
      handleAction: (ctx, state, action) => {
        if (action.type === 'start') {
          ctx.timer.start(5, () => {
            fired = true;
          });
          return { timerStarted: true };
        }
        return state;
      },
      renderClient: () => null
    };

    const harness = createTestHarness({
      plugin: testPlugin,
      players: ['user1']
    });

    await harness.startGame();
    expect(harness.getState().timerStarted).toBe(false);

    await harness.performAction('user1', { type: 'start' });
    expect(harness.getState().timerStarted).toBe(true);
    expect(fired).toBe(false);

    await harness.advanceTimer(5);
    expect(fired).toBe(true);
  });
});
```

---

## 4. Package 3: `@lobbyforge/bot-sdk`

Defines standard properties and hooks for building modular bots.

### A. `packages/bot-sdk/package.json`
```json
{
  "name": "@lobbyforge/bot-sdk",
  "version": "0.1.0",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@lobbyforge/config": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

### B. `packages/bot-sdk/tsconfig.json`
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

### C. `packages/bot-sdk/vitest.config.ts`
```typescript
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseVitestConfig } from '@lobbyforge/config/vitest.config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      // Custom bot testing settings
    }
  })
);
```

### D. `packages/bot-sdk/src/index.ts`
```typescript
/**
 * Permissions granted to system or third-party bots.
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
  READ_AUDIT_LOG = 'read_audit_log'
}

/**
 * Manifest outlining descriptive info and required permissions.
 */
export interface BotManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions: BotPermission[];
}

/**
 * Lifecycle states representing a bot client connection status.
 */
export type BotLifecycleState = 'idle' | 'connecting' | 'active' | 'disconnected';

/**
 * System integration API context provided to the bot client.
 */
export interface BotContext {
  manifest: BotManifest;
  state: BotLifecycleState;
  sendEvent(event: string, payload: any): Promise<void>;
  onEvent(event: string, callback: (payload: any) => void): () => void;
}

/**
 * Base contract interfaces for bot agents.
 */
export interface BotClient {
  manifest: BotManifest;
  initialize(ctx: BotContext): Promise<void>;
  destroy?(): Promise<void>;
}
```

### E. `packages/bot-sdk/src/__tests__/bot-sdk.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { BotPermission, BotClient, BotContext } from '../index';

describe('Bot SDK Contracts', () => {
  it('exposes exact bot permissions', () => {
    expect(BotPermission.READ_MESSAGES).toBe('read_messages');
    expect(BotPermission.PUBLISH_AUDIO).toBe('publish_audio');
  });

  it('implements a mock BotClient subclass correctly', async () => {
    let initStatus = false;
    const bot: BotClient = {
      manifest: {
        id: 'test-bot',
        name: 'Test',
        version: '1.0',
        permissions: [BotPermission.SEND_MESSAGES]
      },
      initialize: async (ctx) => {
        initStatus = true;
        expect(ctx.state).toBe('active');
      }
    };

    const context: BotContext = {
      manifest: bot.manifest,
      state: 'active',
      sendEvent: async () => {},
      onEvent: () => () => {}
    };

    await bot.initialize(context);
    expect(initStatus).toBe(true);
  });
});
```

---

## 5. Verification Process and CI/CD Commands

To verify that the workspace configuration and package code works correctly, the following terminal commands should be executed at the monorepo root:

1. **Clean Reinstall**:
   ```bash
   pnpm install
   ```
2. **Build Configurations and SDKs**:
   ```bash
   pnpm --filter "@lobbyforge/*" build
   ```
   *Note: This generates transpiled ESM files and declaration types in the respective `dist/` directories.*
3. **Run Verification and Type-Checking**:
   ```bash
   pnpm --filter "@lobbyforge/*" typecheck
   ```
4. **Execute Vitest Unit Tests**:
   ```bash
   pnpm --filter "@lobbyforge/*" test
   ```
   *This commands triggers the `vitest run` script inside each `@lobbyforge` package, running all verification specs and outputting coverage statistics.*
