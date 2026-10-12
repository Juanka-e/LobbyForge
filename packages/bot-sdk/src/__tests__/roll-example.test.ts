/**
 * The /roll examples answer each member in their own language: the
 * interaction's `locale` picks English or Turkish (closest match, English
 * for anything else), in plain words — no dice notation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { messageArguments } from '../message-format.js';

interface RollText {
  ROLL_STRINGS: Record<string, Record<string, string>>;
  DEFAULT_LOCALE: string;
  rollLocale(locale: string | null | undefined): string;
  rollAnswer(locale: string | null | undefined, input: { name: string | null; result: number; sides: number }): string;
}

// A plain .mjs example (no types): loaded by a non-literal path.
const EXAMPLE = '../../examples/roll-text.mjs';
const load = () => import(/* @vite-ignore */ EXAMPLE) as Promise<RollText>;

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('roll example — languages', () => {
  it('answers in the invoker’s language, in plain words', async () => {
    const { rollAnswer } = await load();
    expect(rollAnswer('en', { name: 'Ayşe', result: 18, sides: 20 })).toBe('Ayşe rolled 18 (20-sided)');
    expect(rollAnswer('tr', { name: 'Ayşe', result: 18, sides: 20 })).toBe('Ayşe 18 attı (20 yüzlü)');
  });

  it('picks the closest language it ships; English for anything else or nothing', async () => {
    const { rollLocale, DEFAULT_LOCALE } = await load();
    expect(DEFAULT_LOCALE).toBe('en');
    expect(rollLocale('tr')).toBe('tr');
    expect(rollLocale('tr-TR')).toBe('tr');
    expect(rollLocale('pt-BR')).toBe('en');
    expect(rollLocale(undefined)).toBe('en');
    expect(rollLocale('')).toBe('en');
  });

  it('names an unnamed member in the same language', async () => {
    const { rollAnswer } = await load();
    expect(rollAnswer('tr', { name: null, result: 3, sides: 6 })).toBe('Biri 3 attı (6 yüzlü)');
    expect(rollAnswer('de', { name: '', result: 3, sides: 6 })).toBe('Someone rolled 3 (6-sided)');
  });

  it('every language has every string, with the same placeholders', async () => {
    const { ROLL_STRINGS } = await load();
    const en = ROLL_STRINGS.en!;
    for (const [code, table] of Object.entries(ROLL_STRINGS)) {
      expect(Object.keys(table).sort(), code).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en)) {
        expect(messageArguments(table[key]!), `${code} ${key}`).toEqual(messageArguments(en[key]!));
      }
    }
  });

  it('both example bots answer interactions through it with interaction.locale', () => {
    for (const file of ['../../examples/roll-bot.mjs', '../../examples/http-bot.mjs']) {
      const source = read(file);
      expect(source, file).toContain("from './roll-text.mjs'");
      expect(source, file).toMatch(/rollAnswer\(interaction\.locale,/);
      // Plain words only: no "d20"-style notation left in an answer.
      expect(source, file).not.toMatch(/\(d\$\{/);
    }
  });
});
