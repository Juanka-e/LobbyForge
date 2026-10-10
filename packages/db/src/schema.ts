import { pgTable, uuid, text, timestamp, integer, smallint, boolean, jsonb, varchar, customType, index, bigint, unique, uniqueIndex, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Custom INET type wrapper
const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

// Raw bytes (postgres.js reads and writes them as Buffer).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
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
  // security-review FILE-001 (0041): bumped by every write of avatar_url /
  // banner_url and nothing else. The image route's cache token
  // (`userImageRefSql`) is built from these, so a profile edit (status,
  // bio — both bump updated_at) no longer forces every viewer to
  // re-download a multi-MB image.
  avatarVersion: integer('avatar_version').default(0).notNull(),
  bannerVersion: integer('banner_version').default(0).notNull(),
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
  // 0046 (docs/EMAIL.md §3.1): when the account proved it owns `email` —
  // a verification code or link, an email change, a password reset, a
  // Google sign-in that says the address is verified, or an admin.
  // Null = not verified. Cleared when the address changes without proof.
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // 0046: how the account was created — 'open' (sign-up without an invite;
  // every official hub sign-up), 'invite', 'oauth' or 'setup' (the first
  // owner). Email verification restricts an account only when its channel
  // is in the instance's verification scope (docs/EMAIL.md §4.2). Null =
  // created before 0046 (the enforced_since / deadline rules apply).
  signupChannel: text('signup_channel'),
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

// 0046 (docs/EMAIL.md §3.1, §4.1): one proof-of-address challenge — a
// link token and a 6-digit code sent together — for email verification,
// an email change or a password reset. Only hashes are stored:
// `token_hash` = sha256 of the 32 random link bytes, `code_hash` =
// HMAC-SHA256 of the code under a key derived from the session secret with
// the row id mixed in. At most one live (unconsumed) row per user and
// purpose (the partial unique index); a new send replaces it. Consuming is
// one conditional UPDATE (`consumed_at IS NULL AND expires_at > now()`).
export const emailTokens = pgTable('email_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  targetEmail: text('target_email').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  codeHash: bytea('code_hash').notNull(),
  codeAttempts: integer('code_attempts').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tokenHashUnique: uniqueIndex('email_tokens_token_hash_unique').on(table.tokenHash),
  // A partial unique INDEX (not a constraint): one live row per user and purpose.
  userPurposeActive: uniqueIndex('email_tokens_user_purpose_active_unique')
    .on(table.userId, table.purpose)
    .where(sql`consumed_at IS NULL`),
}));

// SERVERS TABLE
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug'),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  iconUrl: text('icon_url'),
  bannerUrl: text('banner_url'),
  defaultLocale: text('default_locale').default('en').notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// SERVER ACCESS POLICIES TABLE
export const serverAccessPolicies = pgTable('server_access_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  // 0043: 'public_self_register' — what a server WITHOUT a row has always
  // enforced (no server-level gate on top of the instance's registration
  // mode). The app always writes the column; see DEFAULT_SERVER_ACCESS_POLICY.
  joinPolicy: text('join_policy').default('public_self_register').notNull(),
  externalIdentity: text('external_identity').default('off').notNull(),
  localAccount: text('local_account').default('allow_local_email_password').notNull(),
  accountLinking: text('account_linking').default('allow_link').notNull(),
  requireApprovalForFirstJoin: boolean('require_approval_for_first_join').default(false).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueServerAccessPolicy: unique('server_access_policies_server_id_unique').on(table.serverId),
}));

