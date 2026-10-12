/**
 * The desktop app speaks the languages the web app ships
 * (apps/web/messages/<code>/): the connect screen and tray read the
 * `desktop.*` strings bundled into dist-shell/locales.js, and the Windows
 * installer offers every language Tauri's NSIS bundler can translate.
 * `pnpm i18n:sync` writes both, so a new language folder needs no code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_AREA,
  NSIS_LANGUAGES,
  desktopLocalesSource,
  nsisLanguagesFor,
  readAppLocales,
} from '../../../../scripts/i18n/lib.mjs';

const root = join(__dirname, '..', '..');
const shellDir = join(root, 'dist-shell');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
  bundle: { windows: { nsis: { languages: string[]; displayLanguageSelector: boolean } } };
};
const { locales } = readAppLocales();
const english = locales.find((l) => l.code === 'en')!.files[DESKTOP_AREA]!;

describe('desktop languages follow apps/web/messages', () => {
  it('bundles every language folder into the connect screen (run pnpm i18n:sync when this fails)', () => {
    expect(readFileSync(join(shellDir, 'locales.js'), 'utf8')).toBe(desktopLocalesSource(locales));
  });

  it("offers each language Tauri's NSIS bundler can translate, English first", () => {
    const names = conf.bundle.windows.nsis.languages;
    expect(names).toEqual(nsisLanguagesFor(locales.map((l) => l.code)));
    expect(names[0]).toBe('English');
    expect(names).toContain('Turkish');
    for (const name of names) expect(Object.values(NSIS_LANGUAGES)).toContain(name);
    // One-click install: NSIS picks the system language itself.
    expect(conf.bundle.windows.nsis.displayLanguageSelector).toBe(false);
  });

  it('maps future languages without code: German, Brazilian Portuguese, Simplified Chinese', () => {
    expect(nsisLanguagesFor(['tr', 'de', 'pt-BR', 'zh-Hans', 'xx'])).toEqual([
      'English',
      'German',
      'PortugueseBR',
      'Turkish',
      'SimpChinese',
    ]);
  });

  it('every string the screen uses exists in English', () => {
    const html = readFileSync(join(shellDir, 'index.html'), 'utf8');
    const shell = readFileSync(join(shellDir, 'shell.js'), 'utf8');
    const used = [
      ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]!),
      ...[...shell.matchAll(/'(desktop\.[a-zA-Z.]+)'/g)].map((m) => m[1]!),
    ];
    expect(used.length).toBeGreaterThan(8);
    for (const key of used) expect(Object.keys(english)).toContain(key);
  });
});

/** Run the real connect-screen script against a tiny fake page. */
function runShell(languages: string[], invoke: (cmd: string, args?: unknown) => Promise<unknown>) {
  const elements = new Map<string, { textContent: string; dataset: Record<string, string>; disabled?: boolean; value?: string }>();
  const html = readFileSync(join(shellDir, 'index.html'), 'utf8');
  const translatable = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => ({
    textContent: 'English text',
    dataset: { i18n: m[1]! },
  }));
  let submit: ((e: { preventDefault(): void }) => Promise<void>) | undefined;
  const byId = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, value: '' });
    const el = elements.get(id)!;
    return Object.assign(el, {
      addEventListener: (_event: string, handler: typeof submit) => {
        submit = handler;
      },
    });
  };
  const documentElement = { lang: 'en', dir: 'ltr' };
  const window: Record<string, unknown> = { __TAURI__: { core: { invoke } }, postMessage: () => {} };
  const context = {
    window,
    navigator: { languages, language: languages[0] },
    document: { documentElement, querySelectorAll: () => translatable, getElementById: byId },
    console: { error: () => {} },
  };
  runInNewContext(readFileSync(join(shellDir, 'locales.js'), 'utf8'), context);
  runInNewContext(readFileSync(join(shellDir, 'shell.js'), 'utf8'), context);
  return { documentElement, translatable, byId, submit: () => submit!({ preventDefault() {} }) };
}

describe('the connect screen', () => {
  it('speaks the system language and gives the tray its labels', async () => {
    const invoke = vi.fn(async () => undefined);
    const page = runShell(['tr-TR', 'en-US'], invoke);
    expect(page.documentElement.lang).toBe('tr');
    const label = page.translatable.find((el) => el.dataset.i18n === 'desktop.connect.label')!;
    expect(label.textContent).toBe('Kurulum adresi');
    expect(invoke).toHaveBeenCalledWith('set_tray_labels', { show: "LobbyForge'u göster", quit: 'Çık' });
  });

  it('falls back to English for a language it does not ship', () => {
    const page = runShell(['ja-JP'], vi.fn(async () => undefined));
    expect(page.documentElement.lang).toBe('en');
    expect(page.translatable.find((el) => el.dataset.i18n === 'desktop.connect.button')!.textContent).toBe('Connect');
  });

  it('turns a refusal code into a sentence in that language', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'connect_instance') throw 'https_required';
      return undefined;
    });
    const page = runShell(['tr'], invoke);
    page.byId('instance-url').value = 'http://chat.example.com';
    await page.submit();
    expect(page.byId('error-msg').textContent).toBe('Adres https:// ile başlamalı.');
    expect(page.byId('connect-btn').textContent).toBe('Bağlan');
  });

  it('shows a generic message for anything else', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'connect_instance') throw new Error('Failed to navigate: boom');
      return undefined;
    });
    const page = runShell(['en'], invoke);
    page.byId('instance-url').value = 'https://chat.example.com';
    await page.submit();
    expect(page.byId('error-msg').textContent).toBe('Could not connect. Check the address and try again.');
  });
});
