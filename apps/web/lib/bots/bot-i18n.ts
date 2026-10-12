/**
 * Built-in bot texts in each viewer's language — client-safe (no runtime
 * imports beyond `message-meta`).
 *
 * A built-in bot (Welcome, Moderation) posts ONE message that everyone
 * reads. When it posts its DEFAULT text (the admin wrote none), the server
 * stores next to the plain `content` — which stays in the instance
 * language, for bots, search and older clients — a reference to the
 * catalogue string it came from:
 *
 *     metadata.i18n = { key: 'bots.welcome.defaultTemplate',
 *                       params: { user: 'Ayşe', server: 'Oyun Gecesi' } }
 *
 * and each viewer's lobby shows `t(key, params)` in their own language. A
 * text an admin wrote carries no `i18n` and is shown exactly as written.
 *
 * `i18n` is a reserved metadata key (the messages API refuses it from
 * clients), and this reader honours it only on a BOT's message and only
 * for the keys listed here — nothing can make the lobby show an arbitrary
 * catalogue string as a bot's words. A key it does not know (or a
 * catalogue without it) falls back to `content`.
 *
 * Default NAMES are not stored at all: a built-in bot whose name is still
 * a shipped default — in any installed language — is sent to browsers with
 * `defaultName: true` (lib/bots/bot-i18n-server.ts), and the browser shows
 * that default in the viewer's language. A renamed bot keeps its name.
 */
import { readMessageBot } from './message-meta';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The catalogue keys a built-in bot's message may name in `metadata.i18n`. */
export const BOT_MESSAGE_I18N_KEYS = ['bots.welcome.defaultTemplate', 'bots.moderation.defaultNotice'] as const;
export type BotMessageI18nKey = (typeof BOT_MESSAGE_I18N_KEYS)[number];

export interface BotMessageI18n {
  key: BotMessageI18nKey;
  /** Already cleaned by the server (no `@`, no control characters). */
  params: Record<string, string>;
}

/** The default display name of each built-in bot type. */
export const BUILT_IN_BOT_NAME_KEYS = {
  welcome: 'bots.welcome.defaultName',
  moderation: 'bots.moderation.defaultName',
} as const;

const MAX_PARAMS = 8;
const MAX_PARAM_LENGTH = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isBotMessageI18nKey(value: unknown): value is BotMessageI18nKey {
  return typeof value === 'string' && (BOT_MESSAGE_I18N_KEYS as readonly string[]).includes(value);
}

export function builtInBotNameKey(type: string): string | null {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_BOT_NAME_KEYS, type)
    ? BUILT_IN_BOT_NAME_KEYS[type as keyof typeof BUILT_IN_BOT_NAME_KEYS]
    : null;
}

/** The `metadata.i18n` of a bot's message, or null (not a bot, no i18n, unknown key). */
export function readBotMessageI18n(message: {
  userId?: string | null;
  botId?: string | null;
  metadata?: unknown;
}): BotMessageI18n | null {
  if (!readMessageBot(message)) return null;
  const raw = asRecord(asRecord(message.metadata)?.i18n);
  if (!raw || !isBotMessageI18nKey(raw.key)) return null;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(asRecord(raw.params) ?? {}).slice(0, MAX_PARAMS)) {
    if (typeof value === 'string') params[name] = value.slice(0, MAX_PARAM_LENGTH);
  }
  return { key: raw.key, params };
}

/**
 * What a viewer reads for this message: a built-in bot's default text in
 * the viewer's language, else the stored `content`.
 */
export function localizeBotMessage(
  message: { userId?: string | null; botId?: string | null; metadata?: unknown; content: string },
  t: Translate
): string {
  const i18n = readBotMessageI18n(message);
  if (!i18n) return message.content;
  const text = t(i18n.key, i18n.params);
  // A translator returns an unknown key as itself.
  return text && text !== i18n.key ? text : message.content;
}

/**
 * A bot's name as a viewer sees it: the built-in default in the viewer's
 * language when the server flagged the name as the default, else the name.
 */
export function botDisplayName(
  bot: { name: string; type: string; defaultName?: boolean },
  t: Translate,
  fallback = ''
): string {
  const key = bot.defaultName ? builtInBotNameKey(bot.type) : null;
  if (key) {
    const text = t(key);
    if (text && text !== key) return text;
  }
  return bot.name || fallback;
}
