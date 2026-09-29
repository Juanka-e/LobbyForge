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
] as const;

export type BotPermissionId = (typeof BOT_PERMISSIONS)[number];

export function isBotPermission(value: unknown): value is BotPermissionId {
  return typeof value === 'string' && (BOT_PERMISSIONS as readonly string[]).includes(value);
}

/** Permissions the Bot API v1 honours today; the rest are kept for what comes next. */
export const BOT_API_PERMISSIONS: readonly BotPermissionId[] = ['read_messages', 'send_messages'];

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
