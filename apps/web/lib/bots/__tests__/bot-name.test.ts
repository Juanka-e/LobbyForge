import { describe, expect, it } from 'vitest';
import { BotNameSchema } from '../admin';

// Invisible and direction-changing characters, built from code points so
// this file stays plain text.
const cp = (n: number) => String.fromCodePoint(n);

describe('BotNameSchema', () => {
  it('accepts ordinary names, collapsing whitespace', () => {
    expect(BotNameSchema.parse('  Dice   Bot ')).toBe('Dice Bot');
    expect(BotNameSchema.parse('Zar Botu 🎲')).toBe('Zar Botu 🎲');
  });

  it.each([
    ['NUL', 0x00],
    ['DEL', 0x7f],
    ['RLO (bidi override)', 0x202e],
    ['LRI (bidi isolate)', 0x2066],
    ['RLI', 0x2067],
    ['FSI', 0x2068],
    ['PDI', 0x2069],
    ['Arabic letter mark', 0x061c],
    ['Mongolian vowel separator', 0x180e],
    ['zero-width space', 0x200b],
    ['zero-width joiner', 0x200d],
    ['soft hyphen', 0x00ad],
  ])('refuses a name containing %s', (_label, code) => {
    expect(BotNameSchema.safeParse(`Mod${cp(code)}Bot`).success).toBe(false);
  });

  it('turns line/paragraph separators (JS whitespace) into a plain space', () => {
    expect(BotNameSchema.parse(`Mod${cp(0x2028)}Bot`)).toBe('Mod Bot');
    expect(BotNameSchema.parse(`Mod${cp(0x2029)}Bot`)).toBe('Mod Bot');
  });
});
