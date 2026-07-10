import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const en = require('../locales/en.json');
const tr = require('../locales/tr.json');

export const locales = {
  en,
  tr,
} as const;

export type Locale = keyof typeof locales;
export type TranslationKey = string;

export const SUPPORTED_LOCALES: Locale[] = ['en', 'tr'];
