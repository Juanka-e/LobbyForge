import { describe, expect, it } from 'vitest';
import { firstGrapheme, firstGraphemeFallback, initialOf } from '../initial';

/** True when the string contains a UTF-16 surrogate without its partner. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('initialOf', () => {
  it('upper-cases the first letter', () => {
    expect(initialOf('ada')).toBe('A');
    expect(initialOf('  zeynep  ')).toBe('Z');
  });

  it('keeps an emoji whole instead of half a surrogate pair', () => {
    const initial = initialOf('🎮 Gamer');
    expect(initial).toBe('🎮');
    expect(hasLoneSurrogate(initial)).toBe(false);
    // The bug: charAt(0) gave the high surrogate alone.
    expect(hasLoneSurrogate('🎮 Gamer'.charAt(0))).toBe(true);
  });

  it('keeps skin tones, ZWJ sequences and keycaps together', () => {
    expect(initialOf('👍🏽 thumbs')).toBe('👍🏽');
    expect(initialOf('👩‍👩‍👧 family')).toBe('👩‍👩‍👧');
    expect(initialOf('❤️ love')).toBe('❤️');
    expect(initialOf('1️⃣ first')).toBe('1️⃣');
  });

  it('keeps a flag as one character', () => {
    expect(initialOf('🇹🇷 Ece')).toBe('🇹🇷');
    expect(initialOf('🇬🇧')).toBe('🇬🇧');
  });

  it('keeps combining marks with their letter', () => {
    // "e" + COMBINING ACUTE ACCENT (decomposed é).
    expect(initialOf('émile')).toBe('É');
    // Precomposed.
    expect(initialOf('émile')).toBe('É');
  });

  it('cases Turkish dotted and dotless i in the reader’s language', () => {
    expect(initialOf('irem', { locale: 'tr' })).toBe('İ');
    expect(initialOf('irem', { locale: 'en' })).toBe('I');
    expect(initialOf('ılgaz', { locale: 'tr' })).toBe('I');
    expect(initialOf('ılgaz')).toBe('I');
    expect(initialOf('İlker')).toBe('İ');
    expect(initialOf('İlker', { locale: 'tr' })).toBe('İ');
  });

  it('is locale-independent without a locale (server and client agree)', () => {
    expect(initialOf('irem')).toBe('I');
  });

  it('leaves non-letters as they are', () => {
    expect(initialOf('42 crew')).toBe('4');
    expect(initialOf('_hidden')).toBe('_');
    expect(initialOf('世界')).toBe('世');
  });

  it('shows one character when upper-casing would make two', () => {
    expect(initialOf('ßtraße')).toBe('ß');
    expect(initialOf('ﬁve')).toBe('ﬁ');
  });

  it('skips invisible leading characters and falls back for empty names', () => {
    expect(initialOf('​bob')).toBe('B');
    expect(initialOf('')).toBe('?');
    expect(initialOf('   ')).toBe('?');
    expect(initialOf(null)).toBe('?');
    expect(initialOf(undefined, { fallback: 'L' })).toBe('L');
  });

  it('survives an invalid locale tag', () => {
    expect(initialOf('ada', { locale: 'not a locale!' })).toBe('A');
  });
});

describe('firstGraphemeFallback (no Intl.Segmenter)', () => {
  const cases = ['🎮 Gamer', '👍🏽 x', '👩‍👩‍👧 x', '🇹🇷 Ece', 'émile', '❤️ x', '1️⃣ x', 'ada', '世界', '🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scot'];

  it.each(cases)('matches Intl.Segmenter for %s', (text) => {
    expect(firstGraphemeFallback(text)).toBe(firstGrapheme(text));
  });

  it('returns an empty string for an empty input', () => {
    expect(firstGraphemeFallback('')).toBe('');
  });
});
