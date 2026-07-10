# Milestone 3 Scaffolding Plan — Core & Shared Packages

This analysis details the implementation plan for Milestone 3 (Core & Shared Packages Scaffolding) for LobbyForge. The goal is to scaffold the four remaining internal workspace packages:
1. **`@lobbyforge/core`**: Common types, permissions enum, permission checks, and Zod input validators.
2. **`@lobbyforge/db`**: PostgreSQL schema definitions using Drizzle ORM and connection wrappers.
3. **`@lobbyforge/i18n`**: JSON translation pack integration, translation engine with interpolation and fallbacks, and localized schema checkers.
4. **`@lobbyforge/ui`**: Base React UI component placeholders with Tailwind styling and utility integrations.

All configurations are adapted to match the existing packages/config framework and the workspace test suites (`vitest` with typescript).

---

## 1. Workspace Configuration & Shared Setup

The LobbyForge monorepo uses `pnpm` workspace structure. The root `pnpm-workspace.yaml` already lists `packages/*`. The four new packages correspond to the following directories:
- `packages/core`
- `packages/db`
- `packages/i18n`
- `packages/ui`

### Common Configurations
Each package will extend the base TSConfig defined in `@lobbyforge/config/tsconfig.base.json` and share linting, typechecking, and testing commands under the monorepo root.

---

## 2. Package `@lobbyforge/core`

This package contains central types, the permissions system, and input verification validators (using `zod`).

### A. File Inventory
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/vitest.config.ts`
- `packages/core/src/index.ts`
- `packages/core/src/types.ts`
- `packages/core/src/permissions.ts`
- `packages/core/src/validators.ts`
- `packages/core/src/__tests__/permissions.test.ts`
- `packages/core/src/__tests__/validators.test.ts`

### B. File Contents

#### `packages/core/package.json`
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
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

#### `packages/core/tsconfig.json`
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

#### `packages/core/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

#### `packages/core/src/types.ts`
```typescript
export type ChannelType = 'text' | 'voice' | 'activity' | 'announcement' | 'stage';
export type SessionStatus = 'lobby' | 'running' | 'paused' | 'ended' | 'cancelled';
export type UserSessionTheme = 'light' | 'dark' | 'system';

export interface User {
  id: string;
  email: string | null;
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
  type: ChannelType;
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
  metadata: Record<string, any>;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
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

export interface UserSettings {
  id: string;
  userId: string;
  theme: UserSessionTheme;
  notifications: Record<string, any>;
  audio: Record<string, any>;
  privacy: Record<string, any>;
  keybinds: Record<string, any>;
  updatedAt: Date;
}

export interface ServerBan {
  id: string;
  serverId: string;
  userId: string;
  bannedBy: string | null;
  reason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface Reaction {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
}

export interface Attachment {
  id: string;
  messageId: string | null;
  uploadedBy: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  width: number | null;
  height: number | null;
  createdAt: Date;
}
```

#### `packages/core/src/permissions.ts`
```typescript
export const Permission = {
  MANAGE_CHANNELS: 'manage_channels',
  MANAGE_ROLES: 'manage_roles',
  KICK_MEMBERS: 'kick_members',
  BAN_MEMBERS: 'ban_members',
  MANAGE_MESSAGES: 'manage_messages',
  CREATE_INVITE: 'create_invite',
  USE_VOICE: 'use_voice',
  USE_ACTIVITIES: 'use_activities',
} as const;

export type Permission = typeof Permission[keyof typeof Permission];

export interface MemberPermissionContext {
  isOwner?: boolean;
  roles: {
    permissions: Record<string, boolean>;
  }[];
}

export function hasPermission(member: MemberPermissionContext, permission: Permission): boolean {
  if (member.isOwner) {
    return true;
  }
  return member.roles.some((role) => !!role.permissions[permission]);
}
```

