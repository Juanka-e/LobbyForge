import { describe, expect, it } from 'vitest';
import {
  contentMentions,
  findHandleMentions,
  MAX_MENTIONS,
  mentionPositions,
  readMessageMentions,
  splitMentions,
} from '@/lib/mentions';

describe('findHandleMentions', () => {
  it('finds typed handles, lowercased, without a sentence-ending dot', () => {
    expect(findHandleMentions('hi @Ada_L and @bob.dev.')).toEqual(['ada_l', 'bob.dev']);
  });

  it('skips mass mentions, addresses, one-letter names and repeats', () => {
    expect(findHandleMentions('@everyone @here ada@example.com @a @ada @ADA')).toEqual(['ada']);
  });

  it('stops at the mention cap', () => {
    const text = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => `@user${i}`).join(' ');
    expect(findHandleMentions(text)).toHaveLength(MAX_MENTIONS);
  });
});

describe('mentionPositions / contentMentions', () => {
  it('a name with spaces, case-insensitive, never inside a longer word', () => {
    expect(mentionPositions('hey @ada lovelace!', 'Ada Lovelace')).toEqual([4]);
    expect(contentMentions('hey @Adam', 'Ada')).toBe(false);
    expect(contentMentions('mail x@Ada', 'Ada')).toBe(false);
    expect(contentMentions('(@Ada)', 'Ada')).toBe(true);
  });

  it('an exact match only where lowercasing would move the indices (Turkish İ)', () => {
    expect(mentionPositions('selam @İrem', 'İrem')).toEqual([6]);
    expect(splitMentions('selam @İrem!', [{ userId: 'u', text: 'İrem' }])).toEqual([
      { kind: 'text', text: 'selam ' },
      { kind: 'mention', text: '@İrem', userId: 'u' },
      { kind: 'text', text: '!' },
    ]);
  });
});

describe('readMessageMentions', () => {
  it('keeps well-formed entries only', () => {
    expect(
      readMessageMentions({
        mentions: [{ userId: 'a', text: 'Ada' }, { userId: 3, text: 'x' }, { userId: 'b' }, 'junk', { userId: 'c', text: '' }],
      })
    ).toEqual([{ userId: 'a', text: 'Ada' }]);
    expect(readMessageMentions(null)).toEqual([]);
    expect(readMessageMentions({ mentions: 'x' })).toEqual([]);
  });
});

describe('splitMentions', () => {
  it('cuts text, member mentions and mass mentions in order', () => {
    expect(splitMentions('@Ada meet @Bob, @everyone', [
      { userId: 'a', text: 'Ada' },
      { userId: 'b', text: 'Bob' },
    ])).toEqual([
      { kind: 'mention', text: '@Ada', userId: 'a' },
      { kind: 'text', text: ' meet ' },
      { kind: 'mention', text: '@Bob', userId: 'b' },
      { kind: 'text', text: ', ' },
      { kind: 'mass', text: '@everyone' },
    ]);
  });

  it('the longer label wins where two start together', () => {
    expect(splitMentions('hi @Ada Lovelace', [
      { userId: 'short', text: 'Ada' },
      { userId: 'long', text: 'Ada Lovelace' },
    ])).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', text: '@Ada Lovelace', userId: 'long' },
    ]);
  });

  it('plain text stays one segment; empty text none', () => {
    expect(splitMentions('no mentions', [])).toEqual([{ kind: 'text', text: 'no mentions' }]);
    expect(splitMentions('', [])).toEqual([]);
  });
});
