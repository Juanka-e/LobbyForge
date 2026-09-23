import enCommon from '@/messages/en/common.json';
import enLobby from '@/messages/en/lobby.json';
import enLobbyMain from '@/messages/en/lobbyMain.json';
import enSettings from '@/messages/en/settings.json';
import enAdmin from '@/messages/en/admin.json';
import trCommon from '@/messages/tr/common.json';
import trLobby from '@/messages/tr/lobby.json';
import trLobbyMain from '@/messages/tr/lobbyMain.json';
import trSettings from '@/messages/tr/settings.json';
import trAdmin from '@/messages/tr/admin.json';
import { DEFAULT_APP_LOCALE, isAppLocale, type AppLocale } from '@/lib/app-locale';

/**
 * The app's own message catalogues.
 *
 * Deliberately the same shape as the plugin locale tables: a flat map of
 * dotted keys to strings. Plugins already work this way, contributors
 * only have to learn it once, and a flat file diffs cleanly.
 *
 * Split one file per AREA rather than one per language, so two people
 * translating different screens never touch the same file. The imports
 * below are the index — adding an area means adding it here, which is
 * the one place that has to be edited in step with a new file.
 *
 * `en` is the source of truth. A key missing from another language
 * falls back to English rather than rendering the raw key at someone —
 * a half-translated screen is readable, a screen full of
 * `lobby.voice.connected` is not.
 */

export type Messages = Record<string, string>;

const CATALOGUES: Record<AppLocale, Messages> = {
  en: { ...enCommon, ...enLobby, ...enLobbyMain, ...enSettings, ...enAdmin },
  tr: { ...trCommon, ...trLobby, ...trLobbyMain, ...trSettings, ...trAdmin },
};

export function getMessages(locale: string): Messages {
  return isAppLocale(locale) ? CATALOGUES[locale] : CATALOGUES[DEFAULT_APP_LOCALE];
}

/** Every key the app can translate — `en` defines the set. */
export function messageKeys(): string[] {
  return Object.keys(CATALOGUES[DEFAULT_APP_LOCALE]);
}

/**
 * Substitute `{name}` placeholders. Values are inserted verbatim: React
 * escapes them on render, and the catalogues are ours, not user input.
 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match
  );
}

export type Translator = (key: string, params?: Record<string, string | number>) => string;

/**
 * Build a translator for one locale.
 *
 * An unknown key returns the key itself — visible in development, and
 * honest in production: it says exactly which string was never added,
 * instead of an empty space nobody can trace.
 */
export function createTranslator(locale: string): Translator {
  const messages = getMessages(locale);
  const fallback = CATALOGUES[DEFAULT_APP_LOCALE];
  return (key, params) => interpolate(messages[key] ?? fallback[key] ?? key, params);
}