// CHANNEL ROLE OVERRIDES (0028) — role-gated channel visibility.
// No rows for a channel => the channel is visible to every member
// (inherited). One or more rows => visible ONLY to holders of those
// roles (plus the owner and members with manage_channels/administrator,
// enforced at the route layer). This is the "private channel" primitive.
export const channelRoleOverrides = pgTable('channel_role_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  channelRoleUnique: unique('channel_role_overrides_channel_role_unique').on(table.channelId, table.roleId),
  channelIdx: index('idx_channel_role_overrides_channel').on(table.channelId),
  roleIdx: index('idx_channel_role_overrides_role').on(table.roleId),
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
  /** MODERATE_MEMBERS timeout: mute from text+voice until this instant. */
  timedOutUntil: timestamp('timed_out_until', { withTimezone: true }),
  /**
   * MUTE_MEMBERS server mute: the member may not publish a microphone in
   * any voice room of this server until a moderator lifts it. Persisted so
   * it survives rejoin; enforced via the LiveKit token grant + live
   * participant permission update.
   */
  voiceMuted: boolean('voice_muted').notNull().default(false),
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

// SERVER MEMBER SANCTIONS (0040) — security-review AUTHZ-002.
// The moderation state of a (server, user) pair, kept OUTSIDE the
// membership row: leaving deletes the membership and a rejoin used to
// create a clean one, so a timeout or a server mute was lifted by leaving
// and redeeming an invite. Every write of memberships.timed_out_until /
// voice_muted is mirrored here, and every path that (re)creates a
// membership copies this row into the new one. No FK to memberships on
// purpose — the row must outlive the membership.
export const serverMemberSanctions = pgTable('server_member_sanctions', {
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  timedOutUntil: timestamp('timed_out_until', { withTimezone: true }),
  voiceMuted: boolean('voice_muted').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'server_member_sanctions_server_id_user_id_pk', columns: [table.serverId, table.userId] }),
}));

// MESSAGES TABLE
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /**
   * 0037: the bot that posted this message (user_id is then NULL). Set
   * only by the server — the Bot API and the built-in bots — never from
   * a client payload. SET NULL on bot delete keeps the conversation; the
   * `metadata.bot` snapshot still names the bot.
   */
  botId: uuid('bot_id').references((): AnyPgColumn => bots.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  channelCreatedIdx: index('idx_messages_channel_created').on(table.channelId, table.createdAt),
  replyIdx: index('idx_messages_reply').on(table.replyToId).where(sql`reply_to_id IS NOT NULL`),
  botIdx: index('idx_messages_bot').on(table.botId).where(sql`bot_id IS NOT NULL`),
}));

// MESSAGE POLLS (0047, docs/CHAT_POLLS.md) — a poll posted in a text or
// announcement channel. It rides on a message row (the question is the
// message's `content`, `metadata.poll.id` points here); deleting that row
// deletes the poll. Closing is lazy: a poll is closed once `closes_at` has
// passed or `closed_at` is set (early close) — no scheduler writes it.
// The length and option-count CHECKs are SQL-only backstops (the route
// validates first): see 0047_chat_polls.sql.
export const messagePolls = pgTable('message_polls', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  creatorUserId: uuid('creator_user_id').references(() => users.id, { onDelete: 'set null' }),
  question: text('question').notNull(),
  /** The option texts, in order — a JSON array of 2–10 strings. A vote names an option by its index. */
  options: jsonb('options').$type<string[]>().notNull(),
  allowMultiple: boolean('allow_multiple').default(false).notNull(),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedByUserId: uuid('closed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  messageUnique: uniqueIndex('message_polls_message_id_unique').on(table.messageId),
}));

// MESSAGE POLL VOTES (0047). One row per (poll, voter, chosen option). The
// voter is stored so a vote can be changed or removed and "your vote" shows
// on every device — but no API ever returns who chose what: reads go
// through counts and the caller's own rows only (docs/CHAT_POLLS.md §5).
export const messagePollVotes = pgTable('message_poll_votes', {
  pollId: uuid('poll_id').notNull().references(() => messagePolls.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  optionIndex: smallint('option_index').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'message_poll_votes_poll_id_user_id_option_index_pk', columns: [table.pollId, table.userId, table.optionIndex] }),
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
  // Optimistic concurrency control — incremented on every state update.
  // The action route uses CAS: UPDATE ... WHERE revision = $expected.
  revision: integer('revision').default(0).notNull(),
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

// BOTS TABLE — a bot identity that belongs to ONE server.
//   type 'custom'      → driven from outside through the Bot API with a token
//   type 'welcome'     → built-in, runs inside the app (greets new members)
//   type 'moderation'  → built-in, runs inside the app (filters messages)
// Note: the partial unique index `bots_server_builtin_type_unique`
// (one welcome + one moderation bot per server) lives in the migration
// SQL only (0037) — the table builder cannot express a partial unique
// index, same as `game_sessions_channel_open_unique`.
export const bots = pgTable('bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  /**
   * `sha256$<hex>` of the whole token — the token itself is shown once
   * and never stored. NULL = no token (built-in bot, or revoked).
   */
  tokenHash: text('token_hash'),
  /** When the current token was issued; NULL while there is none. */
  tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true }),
  /** JSON array of bot permission ids (`@lobbyforge/bot-sdk` BotPermission). */
  permissions: jsonb('permissions').default([]).notNull(),
  /** Per-type configuration (welcome channel + template, moderation rules). */
  settings: jsonb('settings').default({}).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  /** Who installed the bot ("installed by" on the bot profile). */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  /** Last authenticated API call or built-in action (throttled writes). */
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  /**
   * Bot API v2 §1.1 (0044): which channels the bot reaches. `all` = every
   * text / announcement channel of its server without a role gate (the v1
   * rule); `selected` = exactly its `bot_channel_access` rows — and NONE
   * when there are no rows (a deleted last channel never widens a bot).
   * CHECK `IN ('all', 'selected')` is SQL-only.
   */
  channelAccessMode: text('channel_access_mode').default('all').notNull(),
}, (table) => ({
  serverIdx: index('idx_bots_server').on(table.serverId),
}));

