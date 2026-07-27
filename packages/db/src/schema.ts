import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, varchar, customType, index, bigint, unique, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
  bannerUrl: text('banner_url'),
  locale: text('locale').default('en').notNull(),
  isGuest: boolean('is_guest').default(false).notNull(),
  // Stable per-guest identifier (e.g. "g_<32hex>"). Unique so a returning
  // guest can be looked up idempotently when a server API mints a real
  // user row from the lf_guest cookie.
  guestKey: text('guest_key').unique(),
  statusText: varchar('status_text', { length: 128 }),
  bio: varchar('bio', { length: 190 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  deletedIdx: index('idx_users_deleted').on(table.deletedAt).where(sql`deleted_at IS NOT NULL`),
  guestKeyIdx: index('idx_users_guest_key').on(table.guestKey).where(sql`guest_key IS NOT NULL`),
}));

// External identities are references to an upstream account, never upstream
// access/refresh tokens. Local roles, bans, messages, and ownership continue
// to reference users.id inside this instance.
export const userIdentityLinks = pgTable('user_identity_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 64 }).notNull(),
  providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
  providerEmail: varchar('provider_email', { length: 254 }),
  emailVerified: boolean('email_verified').default(false).notNull(),
  claims: jsonb('claims').default({}).notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueProviderSubject: unique('user_identity_links_provider_subject_unique').on(
    table.provider,
    table.providerSubject
  ),
  uniqueUserProvider: unique('user_identity_links_user_provider_unique').on(
    table.userId,
    table.provider
  ),
  userIdx: index('idx_user_identity_links_user').on(table.userId),
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

// SERVER ACCESS POLICIES TABLE
export const serverAccessPolicies = pgTable('server_access_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  joinPolicy: text('join_policy').default('invite_only').notNull(),
  externalIdentity: text('external_identity').default('off').notNull(),
  localAccount: text('local_account').default('allow_local_email_password').notNull(),
  accountLinking: text('account_linking').default('allow_link').notNull(),
  requireApprovalForFirstJoin: boolean('require_approval_for_first_join').default(false).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueServerAccessPolicy: unique('server_access_policies_server_id_unique').on(table.serverId),
}));

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

// SERVER VOICE SETTINGS TABLE
export const serverVoiceSettings = pgTable('server_voice_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  defaultUserLimit: integer('default_user_limit'),
  requirePushToTalk: boolean('require_push_to_talk').default(false).notNull(),
  startMuted: boolean('start_muted').default(false).notNull(),
  allowCamera: boolean('allow_camera').default(true).notNull(),
  allowScreenShare: boolean('allow_screen_share').default(true).notNull(),
  maxCameraUsersPerRoom: integer('max_camera_users_per_room'),
  maxScreenShareUsersPerRoom: integer('max_screen_share_users_per_room'),
  maxScreenShareHeight: integer('max_screen_share_height').default(1080).notNull(),
  maxScreenShareFps: integer('max_screen_share_fps').default(30).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueServerVoiceSettings: unique('server_voice_settings_server_id_unique').on(table.serverId),
}));

// ROLES TABLE
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  icon: varchar('icon', { length: 32 }),
  displaySeparately: boolean('display_separately').default(false).notNull(),
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
  uniqueServerUser: unique('memberships_server_id_user_id_unique').on(table.serverId, table.userId),
  serverUserIdx: index('idx_memberships_server_user').on(table.serverId, table.userId),
}));

// MEMBERSHIP ROLES TABLE (M15.5 — many-to-many between memberships and roles)
export const membershipRoles = pgTable('membership_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueMembershipRole: unique('membership_roles_membership_id_role_id_unique').on(
    table.membershipId,
    table.roleId
  ),
  membershipIdx: index('idx_membership_roles_membership').on(table.membershipId),
  roleIdx: index('idx_membership_roles_role').on(table.roleId),
}));

// MESSAGES TABLE
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  channelCreatedIdx: index('idx_messages_channel_created').on(table.channelId, table.createdAt),
  replyIdx: index('idx_messages_reply').on(table.replyToId).where(sql`reply_to_id IS NOT NULL`),
}));

