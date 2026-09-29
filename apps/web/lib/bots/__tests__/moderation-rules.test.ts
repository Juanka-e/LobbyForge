import { describe, expect, it } from 'vitest';
import {
  compileBlockedWords,
  countMentions,
  evaluateContentRules,
  extractLinkHosts,
  findBlockedWord,
  isHostAllowed,
  normalizeForModeration,
  repeatKey,
} from '../moderation-rules';
import { DEFAULT_MODERATION_SETTINGS } from '../settings';

describe('normalizeForModeration', () => {
  it('folds every Turkish I into i and lowercases', () => {
    expect(normalizeForModeration('İSTANBUL')).toBe('istanbul');
    expect(normalizeForModeration('ISTANBUL')).toBe('istanbul');
    expect(normalizeForModeration('ıstanbul')).toBe('istanbul');
    // The classic trap: 'İ'.toLowerCase() is "i" + combining dot.
    expect(normalizeForModeration('İ')).toBe('i');
    expect(normalizeForModeration('İ')).toBe('i');
  });

  it('keeps other Turkish letters distinct', () => {
    expect(normalizeForModeration('ŞEKER Göz Çay Ğ Ü')).toBe('şeker göz çay ğ ü');
  });

  it('drops invisible characters and folds compatibility forms', () => {
    expect(normalizeForModeration('s​p­am')).toBe('spam');
    expect(normalizeForModeration('ｓｐａｍ')).toBe('spam');
  });
});

