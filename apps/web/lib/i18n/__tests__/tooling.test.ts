import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { messageArguments as runtimeArguments } from '@lobbyforge/plugin-sdk';
import {
  addLanguage,
  markComplete,
  messageArguments,
  messageProblems,
  readAppLocales,
  readPlugins,
  status,
  sync,
} from '../../../../../scripts/i18n/lib.mjs';

/**
 * The promise this project makes to translators: adding a language is
 * one command and some JSON. These tests walk that exact path — against
 * a throwaway copy of the repo's layout, so nothing real is touched.
 */

let root: string;

function writeJson(path: string, value: unknown) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, string>;

function scaffoldRepo() {
  root = mkdtempSync(join(tmpdir(), 'lf-i18n-tool-'));
  writeJson('apps/web/messages/en/_locale.json', { name: 'English', englishName: 'English', status: 'complete' });
  writeJson('apps/web/messages/en/lobby.json', { 'lobby.hello': 'Hello {name}', 'lobby.bye': 'Goodbye' });
  writeJson('apps/web/messages/en/admin.json', { 'admin.title': 'Settings' });
  writeJson('plugins/game/package.json', { name: '@x/game' });
  writeJson('plugins/game/locales/en.json', { 'game.start': 'Start', 'game.score': 'Score: {points}' });
  mkdirSync(join(root, 'plugins/game/src'), { recursive: true });
  writeJson('plugins/plain/package.json', { name: '@x/plain' });
  sync({ root });
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pnpm i18n:add', () => {
  it('scaffolds the language across the app and every translatable plugin', () => {
    scaffoldRepo();
    const created = addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    expect(created).toEqual(
      expect.arrayContaining([
        'apps/web/messages/de/_locale.json',
        'apps/web/messages/de/lobby.json',
        'apps/web/messages/de/admin.json',
        'plugins/game/locales/de.json',
      ])
    );
    // Every English key is there, blank — a fill-in-the-blanks template
    // in the same order as English, so the two read side by side.
    expect(readJson('apps/web/messages/de/lobby.json')).toEqual({ 'lobby.hello': '', 'lobby.bye': '' });
    expect(readJson('apps/web/messages/de/_locale.json')).toMatchObject({ name: 'Deutsch', status: 'partial', dir: 'ltr' });
    expect(readJson('plugins/game/locales/de.json')).toEqual({ $status: 'partial', 'game.start': '', 'game.score': '' });
    // The plugin's generated table index picks the new file up.
    expect(readFileSync(join(root, 'plugins/game/src/locales.generated.ts'), 'utf8')).toContain("import de from '../locales/de.json';");
  });

  it('leaves the repo passing its checks straight away — a fresh language is valid at 0%', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    const report = status(root);
    expect(report.problems).toEqual([]);
    expect(report.appRows.find((r) => r.code === 'de')).toMatchObject({ status: 'partial', translated: 0, total: 3 });
    expect(report.englishOnlyPlugins).toEqual(['plain']);
  });

  it('records a right-to-left language as such', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'ar', name: 'العربية', englishName: 'Arabic', rtl: true });
    expect(readJson('apps/web/messages/ar/_locale.json')).toMatchObject({ dir: 'rtl' });
  });

  it('refuses bad input rather than guessing', () => {
    scaffoldRepo();
    expect(() => addLanguage({ root, code: 'German', name: 'Deutsch', englishName: 'German' })).toThrow(/locale code/);
    expect(() => addLanguage({ root, code: 'de', englishName: 'German' })).toThrow(/--name/);
    expect(() => addLanguage({ root, code: 'en', name: 'x', englishName: 'x' })).toThrow(/source/);
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    expect(() => addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' })).toThrow(/already exists/);
  });
});

describe('translating, then marking complete', () => {
  it('will not mark a language complete while anything is untranslated', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    writeJson('apps/web/messages/de/lobby.json', { 'lobby.hello': 'Hallo {name}', 'lobby.bye': 'Tschüss' });
    expect(() => markComplete({ root, code: 'de' })).toThrow(/not finished/);
  });

  it('marks it complete once every string is done, and holds it to that', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    writeJson('apps/web/messages/de/lobby.json', { 'lobby.hello': 'Hallo {name}', 'lobby.bye': 'Tschüss' });
    writeJson('apps/web/messages/de/admin.json', { 'admin.title': 'Einstellungen' });
    writeJson('plugins/game/locales/de.json', { $status: 'partial', 'game.start': 'Start', 'game.score': 'Punkte: {points}' });
    markComplete({ root, code: 'de' });
    expect(readJson('apps/web/messages/de/_locale.json').status).toBe('complete');
    expect(readJson('plugins/game/locales/de.json').$status).toBeUndefined();
    expect(status(root).problems).toEqual([]);

    // A new English string now makes the complete language fail — which is
    // the point: `complete` is a promise the tests keep.
    writeJson('apps/web/messages/en/admin.json', { 'admin.title': 'Settings', 'admin.save': 'Save' });
    expect(status(root).problems.join('\n')).toMatch(/de.*admin\.save/);
  });

  it('catches a translation that breaks a placeholder', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    writeJson('apps/web/messages/de/lobby.json', { 'lobby.hello': 'Hallo {nme}', 'lobby.bye': '' });
    expect(status(root).problems.join('\n')).toMatch(/lobby\.hello/);
  });
});

