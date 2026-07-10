# Milestone 3 Scaffolding Plan: Core & Shared Packages

This document provides a comprehensive scaffolding plan for the four shared packages under `packages/` required for Milestone 3 of the LobbyForge project:
1. **`@lobbyforge/core`** (Core types, permissions, validation)
2. **`@lobbyforge/db`** (Drizzle ORM schema, connection client)
3. **`@lobbyforge/i18n`** (Language pack translator, key resolution, CI check tooling)
4. **`@lobbyforge/ui`** (Shared React component placeholders and testing)

---

## 1. Monorepo Integration & Workspace Recognition

Because of the project's layout configuration, the workspace integrates these packages automatically without modifications to root configuration files:

- **PNPM Workspaces (`pnpm-workspace.yaml`)**:
  Matches `packages/*` automatically. The new workspaces (`packages/core`, `packages/db`, `packages/i18n`, `packages/ui`) will be detected upon running `pnpm install`.
- **Vitest Workspace (`vitest.workspace.ts`)**:
  Specifies `'packages/*/vitest.config.ts'`. By creating a `vitest.config.ts` in each package's root, Vitest will run tests in these packages as part of the unified test pipeline.
- **Root Build, Test, Typecheck, and Lint Scripts**:
  Root `package.json` scripts use recursive execution (`pnpm -r --if-present <command>`). By aligning our script names (`build`, `typecheck`, `test`, `lint`) inside the new package manifests, the root pipeline will automatically invoke them.

---

## 2. Package Scaffolding: `@lobbyforge/core`

### 2.1 File Path Index
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/vitest.config.ts`
- `packages/core/src/index.ts`
- `packages/core/src/permissions.ts`
- `packages/core/src/validation.ts`
- `packages/core/src/__tests__/permissions.test.ts`
- `packages/core/src/__tests__/validation.test.ts`

### 2.2 File Contents

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
    "uuidv7": "^1.0.1",
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

#### `packages/core/src/permissions.ts`
```typescript
export const Permission = {
  // Server Management
  MANAGE_SERVER: 'manage_server',
  MANAGE_ROLES: 'manage_roles',
  MANAGE_CHANNELS: 'manage_channels',
  
  // Moderation
  KICK_MEMBERS: 'kick_members',
  BAN_MEMBERS: 'ban_members',
  MODERATE_MEMBERS: 'moderate_members', // mute, deafen, nickname
  
  // Messages
  SEND_MESSAGES: 'send_messages',
  MANAGE_MESSAGES: 'manage_messages', // delete others' messages
  ADD_REACTIONS: 'add_reactions',
  
  // Voice & Activities
  CONNECT: 'connect',
  SPEAK: 'speak',
  START_ACTIVITY: 'start_activity',
  
  // General & Auditing
  CREATE_INVITE: 'create_invite',
  VIEW_AUDIT_LOG: 'view_audit_log',
} as const;

export type Permission = typeof Permission[keyof typeof Permission];

export interface MemberRole {
  permissions: Record<string, boolean>;
}

export interface ServerMember {
  isOwner: boolean;
  roles: MemberRole[];
}

/**
 * Checks if a member has a specific permission.
 * Owners have override bypass permissions for all actions.
 */
export function hasPermission(member: ServerMember, permission: Permission): boolean {
  if (member.isOwner) {
    return true;
  }
  return member.roles.some((role) => !!role.permissions[permission]);
}
```

#### `packages/core/src/validation.ts`
```typescript
import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.string().email().max(320).toLowerCase(),
  displayName: z.string().min(2).max(64).trim(),
  password: z.string().min(8).max(128),
});

export const createServerSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  iconUrl: z.string().url().optional(),
  defaultLocale: z.string().default('en'),
  isPublic: z.boolean().default(false),
});

export const createChannelSchema = z.object({
  serverId: z.string().uuid(),
  name: z.string().min(1).max(100).trim(),
  type: z.enum(['text', 'voice', 'activity', 'announcement', 'stage']),
  position: z.number().int().nonnegative().default(0),
  pluginId: z.string().optional(),
  topic: z.string().max(512).optional(),
});

