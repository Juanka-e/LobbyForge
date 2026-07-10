import { locales, type TranslationKey } from './locales.js';

export type LanguagePack = Record<string, string>;
export type TranslationTable = Record<string, LanguagePack>;

const localeTable = locales as TranslationTable;

/**
 * Standalone helper function t() with fallback logic:
 * user locale -> server default -> 'en' (and key itself as fallback),
 * supporting parameter interpolation.
 */
export function t(
  key: TranslationKey | string,
  params?: Record<string, string | number>,
  userLocale?: string,
  serverDefaultLocale?: string
): string {
  const defaultLocale = serverDefaultLocale || 'en';
  const resolvedUserLocale = userLocale || defaultLocale;

  let template: string | undefined;

  // Fallback: user locale -> server default -> 'en'
  if (resolvedUserLocale in localeTable) {
    template = localeTable[resolvedUserLocale]?.[key];
  }

  if (template === undefined && defaultLocale in localeTable) {
    template = localeTable[defaultLocale]?.[key];
  }

  if (template === undefined) {
    template = localeTable['en']?.[key];
  }

  if (template === undefined) {
    return key;
  }

  if (params) {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, paramName) => {
      const val = params[paramName];
      return val !== undefined ? String(val) : match;
    });
  }

  return template;
}

export class Translator {
  private table: TranslationTable = {};
  private defaultLocale: string;

  constructor(defaultLocale = 'en') {
    this.defaultLocale = defaultLocale;
    // Pre-register all supported locales
    for (const [localeName, pack] of Object.entries(locales)) {
      this.register(localeName, pack);
    }
  }

  register(locale: string, pack: LanguagePack): void {
    this.table[locale] = { ...(this.table[locale] ?? {}), ...pack };
  }

  registerPluginLocales(pluginId: string, pluginLocales: Record<string, Record<string, string>>): void {
    for (const [lang, translations] of Object.entries(pluginLocales)) {
      if (!this.table[lang]) {
        this.table[lang] = {};
      }
      for (const [key, value] of Object.entries(translations)) {
        this.table[lang][`${pluginId}.${key}`] = value;
        if (key.startsWith(`${pluginId}.`)) {
          this.table[lang][key] = value;
        }
      }
    }
  }

  setDefaultLocale(locale: string): void {
    this.defaultLocale = locale;
  }

  translate(key: string, locale?: string, params?: Record<string, string | number>): string {
    const useLocale = locale ?? this.defaultLocale;
    
    // Fallback logic
    let template = this.table[useLocale]?.[key];
    if (template === undefined && this.defaultLocale !== useLocale) {
      template = this.table[this.defaultLocale]?.[key];
    }
    if (template === undefined && useLocale !== 'en' && this.defaultLocale !== 'en') {
      template = this.table['en']?.[key];
    }
    if (template === undefined) {
      template = key;
    }

    if (params) {
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, paramName) => {
        const val = params[paramName];
        return val !== undefined ? String(val) : match;
      });
    }
    return template;
  }

  t(key: string, params: Record<string, string | number> = {}, options: { locale?: string; fallbackLocale?: string } = {}): string {
    const useLocale = options.locale ?? this.defaultLocale;
    const fallback = options.fallbackLocale ?? this.defaultLocale;
    
    let template = this.table[useLocale]?.[key];
    if (template === undefined && fallback !== useLocale) {
      template = this.table[fallback]?.[key];
    }
    if (template === undefined && useLocale !== 'en' && fallback !== 'en') {
      template = this.table['en']?.[key];
    }
    if (template === undefined) {
      template = key;
    }

    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, paramName) => {
      const val = params[paramName];
      return val !== undefined ? String(val) : match;
    });
  }
}