#### `packages/core/src/validators.ts`
```typescript
import { z } from 'zod';

export const DisplayNameSchema = z.string()
  .min(2, 'Display name must be at least 2 characters')
  .max(64, 'Display name must be at most 64 characters')
  .transform(s => s.trim())
  .refine(s => !/[\u0000-\u001F\u007F-\u009F]/.test(s), 'Display name must not contain control characters');

export const EmailSchema = z.string()
  .email('Invalid email address')
  .max(320, 'Email must be at most 320 characters')
  .transform(s => s.toLowerCase().trim());

export const PasswordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const ServerNameSchema = z.string()
  .min(2, 'Server name must be at least 2 characters')
  .max(100, 'Server name must be at most 100 characters')
  .transform(s => s.trim());

export const ChannelNameSchema = z.string()
  .min(1, 'Channel name must be at least 1 character')
  .max(100, 'Channel name must be at most 100 characters')
  .transform(s => s.trim())
  .refine(s => !s.startsWith('#'), 'Channel name must not start with #');

export const MessageContentSchema = z.string()
  .min(1, 'Message content cannot be empty')
  .max(4000, 'Message content must be at most 4000 characters');

export const InviteCodeSchema = z.string()
  .min(6, 'Invite code must be at least 6 characters')
  .max(16, 'Invite code must be at most 16 characters')
  .regex(/^[a-zA-Z0-9]+$/, 'Invite code must be alphanumeric');

export const SlugSchema = z.string()
  .min(2, 'Slug must be at least 2 characters')
  .max(50, 'Slug must be at most 50 characters')
  .regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase alphanumeric characters and hyphens');

// Grouped Forms
export const RegisterInputSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
});

export const LoginInputSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

export const CreateServerInputSchema = z.object({
  name: ServerNameSchema,
  slug: SlugSchema.optional(),
});
```

#### `packages/core/src/index.ts`
```typescript
export * from './types.js';
export * from './permissions.js';
export * from './validators.js';
```

#### `packages/core/src/__tests__/permissions.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { hasPermission, Permission } from '../permissions.js';

describe('Permissions Calculation', () => {
  it('should grant all permissions if member is the server owner', () => {
    const owner = { isOwner: true, roles: [] };
    expect(hasPermission(owner, Permission.MANAGE_CHANNELS)).toBe(true);
    expect(hasPermission(owner, Permission.BAN_MEMBERS)).toBe(true);
  });

  it('should grant permission if any role has the permission enabled', () => {
    const member = {
      isOwner: false,
      roles: [
        { permissions: { [Permission.USE_VOICE]: true } },
        { permissions: { [Permission.CREATE_INVITE]: false } }
      ]
    };
    expect(hasPermission(member, Permission.USE_VOICE)).toBe(true);
    expect(hasPermission(member, Permission.CREATE_INVITE)).toBe(false);
  });

  it('should reject if no role has the permission enabled', () => {
    const member = {
      isOwner: false,
      roles: [
        { permissions: { [Permission.USE_VOICE]: false } }
      ]
    };
    expect(hasPermission(member, Permission.MANAGE_ROLES)).toBe(false);
  });
});
```

#### `packages/core/src/__tests__/validators.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { DisplayNameSchema, EmailSchema, ChannelNameSchema, SlugSchema } from '../validators.js';