describe('blocked words', () => {
  const rules = compileBlockedWords(['salak*', 'ass', 'kötü söz', '*spam', '*scam*', 'SİK']);

  it('matches whole words case- and Turkish-insensitively', () => {
    expect(findBlockedWord('what an ASS', rules)).toBe('ass');
    expect(findBlockedWord('sik', rules)).toBe('SİK');
    expect(findBlockedWord('SIK', rules)).toBe('SİK');
    expect(findBlockedWord('sık', rules)).toBe('SİK');
  });

  it('does not match inside other words (Scunthorpe)', () => {
    expect(findBlockedWord('first class assessment', rules)).toBeNull();
  });

  it('catches suffixed Turkish forms with a trailing *', () => {
    expect(findBlockedWord('sen tam bir salaksın', rules)).toBe('salak*');
    expect(findBlockedWord("SALAK'sın", rules)).toBe('salak*');
    expect(findBlockedWord('salata', rules)).toBeNull();
  });

  it('supports leading and double wildcards', () => {
    expect(findBlockedWord('antispam', rules)).toBe('*spam');
    expect(findBlockedWord('spammer', rules)).toBeNull();
    expect(findBlockedWord('bigscammers here', rules)).toBe('*scam*');
  });

  it('matches phrases as consecutive words', () => {
    expect(findBlockedWord('bu KÖTÜ SÖZ değil', rules)).toBe('kötü söz');
    expect(findBlockedWord('kötü bir söz', rules)).toBeNull();
  });

  it('is not fooled by zero-width characters', () => {
    expect(findBlockedWord('a​s​s', rules)).toBe('ass');
  });

  it('ignores empty and wildcard-only entries', () => {
    expect(compileBlockedWords(['', '*', '  ** '])).toEqual([]);
  });

  it('stays fast on a long message with many rules', () => {
    const many = compileBlockedWords(Array.from({ length: 500 }, (_, i) => `word${i}*`));
    const text = 'lorem ipsum dolor sit amet '.repeat(150);
    const started = performance.now();
    expect(findBlockedWord(text, many)).toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('links', () => {
  it('finds scheme, www and bare-domain links', () => {
    expect(extractLinkHosts('see https://Example.com/a?b=c')).toEqual(['example.com']);
    expect(extractLinkHosts('go to www.example.org now')).toEqual(['example.org']);
    expect(extractLinkHosts('join discord.gg/abc')).toEqual(['discord.gg']);
    expect(extractLinkHosts('shop.example.com.tr')).toEqual(['shop.example.com.tr']);
  });

  it('does not treat file names, versions or emails as links', () => {
    expect(extractLinkHosts('open notes.txt and node.js v1.2.3')).toEqual([]);
    expect(extractLinkHosts('mail me at someone@example.com')).toEqual([]);
  });

  it('sees through fullwidth dots', () => {
    expect(extractLinkHosts('example．com')).toEqual(['example.com']);
  });

  it('allows a listed domain and its subdomains only', () => {
    expect(isHostAllowed('example.com', ['example.com'])).toBe(true);
    expect(isHostAllowed('cdn.example.com', ['example.com'])).toBe(true);
    expect(isHostAllowed('badexample.com', ['example.com'])).toBe(false);
    expect(isHostAllowed('example.com.evil.io', ['example.com'])).toBe(false);
    expect(isHostAllowed('', ['example.com'])).toBe(false);
  });

  it('does not backtrack badly on hostile input', () => {
    const started = performance.now();
    extractLinkHosts(`${'a.'.repeat(2000)}x`);
    extractLinkHosts('a'.repeat(4000));
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('mentions', () => {
  it('counts @name, @everyone and @here at word starts', () => {
    expect(countMentions('@ali @veli hi @everyone and @here')).toBe(4);
    expect(countMentions('mail a@b.com')).toBe(0);
    expect(countMentions('@ @ @')).toBe(0);
  });

  it('counts mentions packed together with punctuation, as the lobby pings them', () => {
    expect(countMentions('hi,@alice,@bob,(@carol)')).toBe(3);
  });
});

describe('ways around the word filter', () => {
  const rules = compileBlockedWords(['spam']);

  it('sees through invisible characters beyond the Basic Multilingual Plane', () => {
    expect(findBlockedWord('sp\u{E0100}am', rules)).toBe('spam'); // variation selector supplement
    expect(findBlockedWord('sp\u{E0041}am', rules)).toBe('spam'); // tag character
    expect(findBlockedWord('sp⠀am', rules)).toBe('spam'); // braille blank
  });

  it('ignores combining marks stacked on letters', () => {
    // Strike-through marks never compose into a letter, so they go.
    expect(findBlockedWord('s̶p̶a̶m̶', rules)).toBe('spam');
    // A mark that composes is a real letter (á, like ö or ş) and stays one.
    expect(findBlockedWord('spám', rules)).toBeNull();
  });

  it('folds look-alike letters in a word that mixes scripts', () => {
    expect(findBlockedWord('spаm', rules)).toBe('spam'); // Cyrillic a
    expect(findBlockedWord('ѕpam', rules)).toBe('spam'); // Cyrillic dze
  });

  it('leaves a word written wholly in Cyrillic alone', () => {
    // "сор" (litter) is not the English "cop".
    expect(findBlockedWord('сор', compileBlockedWords(['cop']))).toBeNull();
  });

  it('joins letters spelled out one by one', () => {
    expect(findBlockedWord('s.p.a.m', rules)).toBe('spam');
    expect(findBlockedWord('s p a m please', rules)).toBe('spam');
    // Two letters apart are not a word being hidden.
    expect(findBlockedWord('a b', compileBlockedWords(['ab']))).toBeNull();
  });

  it('keeps Turkish letters distinct', () => {
    expect(findBlockedWord('göt', compileBlockedWords(['got']))).toBeNull();
    expect(findBlockedWord('ş', compileBlockedWords(['s']))).toBeNull();
  });
});

describe('evaluateContentRules', () => {
  const settings = { ...DEFAULT_MODERATION_SETTINGS, maxMentions: 2 };

  it('checks blocked words first, then links, then mentions', () => {
    const words = compileBlockedWords(['bad']);
    expect(evaluateContentRules('bad https://x.com @a @b @c', { ...settings, linkPolicy: 'block' }, words)).toEqual({
      rule: 'blocked_word',
      detail: 'bad',
    });
    expect(evaluateContentRules('https://x.com @a @b @c', { ...settings, linkPolicy: 'block' }, words)).toEqual({
      rule: 'link',
      detail: 'x.com',
    });
    expect(evaluateContentRules('@a @b @c', settings, words)).toEqual({ rule: 'mentions', detail: '3' });
    expect(evaluateContentRules('all good', settings, words)).toBeNull();
  });

  it('applies the allow-list', () => {
    const allowlist = { ...settings, linkPolicy: 'allowlist' as const, allowedDomains: ['youtube.com'] };
    expect(evaluateContentRules('https://www.youtube.com/watch?v=1', allowlist, [])).toBeNull();
    expect(evaluateContentRules('https://evil.example/x', allowlist, [])).toEqual({ rule: 'link', detail: 'evil.example' });
  });

  it('lets links through with the allow policy and ignores mentions at 0', () => {
    expect(evaluateContentRules('https://x.com @a @b @c', { ...settings, maxMentions: 0 }, [])).toBeNull();
  });
});

describe('repeatKey', () => {
  it('treats case, I-folding and whitespace as the same message', () => {
    expect(repeatKey('  BUY   NOW İ ')).toBe(repeatKey('buy now ı'));
  });
});