// PLUGINS ENABLED TABLE
export const pluginsEnabled = pgTable('plugins_enabled', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  settings: jsonb('settings').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueServerPlugin: unique('plugins_enabled_server_id_plugin_id_unique').on(table.serverId, table.pluginId),
}));

// GAME SESSIONS TABLE
export const gameSessions = pgTable('game_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  status: text('status').notNull(), // lobby, running, paused, ended, cancelled
  state: jsonb('state').default({}).notNull(),
  publicSummary: jsonb('public_summary').default({}).notNull(),
  // M20a — `team_size` and `difficulty_distribution` are plugin-defined
  // knobs the session started with. Nullable so non-team plugins
  // (single-player, free-for-all) don't have to set them. The reducer
  // reads these from `row.state.config` (which is populated from the
  // columns on session creation) so the in-state shape stays JSONB-
  // opaque to other plugins.
  teamSize: integer('team_size'),
  difficultyDistribution: jsonb('difficulty_distribution'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (table) => ({
  serverChannelIdx: index('idx_game_sessions_server_channel').on(table.serverId, table.channelId),
  // Note: the partial unique index `game_sessions_channel_open_unique`
  // (per-channel mutex: at most one open row in {lobby,running,paused})
  // is created in the migration SQL only. Drizzle's table-builder API
  // in this version doesn't support `.where()` on unique constraints;
  // we declare the constraint as raw SQL in
  // `0006_hushle_difficulty_and_team_size.sql`. Defence-in-depth for
  // the application-layer mutex in the activity start route.
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
  sessionCreatedIdx: index('idx_plugin_events_session_created').on(table.sessionId, table.createdAt),
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

// Version ledger for trusted, host-executed component data migrations.
// Community packages never receive raw SQL access through this table.
export const componentMigrations = pgTable('component_migrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  componentType: text('component_type').notNull(),
  componentId: text('component_id').notNull(),
  version: integer('version').notNull(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueComponentVersion: unique('component_migrations_type_id_version_unique').on(
    table.componentType,
    table.componentId,
    table.version
  ),
  componentIdx: index('idx_component_migrations_component').on(
    table.componentType,
    table.componentId
  ),
}));

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
  registrationMode: text('registration_mode').default('invite_only').notNull(),
  guestAccessEnabled: boolean('guest_access_enabled').default(true).notNull(),
  seoIndexingEnabled: boolean('seo_indexing_enabled').default(false).notNull(),
  seoTitle: varchar('seo_title', { length: 70 }),
  seoDescription: varchar('seo_description', { length: 160 }),
  // M21 — /setup wizard lock + ownership pointer. `setupCompletedAt`
  // is the lock flag (null = setup mode, set = locked); `ownerUserId`
  // is the first admin created during /setup. Nullable so existing
  // rows from prior migrations don't need a backfill.
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
  // Version 2 is the irreversible bootstrap lock. Missing operational
  // records must be repaired from authenticated admin tooling, not /setup.
  bootstrapVersion: integer('bootstrap_version').default(1).notNull(),
  ownerUserId: uuid('owner_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  maintenanceMode: boolean('maintenance_mode').default(false).notNull(),
  maintenanceMessage: varchar('maintenance_message', { length: 280 }),
  maintenanceStartedAt: timestamp('maintenance_started_at', { withTimezone: true }),
  maintenanceUpdatedAt: timestamp('maintenance_updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  listedHeartbeatIdx: index('idx_registry_instances_listed').on(table.isListed, table.isBlocked, table.lastHeartbeatAt),
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
  serverCreatedIdx: index('idx_audit_logs_server_created').on(table.serverId, table.createdAt),
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

// SYSTEM UPDATE RUNS TABLE
export const systemUpdateRuns = pgTable('system_update_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  action: text('action').notNull(), // dry-run, apply, rollback
  status: text('status').notNull(), // planned, locked, running, succeeded, failed, rolled_back
  fromVersion: text('from_version').notNull(),
  toVersion: text('to_version').notNull(),
  channel: text('channel').notNull(),
  manifestKeyId: text('manifest_key_id'),
  backupId: text('backup_id'),
  plan: jsonb('plan').default({}).notNull(),
  gates: jsonb('gates').default({}).notNull(),
  failures: jsonb('failures').default([]).notNull(),
  startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => ({
  statusStartedIdx: index('idx_system_update_runs_status_started').on(table.status, table.startedAt),
  startedIdx: index('idx_system_update_runs_started').on(table.startedAt),
}));

// SYSTEM UPDATE EVENTS TABLE
export const systemUpdateEvents = pgTable('system_update_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => systemUpdateRuns.id, { onDelete: 'cascade' }),
  stepId: text('step_id'),
  level: text('level').default('info').notNull(), // debug, info, warn, error
  message: text('message').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runCreatedIdx: index('idx_system_update_events_run_created').on(table.runId, table.createdAt),
  runStepIdx: index('idx_system_update_events_run_step').on(table.runId, table.stepId),
}));

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
  uniqueServerUser: unique('server_bans_server_id_user_id_unique').on(table.serverId, table.userId),
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
  uniqueMessageUserEmoji: unique('reactions_message_id_user_id_emoji_unique').on(table.messageId, table.userId, table.emoji),
  messageIdx: index('idx_reactions_message').on(table.messageId),
}));