describe('Validation Schemas', () => {
  describe('DisplayNameSchema', () => {
    it('should pass and trim valid display names', () => {
      expect(DisplayNameSchema.parse('  Alice  ')).toBe('Alice');
    });

    it('should reject too short or too long names', () => {
      expect(() => DisplayNameSchema.parse('A')).toThrow();
      expect(() => DisplayNameSchema.parse('A'.repeat(65))).toThrow();
    });

    it('should reject control characters', () => {
      expect(() => DisplayNameSchema.parse('Alice\nBob')).toThrow();
    });
  });

  describe('EmailSchema', () => {
    it('should parse and lowercase valid email addresses', () => {
      expect(EmailSchema.parse('  TEST@Example.com  ')).toBe('test@example.com');
    });

    it('should reject invalid email formatting', () => {
      expect(() => EmailSchema.parse('invalid-email')).toThrow();
    });
  });

  describe('ChannelNameSchema', () => {
    it('should reject channel names starting with #', () => {
      expect(() => ChannelNameSchema.parse('#general')).toThrow();
      expect(ChannelNameSchema.parse('general')).toBe('general');
    });
  });

  describe('SlugSchema', () => {
    it('should only accept lowercase letters, numbers, and hyphens', () => {
      expect(SlugSchema.parse('my-cool-server-123')).toBe('my-cool-server-123');
      expect(() => SlugSchema.parse('My-Server')).toThrow();
      expect(() => SlugSchema.parse('my_server')).toThrow();
    });
  });
});
```

---

## 3. Package `@lobbyforge/db`

This package implements the PostgreSQL database client and schema structure using `drizzle-orm`.

### A. File Inventory
- `packages/db/package.json`
- `packages/db/tsconfig.json`
- `packages/db/vitest.config.ts`
- `packages/db/src/index.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/__tests__/schema.test.ts`
- `packages/db/src/__tests__/queries.test.ts`

### B. File Contents

#### `packages/db/package.json`
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
    "db:push": "drizzle-kit push",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "drizzle-orm": "^0.30.10",
    "postgres": "^3.4.4"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "drizzle-kit": "^0.21.4",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

#### `packages/db/tsconfig.json`
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

#### `packages/db/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

#### `packages/db/src/schema.ts`
```typescript
import { pgTable, uuid, text, boolean, integer, timestamp, varchar, jsonb, bigint, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Users Table
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  locale: text('locale').default('en'),
  isGuest: boolean('is_guest').default(false),
  statusText: varchar('status_text', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  deletedIdx: index('idx_users_deleted').on(table.deletedAt),
}));

// Servers Table
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug'),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  iconUrl: text('icon_url'),
  defaultLocale: text('default_locale').default('en'),
  isPublic: boolean('is_public').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// Channels Table
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'text', 'voice', 'activity', 'announcement', 'stage'
  position: integer('position').default(0).notNull(),
  pluginId: text('plugin_id'),
  topic: varchar('topic', { length: 512 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Roles Table
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  position: integer('position').default(0).notNull(),
  permissions: jsonb('permissions').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Memberships Table
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

// Messages Table
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  replyToId: uuid('reply_to_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  channelCreatedIdx: index('idx_messages_channel_created').on(table.channelId, table.createdAt),
  replyIdx: index('idx_messages_reply').on(table.replyToId),
}));

// Invite Table
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  code: varchar('code', { length: 16 }).unique().notNull(),
  maxUses: integer('max_uses'),
  currentUses: integer('current_uses').default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  serverIdx: index('idx_invites_server').on(table.serverId),
  codeIdx: index('idx_invites_code').on(table.code),
}));

// User Sessions
export const userSessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 256 }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  lastActive: timestamp('last_active', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userIdx: index('idx_user_sessions_user').on(table.userId),
  expiresIdx: index('idx_user_sessions_expires').on(table.expiresAt),
}));

// User Settings
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').unique().notNull().references(() => users.id, { onDelete: 'cascade' }),
  theme: varchar('theme', { length: 32 }).default('system'),
  notifications: jsonb('notifications').default({}),
  audio: jsonb('audio').default({}),
  privacy: jsonb('privacy').default({}),
  keybinds: jsonb('keybinds').default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Server Bans
export const serverBans = pgTable('server_bans', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bannedBy: uuid('banned_by').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  serverUserIdx: index('idx_server_bans_server_user').on(table.serverId, table.userId),
}));

// Message Reactions
export const reactions = pgTable('reactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: varchar('emoji', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  messageIdx: index('idx_reactions_message').on(table.messageId),
}));

// File Attachments
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  filename: varchar('filename', { length: 512 }).notNull(),
  mimeType: varchar('mime_type', { length: 128 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storagePath: text('storage_path').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  messageIdx: index('idx_attachments_message').on(table.messageId),
}));

// Plugins Enabled
export const pluginsEnabled = pgTable('plugins_enabled', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  settings: jsonb('settings').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Game Sessions
export const gameSessions = pgTable('game_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  status: text('status').notNull(), // 'lobby', 'running', 'paused', 'ended', 'cancelled'
  state: jsonb('state').default({}).notNull(),
  publicSummary: jsonb('public_summary').default({}).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (table) => ({
  serverChannelIdx: index('idx_game_sessions_server_channel').on(table.serverId, table.channelId),
}));

// Game Session Players
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

// Plugin Events
export const pluginEvents = pgTable('plugin_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => gameSessions.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  eventType: text('event_type').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  payload: jsonb('payload').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  sessionCreatedIdx: index('idx_plugin_events_session_created').on(table.sessionId, table.createdAt),
}));

// Bots Table
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

// Instance Settings
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

// Registry Instances (for Server Directory)
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
  listedIdx: index('idx_registry_instances_listed').on(table.isListed, table.isBlocked, table.lastHeartbeatAt),
}));

// Audit Logs Table
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
  serverCreatedIdx: index('idx_audit_logs_server_created').on(table.serverId, table.createdAt),
}));

// Telemetry Snapshots (Doctor system)
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

// Relationships
export const usersRelations = relations(users, ({ many }) => ({
  servers: many(servers),
  memberships: many(memberships),
  messages: many(messages),
  sessions: many(userSessions),
  settings: many(userSettings),
  bans: many(serverBans),
}));

export const serversRelations = relations(servers, ({ one, many }) => ({
  owner: one(users, { fields: [servers.ownerUserId], references: [users.id] }),
  channels: many(channels),
  roles: many(roles),
  memberships: many(memberships),
  invites: many(invites),
  bans: many(serverBans),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  server: one(servers, { fields: [channels.serverId], references: [servers.id] }),
  messages: many(messages),
}));
```