export const sendMessageSchema = z.object({
  channelId: z.string().uuid(),
  content: z.string().min(1).max(4000),
  replyToId: z.string().uuid().optional(),
});

export const createInviteSchema = z.object({
  serverId: z.string().uuid(),
  maxUses: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
```

#### `packages/core/src/index.ts`
```typescript
export * from './permissions';
export * from './validation';
```

### 2.3 Tests

#### `packages/core/src/__tests__/permissions.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { hasPermission, Permission, ServerMember } from '../permissions';

describe('Permissions Evaluation Engine', () => {
  it('should grant server owners all permissions unconditionally', () => {
    const owner: ServerMember = { isOwner: true, roles: [] };
    expect(hasPermission(owner, Permission.MANAGE_SERVER)).toBe(true);
    expect(hasPermission(owner, Permission.BAN_MEMBERS)).toBe(true);
  });

  it('should verify roles matching the specific permission', () => {
    const moderator: ServerMember = {
      isOwner: false,
      roles: [{ permissions: { [Permission.KICK_MEMBERS]: true } }],
    };
    expect(hasPermission(moderator, Permission.KICK_MEMBERS)).toBe(true);
    expect(hasPermission(moderator, Permission.BAN_MEMBERS)).toBe(false);
  });

  it('should aggregate multiple roles permissions', () => {
    const user: ServerMember = {
      isOwner: false,
      roles: [
        { permissions: { [Permission.SEND_MESSAGES]: true } },
        { permissions: { [Permission.CONNECT]: true } },
      ],
    };
    expect(hasPermission(user, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(user, Permission.CONNECT)).toBe(true);
    expect(hasPermission(user, Permission.SPEAK)).toBe(false);
  });
});
```

#### `packages/core/src/__tests__/validation.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { createServerSchema, createUserSchema } from '../validation';

describe('Validation Schemas', () => {
  it('should validate correctly formatted emails and names', () => {
    const result = createUserSchema.safeParse({
      email: 'Test@LobbyForge.org',
      displayName: 'ForgeDev',
      password: 'secure-password-hash-argon',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('test@lobbyforge.org');
    }
  });

  it('should reject servers with invalid slugs', () => {
    const result = createServerSchema.safeParse({
      name: 'Forge Community',
      slug: 'Forge Community!', // invalid chars
    });
    expect(result.success).toBe(false);
  });
});
```

---

## 3. Package Scaffolding: `@lobbyforge/db`

### 3.1 File Path Index
- `packages/db/package.json`
- `packages/db/tsconfig.json`
- `packages/db/vitest.config.ts`
- `packages/db/src/index.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/client.ts`
- `packages/db/src/__tests__/db.test.ts`

### 3.2 File Contents

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
import { pgTable, uuid, text, boolean, integer, timestamp, varchar, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Users table
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  locale: text('locale').default('en'),
  isGuest: boolean('is_guest').default(false),
  statusText: varchar('status_text', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// Servers table
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug'),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  iconUrl: text('icon_url'),
  defaultLocale: text('default_locale').default('en'),
  isPublic: boolean('is_public').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// Channels table
export const channels = pgTable('channels', {
  id: uuid('id').primaryKey(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'text' | 'voice' | 'activity' | 'announcement' | 'stage'
  position: integer('position').notNull().default(0),
  pluginId: text('plugin_id'),
  topic: varchar('topic', { length: 512 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Roles table
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  position: integer('position').notNull().default(0),
  permissions: jsonb('permissions').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Memberships table
export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').references(() => roles.id),
  nickname: text('nickname'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Messages table
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  replyToId: uuid('reply_to_id').references(() => messages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// Invites table
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  code: varchar('code', { length: 16 }).unique().notNull(),
  maxUses: integer('max_uses'),
  currentUses: integer('current_uses').default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Relations declarations
export const userRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  serversOwned: many(servers),
}));

export const serverRelations = relations(servers, ({ one, many }) => ({
  owner: one(users, { fields: [servers.ownerUserId], referenceFields: [users.id] }),
  channels: many(channels),
  memberships: many(memberships),
  roles: many(roles),
}));
```

#### `packages/db/src/client.ts`
```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { AppConfig } from '@lobbyforge/config';

let client: postgres.Sql | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb(config: AppConfig) {
  if (!db) {
    client = postgres(config.databaseUrl);
    db = drizzle(client, { schema });
  }
  return db;
}

export async function closeDb() {
  if (client) {
    await client.end();
    client = null;
    db = null;
  }
}
```

#### `packages/db/src/index.ts`
```typescript
export * from './schema';
export * from './client';
```

### 3.3 Tests

#### `packages/db/src/__tests__/db.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { users, servers } from '../schema';

describe('Database Schema Compilation', () => {
  it('should compile tables with exact DB structural attributes', () => {
    expect(users.email.name).toBe('email');
    expect(servers.ownerUserId.name).toBe('owner_user_id');
  });
});
```

---

## 4. Package Scaffolding: `@lobbyforge/i18n`

### 4.1 File Path Index
- `packages/i18n/package.json`
- `packages/i18n/tsconfig.json`
- `packages/i18n/vitest.config.ts`
- `packages/i18n/src/index.ts`
- `packages/i18n/src/translator.ts`
- `packages/i18n/locales/en.json`
- `packages/i18n/locales/tr.json`
- `packages/i18n/scripts/check-i18n.ts`
- `packages/i18n/src/__tests__/i18n.test.ts`

### 4.2 File Contents

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
    "./locales/*": "./locales/*"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint src/**/*.ts",
    "i18n:check": "node --loader ts-node/esm scripts/check-i18n.ts"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "ts-node": "^10.9.2",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
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
  "include": ["src/**/*", "scripts/**/*"],
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
  "voice.join": "Join Voice",
  "voice.leave": "Leave Voice",
  "activity.start": "Start Activity",
  "user.welcome": "Welcome back, {username}!"
}
```

#### `packages/i18n/locales/tr.json`
```json
{
  "voice.join": "Sese Katıl",
  "voice.leave": "Sesten Ayrıl",
  "activity.start": "Aktiviteyi Başlat",
  "user.welcome": "Tekrar hoş geldin, {username}!"
}
```

#### `packages/i18n/src/translator.ts`
```typescript
export type Translations = Record<string, string>;

export class Translator {
  private translations: Map<string, Translations> = new Map();
  private defaultLocale: string;

  constructor(defaultLocale: string = 'en') {
    this.defaultLocale = defaultLocale;
  }

  registerLocale(locale: string, translations: Translations) {
    this.translations.set(locale, translations);
  }

  /**
   * Resolves a key to the target locale translation string.
   * Fallback sequence: target locale -> server default locale -> en -> raw key string.
   */
  translate(locale: string, key: string, placeholders: Record<string, string | number> = {}): string {
    const localesToTry = [locale, this.defaultLocale, 'en'];
    let template: string | undefined;

    for (const l of localesToTry) {
      const trans = this.translations.get(l);
      if (trans && trans[key]) {
        template = trans[key];
        break;
      }
    }

    if (!template) {
      return key;
    }

    // Basic bracket placeholder interpolation, e.g., {username}
    return template.replace(/\{(\w+)\}/g, (match, param) => {
      const val = placeholders[param];
      return val !== undefined ? String(val) : match;
    });
  }
}
```

#### `packages/i18n/src/index.ts`
```typescript
export * from './translator';
```

#### `packages/i18n/scripts/check-i18n.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, '../locales');

function checkLocales() {
  const files = fs.readdirSync(localesDir).filter(file => file.endsWith('.json'));
  const masterFile = 'en.json';
  
  if (!files.includes(masterFile)) {
    console.error(`Master file ${masterFile} not found!`);
    process.exit(1);
  }

  const masterPath = path.join(localesDir, masterFile);
  const masterKeys = Object.keys(JSON.parse(fs.readFileSync(masterPath, 'utf8')));
  let hasError = false;

  for (const file of files) {
    if (file === masterFile) continue;
    
    const filePath = path.join(localesDir, file);
    let content;
    try {
      content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e: any) {
      console.error(`❌ Invalid JSON structure in ${file}:`, e.message);
      hasError = true;
      continue;
    }

    const currentKeys = Object.keys(content);
    
    // Check for missing keys
    const missingKeys = masterKeys.filter(key => !currentKeys.includes(key));
    if (missingKeys.length > 0) {
      console.error(`❌ ${file} is missing keys from ${masterFile}:`, missingKeys);
      hasError = true;
    }

    // Check for extraneous keys
    const extraKeys = currentKeys.filter(key => !masterKeys.includes(key));
    if (extraKeys.length > 0) {
      console.warn(`⚠️ ${file} has extraneous keys not present in ${masterFile}:`, extraKeys);
    }
  }

  if (hasError) {
    console.error('i18n validation check failed.');
    process.exit(1);
  } else {
    console.log('✅ All locale translation keys validated successfully.');
    process.exit(0);
  }
}

checkLocales();
```

### 4.3 Tests

#### `packages/i18n/src/__tests__/i18n.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { Translator } from '../translator';

describe('i18n Key Translation Resolver', () => {
  it('should interpolate variables and support locale fallbacks', () => {
    const t = new Translator('en');
    t.registerLocale('en', {
      'welcome': 'Welcome, {name}!',
      'voice.join': 'Join Channel',
    });
    t.registerLocale('tr', {
      'welcome': 'Hoş geldin, {name}!',
    });

    // Exact match
    expect(t.translate('tr', 'welcome', { name: 'Alice' })).toBe('Hoş geldin, Alice!');
    
    // Fallback to default
    expect(t.translate('tr', 'voice.join')).toBe('Join Channel');

    // Missing key fallback to key name
    expect(t.translate('tr', 'unknown.key')).toBe('unknown.key');
  });
});
```

---

## 5. Package Scaffolding: `@lobbyforge/ui`

### 5.1 File Path Index
- `packages/ui/package.json`
- `packages/ui/tsconfig.json`
- `packages/ui/vitest.config.ts`
- `packages/ui/src/index.ts`
- `packages/ui/src/components/Button.tsx`
- `packages/ui/src/components/Dialog.tsx`
- `packages/ui/src/components/__tests__/Button.test.tsx`

### 5.2 File Contents

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
    "lint": "eslint src/**/*.{ts,tsx}"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@lobbyforge/config": "workspace:*",
    "@testing-library/react": "^16.0.0",
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
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

#### `packages/ui/src/components/Button.tsx`
```tsx
import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  style, 
  ...props 
}) => {
  const baseStyle: React.CSSProperties = {
    padding: '8px 16px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: variant === 'primary' ? '#3b82f6' : '#6b7280',
    color: '#ffffff',
    fontWeight: 'bold',
  };

  return (
    <button style={{ ...baseStyle, ...style }} {...props}>
      {children}
    </button>
  );
};
```

#### `packages/ui/src/components/Dialog.tsx`
```tsx
import * as React from 'react';

export interface DialogProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({ isOpen, title, onClose, children }) => {
  if (!isOpen) return null;

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div 
        style={{
          backgroundColor: '#ffffff',
          padding: '24px',
          borderRadius: '8px',
          width: '400px',
          maxWidth: '90%',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
          <h3 style={{ margin: 0, fontSize: '1.25rem' }}>{title}</h3>
          <button 
            onClick={onClose} 
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem' }}
          >
            &times;
          </button>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
};
```

#### `packages/ui/src/index.ts`
```typescript
export * from './components/Button';
export * from './components/Dialog';
```

### 5.3 Tests

#### `packages/ui/src/components/__tests__/Button.test.tsx`
```tsx
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '../Button';

describe('Shared UI Button Component', () => {
  it('should render correct children content', () => {
    render(<Button>Click Me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeDefined();
  });

  it('should fire click events', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click Me</Button>);
    
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
```

---

## 6. Recommended Execution & Verification Steps

After files are created by the implementer, they should run the following commands to confirm everything integrates cleanly:

1. **Workspace Dependency Synchronization**:
   ```bash
   pnpm install
   ```
2. **Build Verification**:
   ```bash
   pnpm build
   ```
3. **TypeScript Compilation (No Emit)**:
   ```bash
   pnpm typecheck
   ```
4. **Linting Check**:
   ```bash
   pnpm lint
   ```
5. **Vitest Unit & Integration Test Execution**:
   ```bash
   pnpm test
   ```