// ATTACHMENTS TABLE
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  messageIdx: index('idx_attachments_message').on(table.messageId),
}));

// CARD PACKS TABLE — plugin-managed content packs (e.g. Hushle word decks).
// A card_packs row is a single named pack; the actual cards live in
// `cards` keyed by `packId`. The `slug` is the stable, plugin-scoped
// identifier (e.g. `hushle-en-basic`); `pluginId` is the plugin that
// owns the pack schema. Instance-wide content — not per-server.
export const cardPacks = pgTable('card_packs', {
  id: uuid('id').primaryKey().defaultRandom(),
  pluginId: text('plugin_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  language: text('language').notNull(),
  description: text('description'),
  isBuiltIn: boolean('is_built_in').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniquePluginSlug: unique('card_packs_plugin_id_slug_unique').on(table.pluginId, table.slug),
  pluginLanguageIdx: index('idx_card_packs_plugin_language').on(table.pluginId, table.language),
}));

// CARDS TABLE — individual cards inside a card pack. The shape of
// `payload` is plugin-defined (e.g. { word, forbiddenWords } for Hushle);
// the host only treats it as opaque JSONB. The `difficulty` column is
// a plugin-defined tier label — the host only stores + filters on it;
// the visual treatment (color, icon) is plugin-owned. M20a introduces
// this column for Hushle's easy/medium/hard tiers; other plugins can
// ignore it (default value = 'easy') or use their own vocabulary.
export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  packId: uuid('pack_id').notNull().references(() => cardPacks.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  payload: jsonb('payload').default({}).notNull(),
  difficulty: text('difficulty').default('easy').notNull(),
  category: text('category').default('general').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  packOrdinalIdx: index('idx_cards_pack_ordinal').on(table.packId, table.ordinal),
  packDifficultyIdx: index('idx_cards_pack_difficulty').on(table.packId, table.difficulty),
  packCategoryIdx: index('idx_cards_pack_category').on(table.packId, table.category),
  uniquePackOrdinal: unique('cards_pack_id_ordinal_unique').on(table.packId, table.ordinal),
}));

// SERVER LOCAL CARDS TABLE — custom card additions scoped to a single
// server. Plugin owners / server owners create these to add domain-
// specific words that don't belong in a global pack. The reducer's
// deck loader unions the global pack cards with the server-local cards
// (filtered by pluginId). M20a ships the table + CRUD; the deck loader
// lands in M20b alongside the admin UI.
export const serverLocalCards = pgTable('server_local_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  // Free-form tag so a server can group local cards (e.g. by theme).
  // The deck loader treats this as opaque; Hushle uses it for category
  // tags. Nullable so a quick add doesn't require picking a tag.
  category: text('category'),
  payload: jsonb('payload').default({}).notNull(),
  difficulty: text('difficulty').default('easy').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  serverPluginIdx: index('idx_server_local_cards_server_plugin').on(table.serverId, table.pluginId),
  serverPluginDifficultyIdx: index('idx_server_local_cards_server_plugin_difficulty').on(
    table.serverId,
    table.pluginId,
    table.difficulty
  ),
}));