describe('pnpm i18n:sync', () => {
  it('gives every language a blank for each new English string', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    writeJson('apps/web/messages/de/lobby.json', { 'lobby.hello': 'Hallo {name}', 'lobby.bye': 'Tschüss' });
    writeJson('apps/web/messages/en/lobby.json', { 'lobby.hello': 'Hello {name}', 'lobby.bye': 'Goodbye', 'lobby.new': 'New' });
    sync({ root });
    // Translations kept; the new string appears, blank, where a translator will see it.
    expect(readJson('apps/web/messages/de/lobby.json')).toEqual({
      'lobby.hello': 'Hallo {name}',
      'lobby.bye': 'Tschüss',
      'lobby.new': '',
    });
  });

  it('reports a key English dropped, and removes it only when asked', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    writeJson('apps/web/messages/de/lobby.json', { 'lobby.hello': 'Hallo', 'lobby.bye': '', 'lobby.old': 'Alt' });
    expect(status(root).problems.join('\n')).toMatch(/lobby\.old/);
    sync({ root });
    expect(readJson('apps/web/messages/de/lobby.json')['lobby.old']).toBe('Alt');
    sync({ root, prune: true });
    expect(readJson('apps/web/messages/de/lobby.json')['lobby.old']).toBeUndefined();
  });
});

describe('message syntax', () => {
  it('reports a plural a translator got wrong, by key', () => {
    scaffoldRepo();
    addLanguage({ root, code: 'de', name: 'Deutsch', englishName: 'German' });
    writeJson('apps/web/messages/de/lobby.json', {
      'lobby.hello': '{name, plural, one {Hallo}}',
      'lobby.bye': '{count, plural, eins {x} other {y}}',
    });
    const report = status(root).problems.join('\n');
    expect(report).toMatch(/lobby\.hello.*"other"/);
    expect(report).toMatch(/lobby\.bye.*"eins"/);
  });

  it('checks English too — it is what every language falls back to', () => {
    scaffoldRepo();
    writeJson('apps/web/messages/en/lobby.json', { 'lobby.hello': 'Hello {{name}}', 'lobby.bye': 'Goodbye' });
    expect(status(root).problems.join('\n')).toMatch(/app en: "lobby\.hello" cannot read/);
  });

  it('agrees with the runtime about every message in the repo', () => {
    // The tooling keeps its own small parser so translators need nothing
    // built; this holds it to the SDK's, message by message.
    const messages: string[] = [
      'Plain',
      '{a} and {b}',
      '{count, plural, =0 {none} one {# {what}} other {# {what}s}}',
      '{kind, select, voice {Voice} other {Text}}',
      "{name}'ı başlat",
      'Unclosed {name',
    ];
    for (const locale of readAppLocales().locales) {
      for (const table of Object.values(locale.files)) messages.push(...Object.values(table as Record<string, string>));
    }
    for (const plugin of readPlugins().withTables) {
      for (const table of Object.values(plugin.tables)) {
        for (const [key, value] of Object.entries(table as Record<string, string>)) if (!key.startsWith('$')) messages.push(value);
      }
    }
    const disagreements = messages.filter((m) => messageArguments(m).join() !== runtimeArguments(m).join());
    expect(disagreements).toEqual([]);
    expect(messages.length).toBeGreaterThan(1000);
  });

  it('finds nothing wrong with the messages that ship', () => {
    const broken: string[] = [];
    for (const locale of readAppLocales().locales) {
      for (const table of Object.values(locale.files)) {
        for (const [key, value] of Object.entries(table as Record<string, string>)) {
          for (const problem of messageProblems(value)) broken.push(`${locale.code} ${key}: ${problem}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('the real repository', () => {
  it('passes `pnpm i18n:status` — app and plugins together', () => {
    // The same check a translator runs, so the documented workflow can
    // never quietly stop working.
    const report = status();
    expect(report.problems).toEqual([]);
    expect(report.appRows.map((r) => r.code)).toContain('en');
  });
});
