# Milestone 3 Scaffolding Plan — Analysis & Proposals

This document outlines a detailed proposal and design specification for scaffolding the 4 packages of **Milestone 3 (Core & Shared Packages Scaffolding)**:
- `@lobbyforge/core` (core types, permissions)
- `@lobbyforge/db` (db helpers, schema, ORM)
- `@lobbyforge/i18n` (i18n key resolution helpers)
- `@lobbyforge/ui` (ui component placeholders)

Since this is a read-only investigation, the configurations and implementations are outlined below as precise file plans.

---

## Workspace Context and Integration

LobbyForge is configured as a `pnpm` monorepo.
- **pnpm-workspace.yaml**: Automatically recognizes packages under `packages/*`.
- **vitest.workspace.ts**: Automatically picks up workspaces that contain a `vitest.config.ts` matching `packages/*/vitest.config.ts`.
- **package.json (root)**: Runs commands recursively using `pnpm -r --if-present <script>` for build, dev, lint, typecheck, and test.

Adding these four workspaces will seamlessly integrate with the root tasks. The packages extend `@lobbyforge/config/tsconfig.base.json` for compilation settings.

---

## 1. `@lobbyforge/core`

This package houses the shared domain logic, schemas, permissions, and backend primitives.

### Package Configuration: `packages/core/package.json`
```json
{
  "name": "@lobbyforge/core",
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
    "test": "vitest run",
    "lint": "eslint src/**/*.ts"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

### TypeScript Configuration: `packages/core/tsconfig.json`
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

### Testing Configuration: `packages/core/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

### Core Permissions: `packages/core/src/permissions.ts`
```typescript
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

export type CorePermission = typeof CorePermission[keyof typeof CorePermission];

/**
 * Checks if a set of permissions allows a required permission, taking ADMINISTRATOR override into account.
 */
export function hasPermission(
  userPermissions: string[],
  requiredPermission: CorePermission
): boolean {
  if (userPermissions.includes(CorePermission.ADMINISTRATOR)) {
    return true;
  }
  return userPermissions.includes(requiredPermission);
}
```

### Core Domain Types: `packages/core/src/types.ts`
```typescript
export interface User {
  id: string;
  email: string | null;
  passwordHash: string | null;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
  isGuest: boolean;
  statusText: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Server {
  id: string;
  name: string;
  slug: string | null;
  ownerUserId: string;
  iconUrl: string | null;
  defaultLocale: string;
  isPublic: boolean;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: 'text' | 'voice' | 'activity' | 'announcement' | 'stage';
  position: number;
  pluginId: string | null;
  topic: string | null;
  createdAt: Date;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  position: number;
  permissions: Record<string, boolean>;
  createdAt: Date;
}

export interface Membership {
  id: string;
  serverId: string;
  userId: string;
  roleId: string | null;
  nickname: string | null;
  createdAt: Date;
}

export interface Message {
  id: string;
  channelId: string;
  userId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface GameSession {
  id: string;
  serverId: string;
  channelId: string;
  pluginId: string;
  status: 'lobby' | 'running' | 'paused' | 'ended' | 'cancelled';
  state: Record<string, unknown>;
  publicSummary: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface GameSessionPlayer {
  id: string;
  sessionId: string;
  userId: string;
  characterName: string | null;
  characterData: Record<string, unknown>;
  status: string;
  score: number;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface Invite {
  id: string;
  serverId: string;
  createdBy: string | null;
  code: string;
  maxUses: number | null;
  currentUses: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface UserSession {
  id: string;
  userId: string;
  tokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  lastActive: Date;
  expiresAt: Date;
  createdAt: Date;
}
```

### Module Entrypoint: `packages/core/src/index.ts`
```typescript
export * from './permissions';
export * from './types';
```

### Test File: `packages/core/src/__tests__/permissions.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { hasPermission, CorePermission } from '../permissions';

