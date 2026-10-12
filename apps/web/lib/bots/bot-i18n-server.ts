/**
 * The server half of lib/bots/bot-i18n.ts — SERVER ONLY (it reads every
 * installed language's catalogue from disk).
 *
 * "Is this the default?" is answered against the shipped default texts of
 * EVERY installed language, not just one: the stored text may have been
 * written in the instance language (the server's default) or in the
 * admin's own language (older admin pages sent their pre-filled default on
 * every save). Either way it is the default, so:
 *
 *   - a greeting / notice template equal to a shipped default counts as
 *     "none written" — it is read as null, and normalised to null on the
 *     next real save (no migration);
 *   - a built-in bot name equal to a shipped default name is flagged
 *     `defaultName: true` wherever the bot is sent to a browser, and shown
 *     in each viewer's language.
 */
import { getDiscovery, loadMessages } from '@/lib/i18n/catalogue';
import { cleanBotTemplateValues, type BotDefaultTextKey } from './templates';
import { readMessageBot, type MessageBotInfo } from './message-meta';
import {
  botDisplayName,
  builtInBotNameKey,
  localizeBotMessage,
  type BotMessageI18n,
  type BotMessageI18nKey,
} from './bot-i18n';

const DEFAULT_TEXT_KEYS: readonly BotDefaultTextKey[] = [
  'bots.welcome.defaultTemplate',
  'bots.welcome.defaultName',
  'bots.moderation.defaultNotice',
  'bots.moderation.defaultName',
];

/**
 * Catalogues are cached for good in production (they cannot change without
 * a restart); in development they are re-read on every request so a
 * translator sees their edit — a few seconds of memo keeps a page of
 * messages from reading every catalogue once per message.
 */
const DEV_TTL_MS = 5_000;
let memo: { at: number; texts: Map<BotDefaultTextKey, Set<string>> } | null = null;

function shippedTexts(): Map<BotDefaultTextKey, Set<string>> {
  const now = Date.now();
  if (memo && (process.env.NODE_ENV === 'production' || now - memo.at < DEV_TTL_MS)) return memo.texts;
  const texts = new Map<BotDefaultTextKey, Set<string>>(DEFAULT_TEXT_KEYS.map((key) => [key, new Set<string>()]));
  for (const { code } of getDiscovery().locales) {
    // Resolved over English: a blank (untranslated) entry reads as English.
    const messages = loadMessages(code);
    for (const key of DEFAULT_TEXT_KEYS) {
      const value = messages[key]?.trim();
      if (value) texts.get(key)!.add(value);
    }
  }
  memo = { at: now, texts };
  return texts;
}

/** Test-only. */
export function __resetBotI18nCache(): void {
  memo = null;
}

/** True when `text` is the shipped default for `key` in any installed language. */
export function isShippedDefaultText(key: BotDefaultTextKey, text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  return Boolean(trimmed) && shippedTexts().get(key)!.has(trimmed!);
}

/** The admin's own text, or null when there is none or it is a shipped default. */
export function customBotText(key: BotDefaultTextKey, text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed || isShippedDefaultText(key, trimmed)) return null;
  return trimmed;
}

/** A built-in bot whose name is still its default (in any installed language). */
export function isDefaultBuiltInBotName(type: string, name: string): boolean {
  const key = builtInBotNameKey(type) as BotDefaultTextKey | null;
  return key !== null && isShippedDefaultText(key, name);
}

/** The bot as a browser gets it: `defaultName: true` when its name is the default. */
export function withDefaultNameFlag<T extends { name: string; type: string }>(bot: T): T & { defaultName?: true } {
  return isDefaultBuiltInBotName(bot.type, bot.name) ? { ...bot, defaultName: true as const } : bot;
}

/** `readMessageBot` for a message sent to a browser (the messages API, the first paint). */
export function messageBotJson(message: {
  botId?: string | null;
  userId?: string | null;
  metadata?: unknown;
}): MessageBotInfo | null {
  const bot = readMessageBot(message);
  return bot ? withDefaultNameFlag(bot) : null;
}

/**
 * A bot's message as the lobby's first server render shows it to one
 * viewer: the bot (flagged), its name and the text — a built-in bot's
 * default name and default texts in the viewer's language (`t`), anything
 * an admin wrote exactly as written. Null for a message no bot wrote.
 */
export function botMessageForViewer(
  message: { botId?: string | null; userId?: string | null; metadata?: unknown; content: string },
  t: (key: string, params?: Record<string, string | number>) => string
): { bot: MessageBotInfo; author: string; body: string } | null {
  const bot = messageBotJson(message);
  if (!bot) return null;
  return {
    bot,
    author: botDisplayName(bot, t, t('lobbyMain.chat.unknownBot')),
    body: localizeBotMessage(message, t),
  };
}

/** The `metadata.i18n` a built-in bot stores with a default text. */
export function botTextI18n(key: BotMessageI18nKey, values: Record<string, string>): { i18n: BotMessageI18n } {
  return { i18n: { key, params: cleanBotTemplateValues(values) } };
}

/**
 * Stored built-in settings with a template that is a shipped default read
 * as null ("none written") — for the admin page and the next save.
 */
export function normalizeBuiltInSettings<T extends object>(type: string, settings: T): T {
  const record = settings as Record<string, unknown>;
  if (type === 'welcome' && 'template' in record) {
    return { ...settings, template: customBotText('bots.welcome.defaultTemplate', record.template as string | null) };
  }
  if (type === 'moderation' && 'noticeTemplate' in record) {
    return {
      ...settings,
      noticeTemplate: customBotText('bots.moderation.defaultNotice', record.noticeTemplate as string | null),
    };
  }
  return settings;
}