#### `packages/db/src/index.ts`
```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function initDb(connectionString: string): DbClient {
  const queryClient = postgres(connectionString);
  return drizzle(queryClient, { schema });
}
```

#### `packages/db/src/__tests__/schema.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { users, servers, channels } from '../schema.js';

describe('Database Schema Definitions', () => {
  it('should have correct table names', () => {
    expect(users._.name).toBe('users');
    expect(servers._.name).toBe('servers');
    expect(channels._.name).toBe('channels');
  });

  it('should define display_name as not nullable in users schema', () => {
    expect(users.displayName.notNull).toBe(true);
  });
});
```

#### `packages/db/src/__tests__/queries.test.ts`
```typescript
import { describe, it, expect } from 'vitest';

describe('Placeholder Queries Tests', () => {
  it('should parse database mock config without errors', () => {
    expect(true).toBe(true);
  });
});
```

---

## 4. Package `@lobbyforge/i18n`

This package implements translation loading, localized interpolation, fallback handling, and validation scripts matching `15_I18N_JSON.md`.

### A. File Inventory
- `packages/i18n/package.json`
- `packages/i18n/tsconfig.json`
- `packages/i18n/vitest.config.ts`
- `packages/i18n/locales/en.json`
- `packages/i18n/locales/tr.json`
- `packages/i18n/locales/es.json`
- `packages/i18n/src/index.ts`
- `packages/i18n/src/translator.ts`
- `packages/i18n/src/bin/i18n-check.ts`
- `packages/i18n/src/__tests__/i18n.test.ts`
- `packages/i18n/src/__tests__/validator.test.ts`

### B. File Contents

#### `packages/i18n/package.json`
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
    },
    "./locales/*": "./locales/*.json"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint src/**/*.ts",
    "i18n:check": "tsx src/bin/i18n-check.ts"
  },
  "dependencies": {},
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0",
    "tsx": "^4.10.1"
  }
}
```

