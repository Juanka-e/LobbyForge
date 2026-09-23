import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCALE_CODE_PATTERN,
  SOURCE_LOCALE,
  createTranslator,
  resolveMessages,
  type LocaleInfo,
  type Messages,
  type Translator,
} from './core';

/**
 * Where the catalogues come from — SERVER ONLY (it reads the disk).
 *
 * The directory IS the registry. A language is a folder:
 *
 *   messages/
 *     en/_locale.json   ← name, direction, status
 *     en/lobby.json     ← flat "key": "text" maps, one file per area
 *     tr/…
 *
 * Nothing in the code lists the languages or the files, so adding a
 * language is adding a folder (`pnpm i18n:add` scaffolds one) and adding
 * an area is adding a file. Before this, a new language meant editing a
 * locale list, a label map, an import line per area per language, and
 * every plugin — about twenty places, all TypeScript.
 *
 * Only the active language's messages ever reach the browser (see
 * `I18nProvider`), so each language added costs nothing in the bundle.
 */

/** `next start` / `next dev` run from `apps/web`, as do the tests. */
export const MESSAGES_ROOT = join(process.cwd(), 'messages');

/** The per-language metadata file; every other `.json` is a message file. */
export const LOCALE_META_FILE = '_locale.json';

export interface CatalogueFiles {
  /** File name → its messages, exactly as on disk (empty values kept). */
  files: Record<string, Messages>;
  /** Every file merged. Empty values kept — callers decide what they mean. */
  messages: Messages;
  /** Keys defined in more than one file of the same language. */
  duplicates: string[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a `_locale.json`, or explain what is wrong with it. */
export function parseLocaleMeta(code: string, raw: unknown): LocaleInfo | string {
  if (!isRecord(raw)) return `${code}/${LOCALE_META_FILE} must be a JSON object`;
  const { name, englishName, dir, status } = raw;
  if (typeof name !== 'string' || !name.trim()) return `${code}/${LOCALE_META_FILE}: "name" is required`;
  if (typeof englishName !== 'string' || !englishName.trim()) {
    return `${code}/${LOCALE_META_FILE}: "englishName" is required`;
  }
  if (dir !== undefined && dir !== 'ltr' && dir !== 'rtl') {
    return `${code}/${LOCALE_META_FILE}: "dir" must be "ltr" or "rtl"`;
  }
  if (status !== 'complete' && status !== 'partial') {
    return `${code}/${LOCALE_META_FILE}: "status" must be "complete" or "partial"`;
  }
  return { code, name: name.trim(), englishName: englishName.trim(), dir: dir ?? 'ltr', status };
}

export interface Discovery {
  locales: LocaleInfo[];
  /** Folders that look like locales but could not be loaded, and why. */
  problems: string[];
}

/**
 * Every language on disk, source language first then by code.
 *
 * A broken folder is reported, not thrown: one malformed community
 * translation must not take the whole instance down. The tests and
 * `pnpm i18n:status` turn `problems` into failures, so it is still loud
 * where it should be.
 */
export function discoverLocales(root: string = MESSAGES_ROOT): Discovery {
  const locales: LocaleInfo[] = [];
  const problems: string[] = [];
  if (!existsSync(root)) return { locales, problems: [`messages directory not found: ${root}`] };
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (!LOCALE_CODE_PATTERN.test(entry)) {
      problems.push(`"${entry}" is not a valid locale code (expected e.g. "tr", "pt-BR")`);
      continue;
    }
    const metaPath = join(dir, LOCALE_META_FILE);
    if (!existsSync(metaPath)) {
      problems.push(`${entry}/ has no ${LOCALE_META_FILE}`);
      continue;
    }
    try {
      const parsed = parseLocaleMeta(entry, readJson(metaPath));
      if (typeof parsed === 'string') problems.push(parsed);
      else locales.push(parsed);
    } catch (err) {
      problems.push(`${entry}/${LOCALE_META_FILE}: ${(err as Error).message}`);
    }
  }
  locales.sort((a, b) =>
    a.code === SOURCE_LOCALE ? -1 : b.code === SOURCE_LOCALE ? 1 : a.code.localeCompare(b.code)
  );
  return { locales, problems };
}

/**
 * Read one language's files as they are on disk. The code MUST come from
 * `discoverLocales` — it becomes a path — so this refuses anything that
 * does not look like a locale code rather than trusting its caller.
 */
export function readCatalogue(code: string, root: string = MESSAGES_ROOT): CatalogueFiles {
  if (!LOCALE_CODE_PATTERN.test(code)) throw new Error(`Refusing to read locale "${code}"`);
  const dir = join(root, code);
  const files: Record<string, Messages> = {};
  const messages: Messages = {};
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== LOCALE_META_FILE).sort()) {
    const raw = readJson(join(dir, file));
    if (!isRecord(raw)) throw new Error(`${code}/${file} must be a flat JSON object`);
    const table: Messages = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string') throw new Error(`${code}/${file}: "${key}" must be a string`);
      table[key] = value;
      const firstFile = seen.get(key);
      if (firstFile && firstFile !== file) duplicates.push(`${key} (${firstFile}, ${file})`);
      seen.set(key, file);
      messages[key] = value;
    }
    files[file] = table;
  }
  return { files, messages, duplicates };
}

