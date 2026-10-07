/**
 * Client-safe bot vocabulary: permission ids, types, trust, limits.
 * No imports on purpose — the admin page and the lobby render these in
 * the browser. Server-only policy (who may grant what) lives in
 * `./permissions.ts`.
 *
 * `BOT_PERMISSIONS` is the web app's copy of `@lobbyforge/bot-sdk`'s
 * `BotPermission` (apps/web does not depend on the SDK package). A test
 * reads the SDK source and fails if the two lists ever drift.
 */

export const BOT_PERMISSIONS = [
  'read_messages',
  'send_messages',
  'join_voice',
  'publish_audio',
  'read_presence',
  'moderate_messages',
  'manage_game_session',
  'manage_music_queue',
  'read_audit_log',
  // Bot API v2 (docs/BOT_API_V2.md §1.2).
  'slash_commands',
  'read_members',
  'receive_events',
] as const;

export type BotPermissionId = (typeof BOT_PERMISSIONS)[number];

export function isBotPermission(value: unknown): value is BotPermissionId {
  return typeof value === 'string' && (BOT_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions the Bot API honours today (v1 messages + v2 commands, member
 * events and the event stream); the rest are kept for what comes next and
 * the settings page marks them "coming soon".
 */
export const BOT_API_PERMISSIONS: readonly BotPermissionId[] = [
  'read_messages',
  'send_messages',
  'slash_commands',
  'read_members',
  'receive_events',
];

/**
 * A permission kept for what comes next and not honoured yet. The settings
 * page shows it as "coming soon" and does not let anyone pick it (a bot
 * that already has one can still have it removed).
 */
export function isReservedBotPermission(permission: BotPermissionId): boolean {
  return !BOT_API_PERMISSIONS.includes(permission);
}

// ── Bot API v2 vocabulary (client-safe: the composer and admin UI use it) ──

/** Slash command and option names: lowercase letters, digits, `_` and `-`. */
export const COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const COMMAND_DESCRIPTION_MAX_LENGTH = 100;
export const MAX_COMMANDS_PER_BOT = 50;
export const MAX_COMMAND_OPTIONS = 25;
export const MAX_OPTION_CHOICES = 25;
export const COMMAND_STRING_OPTION_MAX_LENGTH = 1000;
/** An interaction can be answered (and followed up) for this long after it was created. */
export const INTERACTION_TTL_MS = 15 * 60_000;
export const MAX_INTERACTION_FOLLOWUPS = 5;

/**
 * Events a bot can receive (docs/BOT_API_V2.md §4.2). `ready` exists only on
 * the stream; an outgoing endpoint can subscribe to everything else.
 */
export const BOT_EVENT_NAMES = [
  'message_create',
  'message_update',
  'message_delete',
  'member_join',
  'member_leave',
  'interaction_create',
  'channel_access_changed',
] as const;
export type BotEventName = (typeof BOT_EVENT_NAMES)[number];

export const MAX_WEBHOOKS_PER_CHANNEL = 10;
export const WEBHOOK_NAME_MAX_LENGTH = 32;

export const CUSTOM_BOT_TYPE = 'custom';
export const BUILT_IN_TYPES = ['welcome', 'moderation'] as const;
export type BuiltInType = (typeof BUILT_IN_TYPES)[number];

export function isBuiltInType(type: string): type is BuiltInType {
  return (BUILT_IN_TYPES as readonly string[]).includes(type);
}

/** Built-in bots have a fixed permission set — an admin cannot widen it. */
export const BUILT_IN_BOT_PERMISSIONS: Record<BuiltInType, readonly BotPermissionId[]> = {
  welcome: ['send_messages'],
  moderation: ['read_messages', 'moderate_messages', 'send_messages'],
};

export const MAX_CUSTOM_BOTS_PER_SERVER = 20;
export const BOT_NAME_MAX_LENGTH = 32;
export const MAX_BOT_MESSAGE_LENGTH = 4000;

/**
 * The message key that explains to a member why the Moderation Bot
 * blocked their message (the API answers `code: 'blocked_by_moderation'`
 * plus the `rule`; the text is translated where it is shown).
 */
export function moderationBlockedMessageKey(rule: unknown): string {
  switch (rule) {
    case 'blocked_word':
      return 'bots.moderation.blocked.blocked_word';
    case 'link':
      return 'bots.moderation.blocked.link';
    case 'mentions':
      return 'bots.moderation.blocked.mentions';
    case 'repeat':
      return 'bots.moderation.blocked.repeat';
    case 'flood':
      return 'bots.moderation.blocked.flood';
    default:
      return 'bots.moderation.blocked.generic';
  }
}

export type BotTrustLevel = 'official' | 'verified' | 'unverified';

/**
 * Built-in bots ship with LobbyForge → official. A custom bot is code an
 * admin connected from outside → unverified. (Legacy `internal*` /
 * `plugin*` rows keep reading as official, as before.)
 */
export function botTrustLevel(type: string): BotTrustLevel {
  if (isBuiltInType(type)) return 'official';
  if (type.startsWith('internal') || type.startsWith('plugin')) return 'official';
  return 'unverified';
}
