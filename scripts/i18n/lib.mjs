// Translation tooling for LobbyForge — the one implementation of the
// catalogue rules, shared by the `pnpm i18n:*` commands and the tests.
//
// Two kinds of catalogue live in this repo:
//
//   apps/web/messages/<code>/_locale.json   name, direction, status
//   apps/web/messages/<code>/<area>.json    flat "key": "text" maps
//
//   plugins/<id>/locales/<code>.json        flat "key": "text" map; an
//                                           optional "$status": "partial"
//
// English (`en`) is the source everywhere: every other language is
// checked against it, and every gap falls back to it at runtime.
//
// Plain Node, no dependencies, so a translator can run it without
// installing anything beyond the repo itself.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'en';
export const META_FILE = '_locale.json';
export const CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const PLUGIN_INDEX = 'locales.generated.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

export function paths(root = REPO_ROOT) {
  return {
    appMessages: join(root, 'apps', 'web', 'messages'),
    plugins: join(root, 'plugins'),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDir(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

// ---------------------------------------------------------------------------
// Message syntax
// ---------------------------------------------------------------------------
//
// The format is defined — and formatted at runtime — by the plugin SDK
// (`packages/plugin-sdk/src/message-format.ts`): `{name}` arguments, and
// `{count, plural, one {…} other {…}}` / `{x, select, a {…} other {…}}`.
// This is the checking half, kept here so the tooling stays dependency
// free; `apps/web/lib/i18n/__tests__/tooling.test.ts` holds the two to the
// same answers over every message in the repo.

const ARG = /^\s*([A-Za-z0-9_]+)\s*$/;
const COMPLEX = /^\s*([A-Za-z0-9_]+)\s*,\s*(plural|select)\s*,([\s\S]*)$/;
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function parseCases(source) {
  const cases = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const lead = /^\s*/.exec(rest)[0].length;
    if (i + lead >= source.length) break;
    const selector = /^(=\d+|[A-Za-z0-9_]+)\s*\{/.exec(rest.slice(lead));
    if (!selector) return null;
    const open = i + lead + selector[0].length - 1;
    const close = closingBrace(source, open);
    if (close < 0) return null;
    cases.push({ selector: selector[1], body: source.slice(open + 1, close) });
    i = close + 1;
  }
  return cases;
}

/** Walk a message, collecting its argument names and any syntax problems. */
function analyse(text, found = { args: new Set(), problems: [] }) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const close = closingBrace(text, open);
    if (close < 0) {
      found.problems.push('has a "{" that is never closed');
      return found;
    }
    const inner = text.slice(open + 1, close);
    const simple = ARG.exec(inner);
    const complex = simple ? null : COMPLEX.exec(inner);
    const cases = complex ? parseCases(complex[3]) : null;
    if (simple) {
      found.args.add(simple[1]);
    } else if (!cases) {
      found.problems.push(`cannot read "{${inner}}" — write {name}, or {name, plural, one {…} other {…}}`);
    } else {
      const [, name, kind] = complex;
      found.args.add(name);
      if (!cases.some((c) => c.selector === 'other')) found.problems.push(`{${name}, ${kind}} needs an "other" case`);
      if (kind === 'plural') {
        for (const c of cases) {
          if (!c.selector.startsWith('=') && !PLURAL_CATEGORIES.has(c.selector)) {
            found.problems.push(`{${name}, plural} has "${c.selector}" — use zero, one, two, few, many, other or =N`);
          }
        }
      }
      for (const c of cases) analyse(c.body, found);
    }
    i = close + 1;
  }
  return found;
}

/** The argument names a message uses, sorted and de-duplicated. */
export function messageArguments(text) {
  return [...analyse(String(text)).args].sort();
}

/** What is wrong with a message's syntax — empty when nothing is. */
export function messageProblems(text) {
  return analyse(String(text)).problems;
}

export function placeholders(text) {
  return messageArguments(text).join(',');
}

const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

/** App languages on disk: `{ code, meta, files: { 'lobby.json': {...} } }`, English first. */
export function readAppLocales(root = REPO_ROOT) {
  const dir = paths(root).appMessages;
  const locales = [];
  const problems = [];
  for (const code of readdirSync(dir).sort()) {
    const localeDir = join(dir, code);
    if (!isDir(localeDir)) continue;
    if (!CODE_PATTERN.test(code)) {
      problems.push(`app: "${code}" is not a valid locale code`);
      continue;
    }
    if (!existsSync(join(localeDir, META_FILE))) {
      problems.push(`app: ${code}/ has no ${META_FILE}`);
      continue;
    }
    let meta;
    try {
      meta = readJson(join(localeDir, META_FILE));
    } catch (err) {
      problems.push(`app: ${code}/${META_FILE}: ${err.message}`);
      continue;
    }
    const files = {};
    for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.json') && f !== META_FILE).sort()) {
      try {
        files[file] = readJson(join(localeDir, file));
      } catch (err) {
        problems.push(`app: ${code}/${file}: ${err.message}`);
      }
    }
    locales.push({ code, meta, files });
  }
  locales.sort((a, b) => (a.code === SOURCE ? -1 : b.code === SOURCE ? 1 : a.code.localeCompare(b.code)));
  return { locales, problems };
}

