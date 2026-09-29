/**
 * Filling in the admin-written templates of the built-in bots
 * (`{user}`, `{server}`), and their default texts.
 *
 * Templates are plain text chosen by an admin, not catalogue messages,
 * so they are filled with a literal replace — braces an admin types stay
 * as typed. Values come from members (display names), so they are
 * cleaned: no control characters and no `@` — a member called
 * "@everyone" must not turn the greeting into a server-wide ping.
 */
import { getDiscovery, translatorFor } from '@/lib/i18n/catalogue';
import { MAX_BOT_MESSAGE_LENGTH } from './catalog';

const VALUE_MAX_LENGTH = 100;

function cleanValue(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VALUE_MAX_LENGTH);
}

export function renderBotTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [name, value] of Object.entries(values)) {
    out = out.split(`{${name}}`).join(cleanValue(value));
  }
  return out.trim().slice(0, MAX_BOT_MESSAGE_LENGTH);
}

/**
 * The language the built-in bots speak when an admin has not written
 * their own text: the instance default (`LOBBYFORGE_DEFAULT_LOCALE`) when
 * it is installed, else English. A bot posts to everyone at once, so it
 * cannot follow any one reader's language.
 */
export function instanceBotLocale(): string {
  const configured = process.env.LOBBYFORGE_DEFAULT_LOCALE?.trim().toLowerCase();
  if (!configured) return 'en';
  const match = getDiscovery().locales.find((locale) => locale.code.toLowerCase() === configured);
  return match?.code ?? 'en';
}

export type BotDefaultTextKey =
  | 'bots.welcome.defaultTemplate'
  | 'bots.welcome.defaultName'
  | 'bots.moderation.defaultNotice'
  | 'bots.moderation.defaultName';

/** A default text in the instance language, placeholders left in. */
export function defaultBotText(key: BotDefaultTextKey): string {
  return translatorFor(instanceBotLocale())(key);
}