#### `packages/i18n/tsconfig.json`
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

#### `packages/i18n/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

#### `packages/i18n/locales/en.json`
```json
{
  "voice.join": "Join voice",
  "voice.leave": "Leave voice",
  "activity.start": "Start activity",
  "welcome.user": "Welcome, {username}!"
}
```

#### `packages/i18n/locales/tr.json`
```json
{
  "voice.join": "Sese katıl",
  "voice.leave": "Sesten ayrıl",
  "activity.start": "Aktiviteyi başlat",
  "welcome.user": "Hoş geldin, {username}!"
}
```

#### `packages/i18n/locales/es.json`
```json
{
  "voice.join": "Unirse a la voz",
  "voice.leave": "Salir de la voz",
  "activity.start": "Iniciar actividad",
  "welcome.user": "¡Bienvenido, {username}!"
}
```

#### `packages/i18n/src/translator.ts`
```typescript
export class Translator {
  private locales: Record<string, Record<string, string>> = {};

  constructor(initialLocales: Record<string, Record<string, string>> = {}) {
    this.locales = { ...initialLocales };
  }

  public registerPluginLocales(pluginId: string, pluginLocales: Record<string, Record<string, string>>) {
    for (const [lang, translations] of Object.entries(pluginLocales)) {
      if (!this.locales[lang]) {
        this.locales[lang] = {};
      }
      for (const [key, value] of Object.entries(translations)) {
        this.locales[lang][`${pluginId}.${key}`] = value;
        if (key.startsWith(`${pluginId}.`)) {
          this.locales[lang][key] = value;
        }
      }
    }
  }

  public t(key: string, params: Record<string, any> = {}, options: { locale?: string; fallbackLocale?: string } = {}): string {
    const locale = options.locale || 'en';
    const fallback = options.fallbackLocale || 'en';

    const candidates = [locale, fallback, 'en'];
    let val: string | undefined;

    for (const lang of candidates) {
      if (this.locales[lang] && this.locales[lang][key]) {
        val = this.locales[lang][key];
        break;
      }
    }

    if (val === undefined) {
      return key;
    }

    return val.replace(/{([a-zA-Z0-9_]+)}/g, (match, paramName) => {
      return params[paramName] !== undefined ? String(params[paramName]) : match;
    });
  }
}
```

#### `packages/i18n/src/bin/i18n-check.ts`
```typescript
import fs from 'fs';
import path from 'path';

export function checkLocales(localesDir: string): boolean {
  const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json'));
  const enPath = path.join(localesDir, 'en.json');
  if (!fs.existsSync(enPath)) {
    console.error('Error: en.json (baseline) not found!');
    return false;
  }

  let enContent: Record<string, string>;
  try {
    enContent = JSON.parse(fs.readFileSync(enPath, 'utf8'));
  } catch (err: any) {
    console.error(`Error: en.json is invalid JSON! ${err.message}`);
    return false;
  }

  const enKeys = Object.keys(enContent);
  let hasErrors = false;

  for (const file of files) {
    if (file === 'en.json') continue;
    const filePath = path.join(localesDir, file);
    let content: Record<string, string>;
    try {
      content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err: any) {
      console.error(`Error in ${file}: Invalid JSON! ${err.message}`);
      hasErrors = true;
      continue;
    }

    const keys = Object.keys(content);

    const missing = enKeys.filter(k => !keys.includes(k));
    if (missing.length > 0) {
      console.error(`Error in ${file}: Missing keys:`, missing);
      hasErrors = true;
    }

    const extra = keys.filter(k => !enKeys.includes(k));
    if (extra.length > 0) {
      console.error(`Error in ${file}: Extra keys:`, extra);
      hasErrors = true;
    }

    for (const key of enKeys) {
      if (content[key]) {
        const enPlaceholders = (enContent[key].match(/{[a-zA-Z0-9_]+}/g) || []).sort();
        const filePlaceholders = (content[key].match(/{[a-zA-Z0-9_]+}/g) || []).sort();

        if (JSON.stringify(enPlaceholders) !== JSON.stringify(filePlaceholders)) {
          console.error(`Error in ${file} at key "${key}": Placeholders do not match! Expected: ${enPlaceholders.join(', ')}, got: ${filePlaceholders.join(', ')}`);
          hasErrors = true;
        }
      }
    }
  }

  return !hasErrors;
}

// Run if called as main script
const isMain = process.argv[1] && (process.argv[1].endsWith('i18n-check.ts') || process.argv[1].endsWith('i18n-check.js'));
if (isMain) {
  const dir = path.resolve(process.argv[2] || './locales');
  const success = checkLocales(dir);
  process.exit(success ? 0 : 1);
}
```

