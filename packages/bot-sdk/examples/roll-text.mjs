/**
 * What the /roll examples say, in English and Turkish, and which of the two
 * each person gets. Shared by roll-bot.mjs (event stream) and http-bot.mjs
 * (HTTPS endpoint).
 *
 * Every interaction carries the language of the member who ran the command
 * (`interaction.locale` — an installed language code of the instance, such
 * as "tr" or "pt-BR"). `pickBestLocale` picks the closest language this bot
 * ships ("tr" → Turkish, "pt-BR" → English here, since there is no "pt"),
 * and `tFor` fills in the sentence. Adding a language is one more table.
 *
 * Message events carry no language (a channel message is read by
 * everyone), so the "!roll" chat command answers in DEFAULT_LOCALE.
 */
import { loadBotLocale, pickBestLocale, tFor } from '../dist/locale.js';

export const ROLL_BOT_ID = 'roll-example';

/** The language for anything that is not an interaction (e.g. "!roll"). */
export const DEFAULT_LOCALE = 'en';

export const ROLL_STRINGS = {
  en: {
    'roll.result': '{name} rolled {result} ({sides}-sided)',
    'roll.someone': 'Someone',
  },
  tr: {
    'roll.result': '{name} {result} attı ({sides} yüzlü)',
    'roll.someone': 'Biri',
  },
};

loadBotLocale(ROLL_BOT_ID, ROLL_STRINGS);

/** The language this bot answers in for a member's `locale` (unknown or missing → English). */
export function rollLocale(locale) {
  return pickBestLocale(ROLL_BOT_ID, locale, DEFAULT_LOCALE);
}

/** "Ayşe rolled 18 (20-sided)" for `en`, "Ayşe 18 attı (20 yüzlü)" for `tr`. */
export function rollAnswer(locale, { name, result, sides }) {
  const language = rollLocale(locale);
  return tFor(
    ROLL_BOT_ID,
    language,
    'roll.result',
    { name: name || tFor(ROLL_BOT_ID, language, 'roll.someone'), result, sides },
    DEFAULT_LOCALE
  );
}