/** Plugins with a `locales/` folder: `{ id, dir, tables: { en: {...}, tr: {...} } }`. */
export function readPlugins(root = REPO_ROOT) {
  const dir = paths(root).plugins;
  const withTables = [];
  const englishOnly = [];
  for (const id of readdirSync(dir).sort()) {
    const pluginDir = join(dir, id);
    if (!isDir(pluginDir) || !existsSync(join(pluginDir, 'package.json'))) continue;
    const localesDir = join(pluginDir, 'locales');
    if (!isDir(localesDir) || !existsSync(join(localesDir, `${SOURCE}.json`))) {
      englishOnly.push(id);
      continue;
    }
    const tables = {};
    for (const file of readdirSync(localesDir).filter((f) => f.endsWith('.json')).sort()) {
      tables[file.slice(0, -'.json'.length)] = readJson(join(localesDir, file));
    }
    withTables.push({ id, dir: pluginDir, localesDir, tables });
  }
  return { withTables, englishOnly };
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

function strings(table) {
  return Object.fromEntries(Object.entries(table).filter(([key]) => !key.startsWith('$')));
}

/**
 * Compare one translation to the source. Returns counts plus every rule
 * broken. `complete` decides whether gaps are problems or just progress.
 */
export function compare(source, target, { complete, label }) {
  const problems = [];
  const sourceKeys = Object.keys(source);
  let translated = 0;
  for (const key of sourceKeys) {
    const value = target[key];
    if (isBlank(value)) {
      if (complete) problems.push(`${label}: missing "${key}" (marked complete)`);
      continue;
    }
    translated += 1;
    for (const problem of messageProblems(value)) problems.push(`${label}: "${key}" ${problem}`);
    if (placeholders(value) !== placeholders(source[key])) {
      problems.push(`${label}: "${key}" uses {${placeholders(value)}} but English uses {${placeholders(source[key])}}`);
    }
  }
  const orphans = Object.keys(target).filter((key) => !(key in source));
  for (const key of orphans) problems.push(`${label}: "${key}" is not an English key (renamed or removed?)`);
  return { total: sourceKeys.length, translated, orphans, problems };
}

function validateMeta(code, meta) {
  const problems = [];
  if (!meta || typeof meta !== 'object') return [`app: ${code}/${META_FILE} must be an object`];
  if (typeof meta.name !== 'string' || !meta.name.trim()) problems.push(`app: ${code}/${META_FILE}: "name" is required`);
  if (typeof meta.englishName !== 'string' || !meta.englishName.trim()) {
    problems.push(`app: ${code}/${META_FILE}: "englishName" is required`);
  }
  if (meta.dir !== undefined && meta.dir !== 'ltr' && meta.dir !== 'rtl') {
    problems.push(`app: ${code}/${META_FILE}: "dir" must be "ltr" or "rtl"`);
  }
  if (meta.status !== 'complete' && meta.status !== 'partial') {
    problems.push(`app: ${code}/${META_FILE}: "status" must be "complete" or "partial"`);
  }
  return problems;
}

/** Where each English key lives, and any key English defines twice. */
function sourceLayout(sourceLocale) {
  const fileOf = new Map();
  const problems = [];
  for (const [file, table] of Object.entries(sourceLocale.files)) {
    for (const [key, value] of Object.entries(table)) {
      if (fileOf.has(key)) problems.push(`app: en "${key}" is defined in both ${fileOf.get(key)} and ${file}`);
      fileOf.set(key, file);
      if (isBlank(value)) problems.push(`app: en "${key}" is empty — English is the fallback and must be complete`);
    }
  }
  return { fileOf, problems };
}

function merge(files) {
  return Object.assign({}, ...Object.values(files));
}

/** Everything wrong with every catalogue, plus per-language progress. */
export function status(root = REPO_ROOT) {
  const problems = [];
  const app = readAppLocales(root);
  problems.push(...app.problems);
  const sourceLocale = app.locales.find((l) => l.code === SOURCE);
  const appRows = [];
  if (!sourceLocale) {
    problems.push(`app: no ${SOURCE}/ folder — English is the source and must exist`);
  } else {
    const { fileOf, problems: layoutProblems } = sourceLayout(sourceLocale);
    problems.push(...layoutProblems);
    const source = merge(sourceLocale.files);
    for (const locale of app.locales) {
      problems.push(...validateMeta(locale.code, locale.meta));
      if (locale.code === SOURCE) {
        for (const [key, value] of Object.entries(source)) {
          for (const problem of messageProblems(value)) problems.push(`app en: "${key}" ${problem}`);
        }
        appRows.push({ ...rowMeta(locale), total: Object.keys(source).length, translated: Object.keys(source).length });
        continue;
      }
      const seen = new Map();
      for (const [file, table] of Object.entries(locale.files)) {
        for (const key of Object.keys(table)) {
          if (seen.has(key)) problems.push(`app: ${locale.code} "${key}" is defined in both ${seen.get(key)} and ${file}`);
          seen.set(key, file);
          const expected = fileOf.get(key);
          if (expected && expected !== file) {
            problems.push(`app: ${locale.code} "${key}" is in ${file} but English keeps it in ${expected}`);
          }
        }
      }
      const result = compare(source, merge(locale.files), {
        complete: locale.meta?.status === 'complete',
        label: `app ${locale.code}`,
      });
      problems.push(...result.problems);
      appRows.push({ ...rowMeta(locale), total: result.total, translated: result.translated });
    }
  }

  const plugins = readPlugins(root);
  const pluginRows = [];
  for (const plugin of plugins.withTables) {
    const source = strings(plugin.tables[SOURCE]);
    const row = { id: plugin.id, languages: [] };
    for (const [code, table] of Object.entries(plugin.tables)) {
      if (!CODE_PATTERN.test(code)) {
        problems.push(`plugin ${plugin.id}: locales/${code}.json is not a valid locale code`);
        continue;
      }
      const declared = table.$status;
      if (declared !== undefined && declared !== 'partial' && declared !== 'complete') {
        problems.push(`plugin ${plugin.id}: ${code}.json "$status" must be "partial" or "complete"`);
      }
      if (code === SOURCE) {
        for (const [key, value] of Object.entries(source)) {
          if (isBlank(value)) problems.push(`plugin ${plugin.id}: en "${key}" is empty`);
          for (const problem of messageProblems(value)) problems.push(`plugin ${plugin.id}: en "${key}" ${problem}`);
        }
        row.languages.push({ code, total: Object.keys(source).length, translated: Object.keys(source).length });
        continue;
      }
      const result = compare(source, strings(table), {
        complete: declared !== 'partial',
        label: `plugin ${plugin.id} ${code}`,
      });
      problems.push(...result.problems);
      row.languages.push({ code, total: result.total, translated: result.translated, partial: declared === 'partial' });
    }
    const expectedIndex = pluginIndexSource(Object.keys(plugin.tables));
    const indexPath = join(plugin.dir, 'src', PLUGIN_INDEX);
    const actualIndex = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n') : null;
    if (actualIndex !== expectedIndex) {
      problems.push(`plugin ${plugin.id}: src/${PLUGIN_INDEX} is out of date — run \`pnpm i18n:sync\``);
    }
    pluginRows.push(row);
  }
  return { problems, appRows, pluginRows, englishOnlyPlugins: plugins.englishOnly };
}

function rowMeta(locale) {
  return {
    code: locale.code,
    name: locale.meta?.name ?? '?',
    englishName: locale.meta?.englishName ?? '?',
    status: locale.meta?.status ?? '?',
    dir: locale.meta?.dir ?? 'ltr',
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Lay a translation out in English's key order: every English key
 * present (blank when untranslated), translated values kept. Keys English
 * no longer has are kept at the end unless `prune` — deleting someone's
 * translation should be a decision, not a side effect.
 */
function alignTo(sourceTable, targetTable, { prune, meta } = {}) {
  const out = {};
  if (meta) for (const [key, value] of Object.entries(targetTable)) if (key.startsWith('$')) out[key] = value;
  for (const key of Object.keys(sourceTable)) {
    if (key.startsWith('$')) continue;
    out[key] = typeof targetTable[key] === 'string' ? targetTable[key] : '';
  }
  if (!prune) {
    for (const [key, value] of Object.entries(targetTable)) {
      if (!key.startsWith('$') && !(key in sourceTable)) out[key] = value;
    }
  }
  return out;
}

const identifierFor = (code) => code.replace(/[^A-Za-z0-9]/g, '_');

/** The generated import list a plugin loads its tables from. */
export function pluginIndexSource(codes) {
  const ordered = [SOURCE, ...codes.filter((c) => c !== SOURCE).sort()];
  const imports = ordered.map((code) => `import ${identifierFor(code)} from '../locales/${code}.json';`).join('\n');
  const entries = ordered
    .map((code) => (identifierFor(code) === code ? `  ${code},` : `  '${code}': ${identifierFor(code)},`))
    .join('\n');
  return `// Generated by \`pnpm i18n:sync\` from ../locales/*.json — do not edit.
// Add a language with \`pnpm i18n:add <code>\`; see docs/TRANSLATING.md.
${imports}

/** Every language this plugin ships, English first. */
export const LOCALE_TABLES = {
${entries}
};

export const SHIPPED_LOCALES: string[] = Object.keys(LOCALE_TABLES);
`;
}

function writePluginIndex(plugin) {
  const codes = readdirSync(plugin.localesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
  writeFileSync(join(plugin.dir, 'src', PLUGIN_INDEX), pluginIndexSource(codes), 'utf8');
}

/**
 * Bring every catalogue up to date with English: new English keys appear
 * as blanks in every other language (so translators can see the new
 * work), and every plugin's generated table index matches its folder.
 */
export function sync({ root = REPO_ROOT, prune = false } = {}) {
  const changed = [];
  const app = readAppLocales(root);
  const sourceLocale = app.locales.find((l) => l.code === SOURCE);
  if (sourceLocale) {
    for (const locale of app.locales) {
      if (locale.code === SOURCE) continue;
      const files = new Set([...Object.keys(sourceLocale.files), ...Object.keys(locale.files)]);
      for (const file of files) {
        const sourceTable = sourceLocale.files[file] ?? {};
        const current = locale.files[file] ?? {};
        if (!(file in sourceLocale.files) && prune) continue;
        const aligned = file in sourceLocale.files ? alignTo(sourceTable, current, { prune }) : current;
        if (JSON.stringify(aligned) !== JSON.stringify(current) || !(file in locale.files)) {
          writeJson(join(paths(root).appMessages, locale.code, file), aligned);
          changed.push(`apps/web/messages/${locale.code}/${file}`);
        }
      }
    }
  }
  for (const plugin of readPlugins(root).withTables) {
    const source = plugin.tables[SOURCE];
    for (const [code, table] of Object.entries(plugin.tables)) {
      if (code === SOURCE) continue;
      const aligned = alignTo(source, table, { prune, meta: true });
      if (JSON.stringify(aligned) !== JSON.stringify(table)) {
        writeJson(join(plugin.localesDir, `${code}.json`), aligned);
        changed.push(`plugins/${plugin.id}/locales/${code}.json`);
      }
    }
    const indexPath = join(plugin.dir, 'src', PLUGIN_INDEX);
    const before = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
    writePluginIndex(plugin);
    if (readFileSync(indexPath, 'utf8') !== before) changed.push(`plugins/${plugin.id}/src/${PLUGIN_INDEX}`);
  }
  return changed;
}

/** Scaffold a new language across the app and every translatable plugin. */
export function addLanguage({ root = REPO_ROOT, code, name, englishName, rtl = false }) {
  if (!CODE_PATTERN.test(code)) throw new Error(`"${code}" is not a locale code — use e.g. "de", "pt-BR", "zh-Hans"`);
  if (code === SOURCE) throw new Error('English is the source language and already exists');
  if (!name?.trim()) throw new Error('--name is required: the language\'s name in itself, e.g. "Deutsch"');
  if (!englishName?.trim()) throw new Error('--english is required: the language\'s English name, e.g. "German"');
  const appDir = join(paths(root).appMessages, code);
  if (existsSync(appDir)) throw new Error(`apps/web/messages/${code} already exists`);

  const app = readAppLocales(root);
  const sourceLocale = app.locales.find((l) => l.code === SOURCE);
  if (!sourceLocale) throw new Error('apps/web/messages/en is missing');
  const created = [];
  writeJson(join(appDir, META_FILE), {
    name: name.trim(),
    englishName: englishName.trim(),
    dir: rtl ? 'rtl' : 'ltr',
    status: 'partial',
  });
  created.push(`apps/web/messages/${code}/${META_FILE}`);
  for (const [file, table] of Object.entries(sourceLocale.files)) {
    writeJson(join(appDir, file), alignTo(table, {}));
    created.push(`apps/web/messages/${code}/${file}`);
  }
  for (const plugin of readPlugins(root).withTables) {
    const target = join(plugin.localesDir, `${code}.json`);
    if (existsSync(target)) continue;
    writeJson(target, { $status: 'partial', ...alignTo(plugin.tables[SOURCE], {}) });
    created.push(`plugins/${plugin.id}/locales/${code}.json`);
  }
  sync({ root });
  return created;
}

/** Flip a finished language to `complete`, refusing while anything is untranslated. */
export function markComplete({ root = REPO_ROOT, code }) {
  const report = status(root);
  const row = report.appRows.find((r) => r.code === code);
  if (!row) throw new Error(`No app language "${code}"`);
  const gaps = [];
  if (row.translated < row.total) gaps.push(`app: ${row.total - row.translated} untranslated`);
  for (const plugin of report.pluginRows) {
    const lang = plugin.languages.find((l) => l.code === code);
    if (lang && lang.translated < lang.total) gaps.push(`plugin ${plugin.id}: ${lang.total - lang.translated} untranslated`);
  }
  if (gaps.length > 0) throw new Error(`${code} is not finished yet:\n  ${gaps.join('\n  ')}`);
  const metaPath = join(paths(root).appMessages, code, META_FILE);
  writeJson(metaPath, { ...readJson(metaPath), status: 'complete' });
  for (const plugin of readPlugins(root).withTables) {
    const path = join(plugin.localesDir, `${code}.json`);
    if (!existsSync(path)) continue;
    const table = readJson(path);
    if (table.$status === undefined) continue;
    delete table.$status;
    writeJson(path, table);
  }
}