describe('Permissions utility', () => {
  it('should grant permission if exact permission matches', () => {
    const userPerms = [CorePermission.SEND_MESSAGES, CorePermission.CONNECT_VOICE];
    expect(hasPermission(userPerms, CorePermission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(userPerms, CorePermission.CONNECT_VOICE)).toBe(true);
    expect(hasPermission(userPerms, CorePermission.BAN_MEMBERS)).toBe(false);
  });

  it('should bypass checks for administrator role', () => {
    const adminPerms = [CorePermission.ADMINISTRATOR];
    expect(hasPermission(adminPerms, CorePermission.BAN_MEMBERS)).toBe(true);
    expect(hasPermission(adminPerms, CorePermission.MANAGE_SERVER)).toBe(true);
  });
});
```

---

## 2. `@lobbyforge/db`

This package handles database interactions utilizing **Drizzle ORM** targeting **PostgreSQL**.

### Package Configuration: `packages/db/package.json`
```json
{
  "name": "@lobbyforge/db",
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
    "test": "vitest run",
    "lint": "eslint src/**/*.ts",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push"
  },
  "dependencies": {
    "@lobbyforge/config": "workspace:*",
    "@lobbyforge/core": "workspace:*",
    "drizzle-orm": "^0.31.0",
    "postgres": "^3.4.4"
  },
  "devDependencies": {
    "drizzle-kit": "^0.22.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

### TypeScript Configuration: `packages/db/tsconfig.json`
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

### Testing Configuration: `packages/db/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

### Database Schema: `packages/db/src/schema.ts`
```typescript
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, varchar, customType, index } from 'drizzle-orm/pg-core';

// Custom INET type wrapper
const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

// USERS TABLE
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  locale: text('locale').default('en').notNull(),
  isGuest: boolean('is_guest').default(false).notNull(),
  statusText: varchar('status_text', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  deletedIdx: index('idx_users_deleted').on(table.deletedAt).where(table.deletedAt.isNotNull()),
}));

// SERVERS TABLE
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug'),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  iconUrl: text('icon_url'),
  defaultLocale: text('default_locale').default('en').notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// CHANNELS TABLE
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // text, voice, activity, announcement, stage
  position: integer('position').default(0).notNull(),
  pluginId: text('plugin_id'),
  topic: varchar('topic', { length: 512 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ROLES TABLE
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  position: integer('position').default(0).notNull(),
  permissions: jsonb('permissions').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// MEMBERSHIPS TABLE
export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').references(() => roles.id),
  nickname: text('nickname'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  serverUserIdx: index('idx_memberships_server_user').on(table.serverId, table.userId),
}));

// MESSAGES TABLE
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  replyToId: uuid('reply_to_id').references((): any => messages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  channelCreatedIdx: index('idx_messages_channel_created').on(table.channelId, table.createdAt.desc()),
  replyIdx: index('idx_messages_reply').on(table.replyToId).where(table.replyToId.isNotNull()),
}));

// PLUGINS ENABLED TABLE
export const pluginsEnabled = pgTable('plugins_enabled', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  settings: jsonb('settings').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// GAME SESSIONS TABLE
export const gameSessions = pgTable('game_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  status: text('status').notNull(), // lobby, running, paused, ended, cancelled
  state: jsonb('state').default({}).notNull(),
  publicSummary: jsonb('public_summary').default({}).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (table) => ({
  serverChannelIdx: index('idx_game_sessions_server_channel').on(table.serverId, table.channelId),
}));

// GAME SESSION PLAYERS TABLE
export const gameSessionPlayers = pgTable('game_session_players', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => gameSessions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  characterName: text('character_name'),
  characterData: jsonb('character_data').default({}).notNull(),
  status: text('status').default('active').notNull(),
  score: integer('score').default(0).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  leftAt: timestamp('left_at', { withTimezone: true }),
});

// PLUGIN EVENTS TABLE
export const pluginEvents = pgTable('plugin_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => gameSessions.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  eventType: text('event_type').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  payload: jsonb('payload').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sessionCreatedIdx: index('idx_plugin_events_session_created').on(table.sessionId, table.createdAt.desc()),
}));

// BOTS TABLE
export const bots = pgTable('bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  tokenHash: text('token_hash'),
  permissions: jsonb('permissions').default({}).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// INSTANCE SETTINGS TABLE
export const instanceSettings = pgTable('instance_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: text('instance_id').unique().notNull(),
  instanceName: text('instance_name').notNull(),
  domain: text('domain'),
  publicKey: text('public_key'),
  privateKeyEncrypted: text('private_key_encrypted'),
  region: text('region'),
  languages: jsonb('languages').default([]).notNull(),
  tags: jsonb('tags').default([]).notNull(),
  isPublicDirectoryEnabled: boolean('is_public_directory_enabled').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// REGISTRY INSTANCES TABLE
export const registryInstances = pgTable('registry_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: text('instance_id').unique().notNull(),
  name: text('name').notNull(),
  domain: text('domain').notNull(),
  description: text('description'),
  region: text('region'),
  languages: jsonb('languages').default([]).notNull(),
  tags: jsonb('tags').default([]).notNull(),
  features: jsonb('features').default([]).notNull(),
  publicKey: text('public_key').notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  isListed: boolean('is_listed').default(false).notNull(),
  isBlocked: boolean('is_blocked').default(false).notNull(),
  nsfw: boolean('nsfw').default(false).notNull(),
  onlineUsers: integer('online_users').default(0).notNull(),
  publicRoomsCount: integer('public_rooms_count').default(0).notNull(),
  version: text('version'),
  doctorScore: integer('doctor_score'),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  listedHeartbeatIdx: index('idx_registry_instances_listed').on(table.isListed, table.isBlocked, table.lastHeartbeatAt.desc()),
}));

// AUDIT LOGS TABLE
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  serverCreatedIdx: index('idx_audit_logs_server_created').on(table.serverId, table.createdAt.desc()),
}));

// TELEMETRY SNAPSHOTS TABLE
export const telemetrySnapshots = pgTable('telemetry_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: text('instance_id').notNull(),
  cpu: jsonb('cpu').default({}).notNull(),
  memory: jsonb('memory').default({}).notNull(),
  disk: jsonb('disk').default({}).notNull(),
  network: jsonb('network').default({}).notNull(),
  livekit: jsonb('livekit').default({}).notNull(),
  redis: jsonb('redis').default({}).notNull(),
  postgres: jsonb('postgres').default({}).notNull(),
  recommendation: jsonb('recommendation').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// INVITES TABLE
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  code: varchar('code', { length: 16 }).unique().notNull(),
  maxUses: integer('max_uses'),
  currentUses: integer('current_uses').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  serverIdx: index('idx_invites_server').on(table.serverId),
  codeIdx: index('idx_invites_code').on(table.code),
}));

// USER SESSIONS TABLE
export const userSessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 256 }).notNull(),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  lastActive: timestamp('last_active', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('idx_user_sessions_user').on(table.userId),
  expiresIdx: index('idx_user_sessions_expires').on(table.expiresAt),
}));

// USER SETTINGS TABLE
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').unique().notNull().references(() => users.id, { onDelete: 'cascade' }),
  theme: varchar('theme', { length: 32 }).default('system').notNull(),
  notifications: jsonb('notifications').default({}).notNull(),
  audio: jsonb('audio').default({}).notNull(),
  privacy: jsonb('privacy').default({}).notNull(),
  keybinds: jsonb('keybinds').default({}).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// SERVER BANS TABLE
export const serverBans = pgTable('server_bans', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bannedBy: uuid('banned_by').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  serverUserIdx: index('idx_server_bans_server_user').on(table.serverId, table.userId),
}));

// MESSAGE REACTIONS TABLE
export const reactions = pgTable('reactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: varchar('emoji', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  messageIdx: index('idx_reactions_message').on(table.messageId),
}));

// ATTACHMENTS TABLE
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  filename: varchar('filename', { length: 512 }).notNull(),
  mimeType: varchar('mime_type', { length: 128 }).notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storagePath: text('storage_path').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  messageIdx: index('idx_attachments_message').on(table.messageId),
}));
```

### Database Client Initialization: `packages/db/src/client.ts`
```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Initializes and exports a Drizzle DB instance connected to the specified postgres database.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type DbClient = ReturnType<typeof createDb>;
```

### Module Entrypoint: `packages/db/src/index.ts`
```typescript
export * from './schema';
export * from './client';
export { sql, eq, and, or, desc, asc } from 'drizzle-orm';
```

### Test File: `packages/db/src/__tests__/db.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { createDb } from '../client';

describe('Database client setup', () => {
  it('should construct the client wrapper successfully', () => {
    const fakeDbUri = 'postgres://user:pass@localhost:5432/db';
    const db = createDb(fakeDbUri);
    expect(db).toBeDefined();
    expect(db.query).toBeDefined();
  });
});
```

---

## 3. `@lobbyforge/i18n`

This package is responsible for translation files loading, locale fallback routing, parameter interpolation, and translation file format checks.

### Package Configuration: `packages/i18n/package.json`
```json
{
  "name": "@lobbyforge/i18n",
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
    "test": "vitest run",
    "lint": "eslint src/**/*.ts",
    "i18n:check": "vitest run src/__tests__/validator.test.ts"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

### TypeScript Configuration: `packages/i18n/tsconfig.json`
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

### Testing Configuration: `packages/i18n/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

### Default English Locale: `packages/i18n/locales/en.json`
```json
{
  "voice.join": "Join voice",
  "voice.leave": "Leave voice",
  "activity.start": "Start activity",
  "vampire.phase.night": "Night falls...",
  "vampire.phase.day": "The village wakes up.",
  "hushle.card.pass": "Pass",
  "hushle.card.correct": "Correct",
  "welcome.user": "Welcome, {username}!"
}
```

### Turkish Locale: `packages/i18n/locales/tr.json`
```json
{
  "voice.join": "Sese Katıl",
  "voice.leave": "Sesten Ayrıl",
  "activity.start": "Aktiviteyi Başlat",
  "vampire.phase.night": "Gece çöküyor...",
  "vampire.phase.day": "Köy uyanıyor.",
  "hushle.card.pass": "Pas",
  "hushle.card.correct": "Doğru",
  "welcome.user": "Hoş geldin, {username}!"
}
```

### Locale Types Definitions: `packages/i18n/src/locales.ts`
```typescript
import en from '../locales/en.json';
import tr from '../locales/tr.json';

export const localesMap: Record<string, Record<string, string>> = {
  en,
  tr,
};

export type TranslationKey = keyof typeof en;
```

### Translator Helper: `packages/i18n/src/translator.ts`
```typescript
import { localesMap, TranslationKey } from './locales';

/**
 * Resolves a translation key into a localized string, applying parameter substitution.
 * Fallbacks follow: userLocale -> serverDefaultLocale -> 'en'
 */
export function t(
  key: TranslationKey | string,
  params?: Record<string, string | number>,
  locale: string = 'en',
  fallbackLocale: string = 'en'
): string {
  // Resolve localized dictionary with fallback sequence
  let dict = localesMap[locale] || localesMap[fallbackLocale] || localesMap.en;
  let val = dict[key];

  if (val === undefined) {
    dict = localesMap[fallbackLocale] || localesMap.en;
    val = dict[key];
  }

  if (val === undefined) {
    dict = localesMap.en;
    val = dict[key];
  }

  if (val === undefined) {
    return key;
  }

  // Parameter interpolation
  if (params) {
    let interpolated = val;
    for (const [paramKey, paramVal] of Object.entries(params)) {
      interpolated = interpolated.replace(new RegExp(`{${paramKey}}`, 'g'), String(paramVal));
    }
    return interpolated;
  }

  return val;
}
```

### Format Validator: `packages/i18n/src/validator.ts`
```typescript
export interface ValidationResult {
  isValid: boolean;
  missingKeys: string[];
  extraKeys: string[];
  placeholderMismatches: string[];
}

/**
 * Compares a target translation file against the base (source of truth) for keys and placeholders.
 */
export function validateLocale(
  base: Record<string, string>,
  target: Record<string, string>
): ValidationResult {
  const missingKeys: string[] = [];
  const extraKeys: string[] = [];
  const placeholderMismatches: string[] = [];

  const baseKeys = Object.keys(base);
  const targetKeys = Object.keys(target);

  // Search for missing keys and check placeholder lists
  for (const key of baseKeys) {
    if (!(key in target)) {
      missingKeys.push(key);
    } else {
      const basePlaceholders = (base[key].match(/{[^}]+}/g) || []).sort();
      const targetPlaceholders = (target[key].match(/{[^}]+}/g) || []).sort();
      if (JSON.stringify(basePlaceholders) !== JSON.stringify(targetPlaceholders)) {
        placeholderMismatches.push(
          `Key "${key}": expected placeholders [${basePlaceholders.join(', ')}], found [${targetPlaceholders.join(', ')}]`
        );
      }
    }
  }

  // Search for redundant/unrecognized keys
  for (const key of targetKeys) {
    if (!(key in base)) {
      extraKeys.push(key);
    }
  }

  return {
    isValid: missingKeys.length === 0 && extraKeys.length === 0 && placeholderMismatches.length === 0,
    missingKeys,
    extraKeys,
    placeholderMismatches,
  };
}
```

### Module Entrypoint: `packages/i18n/src/index.ts`
```typescript
export * from './locales';
export * from './translator';
export * from './validator';
```

### Translator Test File: `packages/i18n/src/__tests__/translator.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { t } from '../translator';

describe('Translator helper t()', () => {
  it('should translate standard strings', () => {
    expect(t('voice.join', {}, 'en')).toBe('Join voice');
    expect(t('voice.join', {}, 'tr')).toBe('Sese Katıl');
  });

  it('should interpolate placeholders correctly', () => {
    expect(t('welcome.user', { username: 'Alice' }, 'en')).toBe('Welcome, Alice!');
    expect(t('welcome.user', { username: 'Alice' }, 'tr')).toBe('Hoş geldin, Alice!');
  });

  it('should fallback properly for missing keys or missing locales', () => {
    expect(t('nonexistent.key', {}, 'tr')).toBe('nonexistent.key');
    expect(t('voice.join', {}, 'invalid-locale')).toBe('Join voice');
  });
});
```

### Validator Test File: `packages/i18n/src/__tests__/validator.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { validateLocale } from '../validator';
import en from '../../locales/en.json';
import tr from '../../locales/tr.json';

describe('Locale validation tests', () => {
  it('should validate localized files successfully against English base', () => {
    const result = validateLocale(en, tr);
    expect(result.missingKeys).toEqual([]);
    expect(result.extraKeys).toEqual([]);
    expect(result.placeholderMismatches).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('should flag anomalies for broken keys/placeholders', () => {
    const base = { greeting: 'Hello {name}' };
    const badTarget = { greeting: 'Merhaba {username}' };
    const result = validateLocale(base, badTarget);
    expect(result.placeholderMismatches.length).toBe(1);
    expect(result.isValid).toBe(false);
  });
});
```

---

## 4. `@lobbyforge/ui`

This package houses UI component placeholders, shared visual primitives, and uses **React**.

### Package Configuration: `packages/ui/package.json`
```json
{
  "name": "@lobbyforge/ui",
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
    "test": "vitest run",
    "lint": "eslint src/**/*.ts src/**/*.tsx"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@testing-library/react": "^15.0.0",
    "happy-dom": "^14.12.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

### TypeScript Configuration: `packages/ui/tsconfig.json`
*Note: Added `"jsx": "react-jsx"` to compilerOptions so TypeScript can parse React elements.*
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

### Testing Configuration: `packages/ui/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
```

### Component Placeholders

#### 1. Button component: `packages/ui/src/Button.tsx`
```typescript
import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}) => {
  const baseStyle = 'inline-flex items-center justify-center font-medium rounded transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2';
  
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300 focus:ring-gray-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
    ghost: 'bg-transparent text-gray-600 hover:bg-gray-100 focus:ring-gray-300',
  };

  const sizes = {
    sm: 'px-2.5 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  };

  const variantClass = variants[variant] || variants.primary;
  const sizeClass = sizes[size] || sizes.md;

  return (
    <button
      className={`${baseStyle} ${variantClass} ${sizeClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
```

#### 2. Modal component: `packages/ui/src/Modal.tsx`
```typescript
import * as React from 'react';
import { Button } from './Button';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-x-hidden overflow-y-auto outline-none focus:outline-none">
      <div className="fixed inset-0 bg-black opacity-50" onClick={onClose}></div>
      <div className="relative w-full max-w-lg mx-auto my-6 z-50">
        <div className="relative flex flex-col w-full bg-white border border-gray-300 rounded-lg shadow-lg outline-none focus:outline-none">
          <div className="flex items-start justify-between p-5 border-b border-solid border-gray-200 rounded-t">
            <h3 className="text-lg font-semibold">{title}</h3>
            <button
              className="p-1 ml-auto bg-transparent border-0 text-black float-right text-3xl leading-none font-semibold outline-none focus:outline-none"
              onClick={onClose}
            >
              <span className="text-gray-500 hover:text-black">×</span>
            </button>
          </div>
          <div className="relative p-6 flex-auto">
            {children}
          </div>
          <div className="flex items-center justify-end p-4 border-t border-solid border-gray-200 rounded-b">
            {footer || (
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
```

#### 3. Card component: `packages/ui/src/Card.tsx`
```typescript
import * as React from 'react';

export interface CardProps {
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const Card: React.FC<CardProps> = ({ title, children, footer, className = '' }) => {
  return (
    <div className={`bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden ${className}`}>
      {title && (
        <div className="px-5 py-4 border-b border-gray-200 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        </div>
      )}
      <div className="p-5">
        {children}
      </div>
      {footer && (
        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex justify-end">
          {footer}
        </div>
      )}
    </div>
  );
};
```

#### 4. Tooltip component: `packages/ui/src/Tooltip.tsx`
```typescript
import * as React from 'react';

export interface TooltipProps {
  content: string;
  children: React.ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children }) => {
  return (
    <div className="relative group inline-block">
      {children}
      <div className="absolute hidden group-hover:block bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2.5 py-1.5 text-xs text-white bg-gray-800 rounded shadow-md whitespace-nowrap z-40">
        {content}
      </div>
    </div>
  );
};
```

#### 5. Avatar component: `packages/ui/src/Avatar.tsx`
```typescript
import * as React from 'react';

export interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  status?: 'online' | 'offline' | 'idle';
}

export const Avatar: React.FC<AvatarProps> = ({ src, name, size = 'md', status }) => {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const sizes = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-12 h-12 text-base',
  };

  const statusColors = {
    online: 'bg-green-500',
    idle: 'bg-yellow-500',
    offline: 'bg-gray-400',
  };

  const sizeClass = sizes[size] || sizes.md;

  return (
    <div className="relative inline-block">
      {src ? (
        <img
          className={`${sizeClass} rounded-full object-cover`}
          src={src}
          alt={name}
        />
      ) : (
        <div className={`${sizeClass} rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-semibold`}>
          {initials}
        </div>
      )}
      {status && (
        <span className={`absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full ring-2 ring-white ${statusColors[status]}`} />
      )}
    </div>
  );
};
```

#### 6. Spinner component: `packages/ui/src/Spinner.tsx`
```typescript
import * as React from 'react';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 'md' }) => {
  const sizes = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  const sizeClass = sizes[size] || sizes.md;

  return (
    <div className={`animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600 ${sizeClass}`} role="status">
      <span className="sr-only">Loading...</span>
    </div>
  );
};
```

### Module Entrypoint: `packages/ui/src/index.ts`
```typescript
export * from './Button';
export * from './Modal';
export * from './Card';
export * from './Tooltip';
export * from './Avatar';
export * from './Spinner';
```

### Test File: `packages/ui/src/__tests__/Button.test.tsx`
```typescript
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '../Button';

describe('Button component', () => {
  it('renders children and variant styling classes', () => {
    render(<Button variant="danger">Delete</Button>);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('Delete');
    expect(btn.className).toContain('bg-red-600');
  });

  it('triggers click handler when clicked', () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Click Me</Button>);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

---

## 5. Verification Method

Once files are scaffolded, they can be tested via:
1. `pnpm install` from the monorepo root to link the workspaces.
2. `pnpm typecheck` to compile TypeScript across all packages.
3. `pnpm build` to emit output in `dist` folders.
4. `pnpm test` to run Vitest tests inside each package (unit and integration tests), which will be recognized and run via the root `vitest.workspace.ts`.
5. Running `pnpm --filter @lobbyforge/i18n i18n:check` to check localization consistency.