// ── Bot API v2 (0044, docs/BOT_API_V2.md §2) ────────────────────────────
// Every table cascades with its bot / server / channel. The CHECK
// constraints (name patterns, lengths, status values, JSON shapes) live
// in the migration SQL only, like roles_icon_allowlist_check — the table
// builder here does not carry them.

// The channels a bot in `selected` mode (`bots.channel_access_mode`) may
// use — exactly these, and none when there are no rows. Ignored in `all`
// mode (switching to `all` deletes them). Granting a role-gated channel is
// policed by the route.
export const botChannelAccess = pgTable('bot_channel_access', {
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'bot_channel_access_bot_id_channel_id_pk', columns: [table.botId, table.channelId] }),
  channelIdx: index('idx_bot_channel_access_channel').on(table.channelId),
}));

// Slash commands a bot registered. Names are unique per SERVER (a member
// types `/name`, so two bots cannot both own it). `options` / `channel_ids`
// come from the bot; `enabled` and `admin_channel_ids` belong to the
// server's managers: the row carries the effective values, and
// `bot_command_overrides` keeps them per (bot, name) so they survive the bot
// deleting and re-registering the command.
export const botCommands = pgTable('bot_commands', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  options: jsonb('options').default([]).notNull(),
  /** null = every channel the bot can access; else a subset (set by the bot). */
  channelIds: jsonb('channel_ids'),
  /** A manager's channel restriction (null = none), intersected with `channel_ids`. */
  adminChannelIds: jsonb('admin_channel_ids'),
  /** A CorePermission id the INVOKER must hold. */
  requiredPermission: text('required_permission'),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  serverNameUnique: unique('bot_commands_server_id_name_unique').on(table.serverId, table.name),
  botIdx: index('idx_bot_commands_bot').on(table.botId),
}));

// The managers' switches on a bot's command, keyed by (bot, command name)
// — NOT by the command row, which the bot can delete and re-create at will.
// Written by the admin PATCH (together with the row); read when the bot
// (re-)registers a name, so `DELETE /commands/{name}` + `PUT /commands`
// cannot reset a manager's "off" or channel restriction. Gone with the bot.
export const botCommandOverrides = pgTable('bot_command_overrides', {
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  /** The managers' channel restriction (null = none). */
  adminChannelIds: jsonb('admin_channel_ids'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'bot_command_overrides_bot_id_name_pk', columns: [table.botId, table.name] }),
}));

// One run of a slash command. The id is the capability the bot answers
// with (uuid, and bound to the bot). Answerable for 15 minutes.
//   status: 'pending' | 'answered' | 'expired' | 'failed'
export const botInteractions = pgTable('bot_interactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
  commandId: uuid('command_id').references(() => botCommands.id, { onDelete: 'set null' }),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  commandName: text('command_name').notNull(),
  options: jsonb('options').default({}).notNull(),
  status: text('status').default('pending').notNull(),
  /** `{ content, ephemeral, messageId? }` of the first answer. */
  response: jsonb('response'),
  /** Follow-up messages sent so far (at most 5). */
  followupCount: integer('followup_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  botStatusIdx: index('idx_bot_interactions_bot_status').on(table.botId, table.status, table.expiresAt),
  userIdx: index('idx_bot_interactions_user').on(table.userId, table.createdAt),
  // The channel / command FKs (cascade / set null) look rows up by these.
  channelIdx: index('idx_bot_interactions_channel').on(table.channelId),
  commandIdx: index('idx_bot_interactions_command').on(table.commandId).where(sql`command_id IS NOT NULL`),
}));

