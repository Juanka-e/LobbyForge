import { describe, expect, it } from 'vitest';
import { mentionsEveryone } from '../everyone-mention';

describe('mentionsEveryone', () => {
  it.each([
    '@everyone',
    'hi @everyone',
    'hi @Everyone!',
    '(@everyone)',
    'hi,@everyone',
    '"@everyone"',
    'line one\n@everyone',
    '＠everyone', // full-width at sign
    '@everyone.',
  ])('counts %j', (text) => {
    expect(mentionsEveryone(text)).toBe(true);
  });

  it.each([
    'everyone',
    'hello everybody',
    'ada@everyone.example', // an address, not a mention
    '@everyones',
    '@everyone_team',
    '@everyone1',
    '@here', // not this permission
  ])('does not count %j', (text) => {
    expect(mentionsEveryone(text)).toBe(false);
  });
});