// USER BLOCKS TABLE — per-user block list. When user A blocks user B,
// A sees B's messages rendered as "Blocked user" in the chat (the
// message row stays so the conversation makes sense; the content +
// author are masked). Blocks are directional: A blocking B does NOT
// block A for B. Both columns cascade-delete with the user so blocks
// vanish when an account is purged.
export const userBlocks = pgTable('user_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The user who performed the block.
  blockerUserId: uuid('blocker_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // The user who was blocked.
  blockedUserId: uuid('blocked_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // A user can only block another user once.
  uniqueBlockerBlocked: unique('user_blocks_blocker_blocked_unique').on(
    table.blockerUserId,
    table.blockedUserId
  ),
  blockerIdx: index('idx_user_blocks_blocker').on(table.blockerUserId),
}));

// ── Direct Messages (instance-local, server-independent) ────────────────
// A DM channel is a 1:1 conversation between two users on the same instance.
// It does NOT belong to any server — it lives at the instance level so a user
// can DM anyone they share the instance with, regardless of server membership.

export const dmChannels = pgTable('dm_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  userAId: uuid('user_a_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  userBId: uuid('user_b_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Who created the channel (for audit / first-message attribution).
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Last message timestamp — drives the sidebar ordering without a join.
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // A DM channel between two users is unique regardless of order.
  // Enforced via a CHECK that userAId < userBId + a unique index.
  uniquePair: uniqueIndex('dm_channels_pair_unique')
    .on(table.userAId, table.userBId),
  userAIdx: index('idx_dm_channels_user_a').on(table.userAId),
  userBIdx: index('idx_dm_channels_user_b').on(table.userBId),
}));

export const dmMessages = pgTable('dm_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  dmChannelId: uuid('dm_channel_id').notNull().references(() => dmChannels.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  // Optional reply reference within the same DM channel.
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => dmMessages.id, { onDelete: 'set null' }),
  // Soft-delete: the author can delete their own message.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  channelCreatedIdx: index('idx_dm_messages_channel_created').on(table.dmChannelId, table.createdAt),
  replyIdx: index('idx_dm_messages_reply').on(table.replyToId).where(sql`reply_to_id IS NOT NULL`),
}));

// ── Plugin Catalog (marketplace) ────────────────────────────────────────
// Community-submitted plugins awaiting review or approved for the
// marketplace. Mirrors PluginCatalogMetadata from the SDK + adds review
// workflow fields. Approved entries are surfaced via listPluginSummaries().

export const pluginCatalog = pgTable('plugin_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  pluginId: text('plugin_id').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  type: text('type').notNull(), // game | activity | utility
  summary: text('summary'),
  description: text('description'),
  publisher: text('publisher').notNull(),
  publisherUserId: uuid('publisher_user_id').references(() => users.id, { onDelete: 'set null' }),
  trustLevel: text('trust_level').default('unverified').notNull(), // official | verified-community | unverified
  category: text('category'), // game | bot | integration | utility
  tags: jsonb('tags').default([]).notNull(),
  permissions: jsonb('permissions').default([]).notNull(),
  playerConfig: jsonb('player_config'),
  manifestUrl: text('manifest_url'),
  iconUrl: text('icon_url'),
  reviewStatus: text('review_status').default('pending').notNull(), // pending | approved | rejected | delisted
  reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  requiresVoiceRoom: boolean('requires_voice_room').default(false).notNull(),
  downloadCount: integer('download_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniquePluginId: unique('plugin_catalog_plugin_id_unique').on(table.pluginId),
  statusIdx: index('idx_plugin_catalog_status').on(table.reviewStatus, table.trustLevel),
  categoryIdx: index('idx_plugin_catalog_category').on(table.category),
}));