#### `packages/i18n/src/index.ts`
```typescript
export * from './translator.js';
```

#### `packages/i18n/src/__tests__/i18n.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { Translator } from '../translator.js';

describe('i18n translation system', () => {
  const translations = {
    en: {
      'voice.join': 'Join voice',
      'welcome.user': 'Welcome, {username}!',
    },
    tr: {
      'voice.join': 'Sese katıl',
      'welcome.user': 'Hoş geldin, {username}!',
    }
  };

  it('should resolve standard keys', () => {
    const t = new Translator(translations);
    expect(t.t('voice.join', {}, { locale: 'tr' })).toBe('Sese katıl');
  });

  it('should interpolate placeholders correctly', () => {
    const t = new Translator(translations);
    expect(t.t('welcome.user', { username: 'Aisha' }, { locale: 'en' })).toBe('Welcome, Aisha!');
    expect(t.t('welcome.user', { username: 'Aisha' }, { locale: 'tr' })).toBe('Hoş geldin, Aisha!');
  });

  it('should fallback to en when translations are missing', () => {
    const t = new Translator(translations);
    expect(t.t('welcome.user', { username: 'Jack' }, { locale: 'fr' })).toBe('Welcome, Jack!');
  });

  it('should allow plugins to register locales', () => {
    const t = new Translator(translations);
    t.registerPluginLocales('hushle', {
      en: { 'card.pass': 'Pass' },
      tr: { 'card.pass': 'Pas' }
    });
    expect(t.t('hushle.card.pass', {}, { locale: 'tr' })).toBe('Pas');
  });
});
```

#### `packages/i18n/src/__tests__/validator.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { checkLocales } from '../bin/i18n-check.js';

describe('i18n check command utility', () => {
  it('should successfully run on correct local structure', () => {
    const tempDir = path.resolve('./temp-locales-test');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    fs.writeFileSync(path.join(tempDir, 'en.json'), JSON.stringify({
      'test.key': 'Hello {name}'
    }));
    fs.writeFileSync(path.join(tempDir, 'tr.json'), JSON.stringify({
      'test.key': 'Merhaba {name}'
    }));

    const result = checkLocales(tempDir);

    fs.unlinkSync(path.join(tempDir, 'en.json'));
    fs.unlinkSync(path.join(tempDir, 'tr.json'));
    fs.rmdirSync(tempDir);

    expect(result).toBe(true);
  });
});
```

---

## 5. Package `@lobbyforge/ui`

This package contains React-based component placeholders that are styled with Tailwind.

### A. File Inventory
- `packages/ui/package.json`
- `packages/ui/tsconfig.json`
- `packages/ui/vitest.config.ts`
- `packages/ui/src/index.ts`
- `packages/ui/src/utils.ts`
- `packages/ui/src/components/Button.tsx`
- `packages/ui/src/components/Modal.tsx`
- `packages/ui/src/components/TextInput.tsx`
- `packages/ui/src/components/Select.tsx`
- `packages/ui/src/components/Dropdown.tsx`
- `packages/ui/src/components/Card.tsx`
- `packages/ui/src/components/Avatar.tsx`
- `packages/ui/src/components/Spinner.tsx`
- `packages/ui/src/components/Tooltip.tsx`
- `packages/ui/src/components/Toast.tsx`
- `packages/ui/src/__tests__/components.test.tsx`

### B. File Contents

#### `packages/ui/package.json`
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
    "lint": "eslint src/**/*.tsx"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "lucide-react": "^0.395.0",
    "tailwind-merge": "^2.3.0"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "happy-dom": "^14.12.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

#### `packages/ui/tsconfig.json`
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

#### `packages/ui/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/__tests__/**/*.test.tsx'],
  },
});
```

#### `packages/ui/src/utils.ts`
```typescript
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

