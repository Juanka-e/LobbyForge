import { createContext, useContext } from 'react';
import { tFor } from '@lobbyforge/plugin-sdk';
import { VAMPIRE_VILLAGE_PLUGIN_ID } from '../plugin-id';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface VillageText {
  t: Translate;
  locale: string;
  /** "Ada, Bram and Cleo" — joined the way the viewer's language joins a list. */
  list: (items: string[]) => string;
}

export function makeText(locale: string): VillageText {
  let formatter: Intl.ListFormat | null = null;
  try {
    formatter = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  } catch {
    formatter = null;
  }
  return {
    t: (key, params) => tFor(VAMPIRE_VILLAGE_PLUGIN_ID, locale, key, params),
    locale,
    list: (items) => (formatter ? formatter.format(items) : items.join(', ')),
  };
}

export const TextContext = createContext<VillageText>(makeText('en'));

export function useText(): VillageText {
  return useContext(TextContext);
}
