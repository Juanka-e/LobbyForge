'use client';

import { createContext, useContext } from 'react';
import { tFor } from '@lobbyforge/plugin-sdk';
import { HUSHLE_PLUGIN_ID } from '../plugin-id';

/**
 * The panel's translator, handed down through context so every part of
 * the panel speaks the same language the root picked. Keys are always
 * written out in full — `t('hushle.lobby.packLabel')` — because the
 * locales test finds the keys the panel uses by reading these files.
 */

export type TranslateParams = Record<string, string | number>;
export type Translate = (key: string, params?: TranslateParams) => string;

export interface HushleI18n {
  /** The plugin language this viewer gets (one Hushle ships). */
  locale: string;
  t: Translate;
}

export function createHushleI18n(locale: string): HushleI18n {
  return { locale, t: (key, params) => tFor(HUSHLE_PLUGIN_ID, locale, key, params) };
}

const HushleI18nContext = createContext<HushleI18n>(createHushleI18n('en'));

export const HushleI18nProvider = HushleI18nContext.Provider;

export function useHushleI18n(): HushleI18n {
  return useContext(HushleI18nContext);
}

/**
 * "English", "Türkçe" — a language in its OWN name, the way a language
 * picker shows it (see the glossary: language names are not translated).
 */
export function autonym(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : code;
  } catch {
    return code;
  }
}

/** A language's name in the viewer's language — "Turkish" for an English reader. */
export function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Ice, Amber and Moss" in the viewer's language. */
export function listOf(items: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}