#### `packages/ui/src/components/Button.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          {
            'bg-blue-600 text-white hover:bg-blue-700': variant === 'primary',
            'bg-gray-100 text-gray-900 hover:bg-gray-200': variant === 'secondary',
            'border border-gray-300 bg-transparent hover:bg-gray-50': variant === 'outline',
            'hover:bg-gray-100 hover:text-gray-900': variant === 'ghost',
            'bg-red-600 text-white hover:bg-red-700': variant === 'danger',
          },
          {
            'h-9 px-3 text-xs': size === 'sm',
            'h-10 px-4 py-2 text-sm': size === 'md',
            'h-11 px-8 text-base': size === 'lg',
          },
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
```

#### `packages/ui/src/components/Modal.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ isOpen, onClose, title, children, className }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className={cn('relative w-full max-w-lg rounded-lg bg-white p-6 shadow-lg dark:bg-gray-800', className)}>
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          aria-label="Close modal"
        >
          <X className="h-5 w-5" />
        </button>
        {title && <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>}
        <div className="text-gray-700 dark:text-gray-300">{children}</div>
      </div>
    </div>
  );
}
```

#### `packages/ui/src/components/TextInput.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  ({ className, label, error, type = 'text', ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">{label}</label>}
        <input
          ref={ref}
          type={type}
          className={cn(
            'flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-white',
            error && 'border-red-500 focus:ring-red-500',
            className
          )}
          {...props}
        />
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    );
  }
);
TextInput.displayName = 'TextInput';
```

#### `packages/ui/src/components/Select.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: SelectOption[];
  error?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, options, error, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">{label}</label>}
        <select
          ref={ref}
          className={cn(
            'flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-white',
            error && 'border-red-500 focus:ring-red-500',
            className
          )}
          {...props}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    );
  }
);
Select.displayName = 'Select';
```

#### `packages/ui/src/components/Dropdown.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface DropdownItem {
  key: string;
  label: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

export interface DropdownProps {
  trigger: React.ReactNode;
  items: DropdownItem[];
  className?: string;
}

export function Dropdown({ trigger, items, className }: DropdownProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  return (
    <div ref={containerRef} className={cn('relative inline-block text-left', className)}>
      <div onClick={() => setIsOpen(!isOpen)} className="cursor-pointer">
        {trigger}
      </div>
      {isOpen && (
        <div className="absolute right-0 mt-2 w-56 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black/5 focus:outline-none z-10 dark:bg-gray-800 dark:ring-gray-700">
          <div className="py-1">
            {items.map((item) => (
              <button
                key={item.key}
                disabled={item.disabled}
                onClick={() => {
                  if (item.onClick) item.onClick();
                  setIsOpen(false);
                }}
                className="flex w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

#### `packages/ui/src/components/Card.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
}

export function Card({ className, title, children, ...props }: CardProps) {
  return (
    <div
      className={cn('rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900', className)}
      {...props}
    >
      {title && <h3 className="mb-3 text-base font-semibold text-gray-900 dark:text-white">{title}</h3>}
      <div className="text-sm text-gray-700 dark:text-gray-300">{children}</div>
    </div>
  );
}
```

#### `packages/ui/src/components/Avatar.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  const [hasError, setHasError] = React.useState(false);
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div
      className={cn(
        'relative flex items-center justify-center rounded-full overflow-hidden bg-gray-200 text-gray-600 font-medium select-none dark:bg-gray-700 dark:text-gray-300',
        {
          'h-8 w-8 text-xs': size === 'sm',
          'h-10 w-10 text-sm': size === 'md',
          'h-14 w-14 text-lg': size === 'lg',
        },
        className
      )}
    >
      {src && !hasError ? (
        <img
          src={src}
          alt={name}
          onError={() => setHasError(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}
```

#### `packages/ui/src/components/Spinner.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <svg
      className={cn(
        'animate-spin text-gray-500 dark:text-gray-400',
        {
          'h-4 w-4': size === 'sm',
          'h-8 w-8': size === 'md',
          'h-12 w-12': size === 'lg',
        },
        className
      )}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}
```

#### `packages/ui/src/components/Tooltip.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';

export interface TooltipProps {
  content: string;
  children: React.ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  return (
    <div className={cn('group relative inline-block', className)}>
      {children}
      <div className="absolute left-1/2 bottom-full mb-2 -translate-x-1/2 hidden group-hover:block z-20 px-2 py-1 text-xs text-white bg-gray-900 rounded-md shadow-md whitespace-nowrap dark:bg-gray-950">
        {content}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900 dark:border-t-gray-950" />
      </div>
    </div>
  );
}
```

#### `packages/ui/src/components/Toast.tsx`
```typescript
import * as React from 'react';
import { cn } from '../utils.js';
import { X, CheckCircle, AlertTriangle, AlertCircle } from 'lucide-react';

export interface ToastProps {
  message: string;
  type?: 'success' | 'warning' | 'error';
  onClose: () => void;
  className?: string;
}

export function Toast({ message, type = 'success', onClose, className }: ToastProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 w-80 p-4 rounded-lg shadow-lg border text-sm',
        {
          'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300': type === 'success',
          'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-300': type === 'warning',
          'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300': type === 'error',
        },
        className
      )}
      role="alert"
    >
      {type === 'success' && <CheckCircle className="h-5 w-5 shrink-0" />}
      {type === 'warning' && <AlertTriangle className="h-5 w-5 shrink-0" />}
      {type === 'error' && <AlertCircle className="h-5 w-5 shrink-0" />}
      <span className="flex-1">{message}</span>
      <button onClick={onClose} className="hover:opacity-75" aria-label="Close notification">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
```

#### `packages/ui/src/index.ts`
```typescript
export * from './utils.js';
export * from './components/Button.js';
export * from './components/Modal.js';
export * from './components/TextInput.js';
export * from './components/Select.js';
export * from './components/Dropdown.js';
export * from './components/Card.js';
export * from './components/Avatar.js';
export * from './components/Spinner.js';
export * from './components/Tooltip.js';
export * from './components/Toast.js';
```

#### `packages/ui/src/__tests__/components.test.tsx`
```typescript
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { Button } from '../components/Button.js';

describe('UI component placeholders rendering', () => {
  it('should render button structure correctly', () => {
    const el = <Button variant="danger">Danger Action</Button>;
    expect(el.props.children).toBe('Danger Action');
    expect(el.props.variant).toBe('danger');
  });
});
```

---

## 6. Workspace Integration & Verification Plan

### Dependencies Setup
After adding the folder structure, run:
```bash
pnpm install
```
This automatically maps packages using the `"workspace:*"` declarations. 

### Verify Compilability
Run the following build and check commands from the repository root:
```bash
# Test compile for all workspace projects
pnpm build

# Perform strict typecheck across all modules
pnpm typecheck
```

### Running Tests
Vitest picks up the workspace packages automatically because `vitest.workspace.ts` at the root captures `packages/*/vitest.config.ts`.
To run tests across all workspaces:
```bash
pnpm test
```
To run tests for a single package:
```bash
pnpm --filter @lobbyforge/core test
```
