import { describe, expect, it } from 'vitest';
import { formatMessage, messageArguments } from '../message-format.js';

const members = '{count, plural, one {# member} other {# members}}';
// Russian needs four forms; the point of the format is that it can have them.
const russian = '{count, plural, one {# участник} few {# участника} many {# участников} other {# участника}}';

describe('formatMessage', () => {
  it('fills plain arguments and leaves a missing one visible', () => {
    expect(formatMessage('Hello {name}', { name: 'Ada' }, 'en')).toBe('Hello Ada');
    expect(formatMessage('Hello {name}', {}, 'en')).toBe('Hello {name}');
    expect(formatMessage('No arguments', undefined, 'en')).toBe('No arguments');
  });

  it('picks the plural form by the language’s own rules', () => {
    expect(formatMessage(members, { count: 1 }, 'en')).toBe('1 member');
    expect(formatMessage(members, { count: 5 }, 'en')).toBe('5 members');
    expect(formatMessage(russian, { count: 1 }, 'ru')).toBe('1 участник');
    expect(formatMessage(russian, { count: 3 }, 'ru')).toBe('3 участника');
    expect(formatMessage(russian, { count: 5 }, 'ru')).toBe('5 участников');
    expect(formatMessage(russian, { count: 21 }, 'ru')).toBe('21 участник');
  });

  it('prefers an exact =N case, then falls back to other', () => {
    const players = '{count, plural, =0 {No players} one {# player} other {# players}}';
    expect(formatMessage(players, { count: 0 }, 'en')).toBe('No players');
    // A language may write only `other` when its forms are all alike (Turkish: "1 oyuncu", "5 oyuncu").
    expect(formatMessage('{count, plural, one {# kişi} other {# kişi}}', { count: 1 }, 'tr')).toBe('1 kişi');
    expect(formatMessage('{count, plural, other {# oyuncu}}', { count: 1 }, 'tr')).toBe('1 oyuncu');
  });

  it('writes # the way the language writes numbers', () => {
    expect(formatMessage(members, { count: 12345 }, 'en')).toBe('12,345 members');
    expect(formatMessage('{count, plural, other {# üye}}', { count: 12345 }, 'tr')).toBe('12.345 üye');
  });

  it('supports other arguments inside a case, and select', () => {
    expect(formatMessage('{count, plural, one {{name} joined} other {{name} and # others joined}}', { count: 3, name: 'Ada' }, 'en')).toBe(
      'Ada and 3 others joined'
    );
    const kind = '{kind, select, voice {Voice channel} other {Text channel}}';
    expect(formatMessage(kind, { kind: 'voice' }, 'en')).toBe('Voice channel');
    expect(formatMessage(kind, { kind: 'forum' }, 'en')).toBe('Text channel');
  });

  it('keeps apostrophes literal — Turkish suffixes are not ICU quotes', () => {
    expect(formatMessage("{name}'ı başlat", { name: 'Hushle' }, 'tr')).toBe("Hushle'ı başlat");
    expect(formatMessage("{count, plural, other {# token'ı sil}}", { count: 2 }, 'tr')).toBe("2 token'ı sil");
  });

  it('never blanks a malformed message — it stays readable', () => {
    expect(formatMessage('{count, plural, one # member}', { count: 1 }, 'en')).toBe('{count, plural, one # member}');
    expect(formatMessage('Unclosed {name', { name: 'x' }, 'en')).toBe('Unclosed {name');
    expect(formatMessage('{count, plural, one {# member}}', { count: 4 }, 'en')).toBe('{count, plural, one {# member}}');
    expect(formatMessage('{name}', { name: 'x' }, 'not a locale!')).toBe('x');
    expect(formatMessage(members, { count: 2 }, 'not a locale!')).toBe('2 members');
  });
});

describe('messageArguments', () => {
  it('lists every argument once, including inside cases', () => {
    expect(messageArguments('Hello {name}, {name}')).toEqual(['name']);
    expect(messageArguments('{count, plural, one {{name} joined} other {# joined}} in {room}')).toEqual(['count', 'name', 'room']);
    expect(messageArguments('No arguments')).toEqual([]);
  });

  it('treats "{count} members" and a plural over count as the same arguments', () => {
    // So a translator can add plural forms English does not need.
    expect(messageArguments('{count} members')).toEqual(messageArguments(russian));
  });
});