// Production reads each language once; development re-reads on every
// request so a translator sees their edit on refresh, no restart needed.
const cache = new Map<string, Messages>();
const discoveryCache = new Map<string, Discovery>();
const shouldCache = () => process.env.NODE_ENV === 'production';

export function getDiscovery(root: string = MESSAGES_ROOT): Discovery {
  if (shouldCache()) {
    const hit = discoveryCache.get(root);
    if (hit) return hit;
  }
  const discovery = discoverLocales(root);
  if (discovery.problems.length > 0) {
    console.warn(`[i18n] ignoring broken locale folders:\n  ${discovery.problems.join('\n  ')}`);
  }
  if (shouldCache()) discoveryCache.set(root, discovery);
  return discovery;
}

/**
 * The messages a page in `code` should use: its translations over the
 * English catalogue, so every gap reads in English rather than as a raw
 * key. Unknown codes get English — the code usually comes from a cookie.
 */
export function loadMessages(code: string, root: string = MESSAGES_ROOT): Messages {
  const known = getDiscovery(root).locales.some((locale) => locale.code === code);
  const target = known ? code : SOURCE_LOCALE;
  const cacheKey = `${root}\u0000${target}`;
  if (shouldCache()) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }
  const source = readCatalogue(SOURCE_LOCALE, root).messages;
  const resolved =
    target === SOURCE_LOCALE ? resolveMessages({}, source) : resolveMessages(source, readCatalogue(target, root).messages);
  if (shouldCache()) cache.set(cacheKey, resolved);
  return resolved;
}

/**
 * A translator for a FIXED language, outside any request — for tests,
 * and for server work that is not answering a browser (a notification
 * rendered in the recipient's language, say). Request handlers want
 * `getTranslator()` from `./server`, which honours the visitor's choice.
 */
export function translatorFor(code: string, root: string = MESSAGES_ROOT): Translator {
  const known = getDiscovery(root).locales.some((locale) => locale.code === code);
  return createTranslator(known ? code : SOURCE_LOCALE, loadMessages(code, root));
}

/** Everything `I18nProvider` takes, for one fixed language. */
export function providerPropsFor(code: string, root: string = MESSAGES_ROOT) {
  const { locales } = getDiscovery(root);
  const info = locales.find((locale) => locale.code === code) ?? locales[0];
  return {
    locale: info?.code ?? SOURCE_LOCALE,
    dir: info?.dir ?? ('ltr' as const),
    messages: loadMessages(code, root),
    locales,
    choice: code,
  };
}