// Incoming webhooks: an external service posts into ONE channel with a
// secret URL. Only the token's hash is kept (`sha256$<hex>`).
export const channelWebhooks = pgTable('channel_webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => ({
  channelIdx: index('idx_channel_webhooks_channel').on(table.channelId),
  serverIdx: index('idx_channel_webhooks_server').on(table.serverId),
}));

// A bot's outgoing event endpoint (HTTPS). `secret` is the HMAC key the
// instance signs deliveries with — stored because the server must sign,
// returned only once. Disabled after 20 consecutive failed deliveries.
export const botEventEndpoints = pgTable('bot_event_endpoints', {
  botId: uuid('bot_id').primaryKey().references(() => bots.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: jsonb('events').default([]).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  failureCount: integer('failure_count').default(0).notNull(),
  disabledReason: text('disabled_reason'),
  lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  lastStatus: integer('last_status'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  /** Instance logo (image data URL; validated by the upload route). */
  instanceLogoUrl: text('instance_logo_url'),
  domain: text('domain'),
  publicKey: text('public_key'),
  privateKeyEncrypted: text('private_key_encrypted'),
  region: text('region'),
  languages: jsonb('languages').default([]).notNull(),
  tags: jsonb('tags').default([]).notNull(),
  isPublicDirectoryEnabled: boolean('is_public_directory_enabled').default(false).notNull(),
  // 18th-audit: persisted directory verification proof — the
  // .well-known endpoint serves this; lfctl directory proof generates
  // it, the admin configure endpoint stores it.
  directoryProof: text('directory_proof'),
  // security-review HUB-001 (0039): this install's identity in the
  // official directory — random per install. `instanceId` above is the
  // settings singleton key ('self-host' everywhere) and must never be
  // published as a directory id.
  directoryInstanceId: text('directory_instance_id').default(sql`gen_random_uuid()::text`).notNull(),
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
  // 0045 bot protection (docs/CAPTCHA.md §3.1). The secret is stored only
  // encrypted (`v1.<iv>.<ciphertext>.<tag>`, AES-256-GCM, key derived from
  // the session secret) — the CHECK in the migration is the backstop.
  // Environment overrides (LOBBYFORGE_CAPTCHA_*) win over these columns.
  captchaProvider: text('captcha_provider').default('altcha').notNull(),
  captchaSurfaces: jsonb('captcha_surfaces')
    .default({ register: 'on', invite_register: 'off', guest: 'on', login: 'adaptive' })
    .notNull(),
  captchaSiteKey: text('captcha_site_key'),
  captchaSecretEncrypted: text('captcha_secret_encrypted'),
  captchaOptions: jsonb('captcha_options').default({}).notNull(),
  captchaAttackMode: boolean('captcha_attack_mode').default(false).notNull(),
  // 0046 email (docs/EMAIL.md §3.1). The SMTP password is stored only
  // encrypted (`v1.<iv>.<ciphertext>.<tag>`, AES-256-GCM, key derived from
  // the session secret) — the CHECK in the migration is the backstop.
  // Environment overrides (LOBBYFORGE_MAIL_* / LOBBYFORGE_SMTP_* /
  // LOBBYFORGE_EMAIL_VERIFICATION) win over these columns.
  mailProvider: text('mail_provider').default('none').notNull(),
  mailRegion: text('mail_region'),
  smtpHost: text('smtp_host'),
  smtpPort: integer('smtp_port'),
  smtpSecurity: text('smtp_security'),
  smtpUsername: text('smtp_username'),
  smtpPasswordEncrypted: text('smtp_password_encrypted'),
  mailFrom: text('mail_from'),
  mailDailyLimit: integer('mail_daily_limit'),
  mailLastTestAt: timestamp('mail_last_test_at', { withTimezone: true }),
  mailLastTestResult: text('mail_last_test_result'),
  // HMAC of the connection the last test ran against (host, port, user,
  // password, from…): `required` unlocks only for exactly that configuration.
  mailLastTestFingerprint: text('mail_last_test_fingerprint'),
  emailVerificationMode: text('email_verification_mode').default('off').notNull(),
  emailVerificationScope: jsonb('email_verification_scope')
    .default({ open_register: true, invite_register: false })
    .notNull(),
  emailVerificationEnforcedSince: timestamp('email_verification_enforced_since', { withTimezone: true }),
  emailVerificationExistingDeadline: timestamp('email_verification_existing_deadline', { withTimezone: true }),
  disposableEmailBlock: boolean('disposable_email_block').default(false).notNull(),
  disposableEmailOverrides: jsonb('disposable_email_overrides').default({ allow: [], block: [] }).notNull(),
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
  // SEC-007: the first registrant owns the directory entry; upserts from
  // any other user are rejected (discovery-phishing guard). NULL = legacy
  // row predating ownership — claimed by the first updater, then locked.
  ownerUserId: uuid('owner_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
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

// SERVER JOIN REQUESTS (0043) — the approval queue behind an access policy
// that holds newcomers for a moderator (`accessPolicyRequiresApproval`).
// An invite redeem or the /lobby auto-join files a request instead of a
// membership; a moderator approves (the membership is created then) or
// rejects it; the requester can cancel. Rows are kept after a decision as
// the record of who decided what.
//   source: 'invite' | 'auto_join'
//   status: 'pending' | 'approved' | 'rejected' | 'cancelled'
// Note: the partial unique index `server_join_requests_one_pending_unique`
// (at most ONE pending request per (server, user)) lives in the migration
// SQL only (0043) — the table builder cannot express a partial unique
// index, same as `game_sessions_channel_open_unique`.
export const serverJoinRequests = pgTable('server_join_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  /** The invite code the request came through (text, not an FK: the invite may be revoked later). */
  inviteCode: varchar('invite_code', { length: 16 }),
  /** Optional message to the moderators, at most 500 characters. */
  note: text('note'),
  status: text('status').default('pending').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  /**
   * A rejection written BY a ban (banUser, or an approval that found the
   * user banned) — the rejection cooldown ignores it, so lifting the ban
   * lets the user ask again at once.
   */
  rejectedByBan: boolean('rejected_by_ban').default(false).notNull(),
}, (table) => ({
  serverStatusIdx: index('idx_server_join_requests_server_status').on(table.serverId, table.status, table.createdAt),
  serverUserIdx: index('idx_server_join_requests_server_user').on(table.serverId, table.userId),
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
  /**
   * NEW-007: language scope for the card. NULL means "shared across all
   * languages" (a server's proper-noun additions fit every deck); a
   * value like 'tr' restricts the card to packs of that language — a
   * Turkish local word must never leak into a German deck.
   */
  language: text('language'),
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
  serverPluginLanguageIdx: index('idx_server_local_cards_server_plugin_language').on(
    table.serverId,
    table.pluginId,
    table.language
  ),
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
  // 13th-audit: the reviewed artifact's exact digest — review computes
  // it, install verifies it constant-time. NULL = legacy/unpinned rows
  // (installs refuse until re-reviewed under the pinned model when the
  // strict gate is on).
  bundleSha256: text('bundle_sha256'),
  bundleSizeBytes: integer('bundle_size_bytes'),
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

// ── Instance Reports (discovery directory complaints) ──────────────────
export const instanceReports = pgTable('instance_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: text('instance_id').notNull(),
  reporterUserId: uuid('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(), // spam, nsfw, abuse, malware, other
  detail: text('detail'),
  status: text('status').default('pending').notNull(), // pending | reviewed | dismissed | actioned
  reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  instanceIdx: index('idx_instance_reports_instance').on(table.instanceId),
  statusIdx: index('idx_instance_reports_status').on(table.status),
}));

// ── Plugin Data (generic host-owned key-value store for marketplace plugins) ─
// Plugins access this via the SDK's storage sub-context — they never get raw
// SQL or DbClient access. The host reads/writes on their behalf.
export const pluginData = pgTable('plugin_data', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  pluginId: text('plugin_id').notNull(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // One value per key per plugin per server.
  uniquePluginKey: unique('plugin_data_server_plugin_key_unique').on(
    table.serverId, table.pluginId, table.key
  ),
  pluginIdx: index('idx_plugin_data_plugin').on(table.pluginId, table.serverId),
}));
