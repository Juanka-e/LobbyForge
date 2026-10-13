import { describe, expect, it } from 'vitest';
import { mentionsEveryoneOrHere } from '../everyone-mention';
import { containsMassMention } from '../bots/settings';

describe('mentionsEveryoneOrHere — the Mention Everyone gate', () => {
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
    // @here pings everyone online: the same permission, as in Discord.
    '@here',
    'look @here',
    'LOOK @HERE!',
    '(@here)',
    'ok,@here',
    '＠here',
    'line one\n@here.',
  ])('counts %j', (text) => {
    expect(mentionsEveryoneOrHere(text)).toBe(true);
  });

  it.each([
    'everyone',
    'hello everybody',
    'ada@everyone.example', // an address, not a mention
    '@everyones',
    '@everyone_team',
    '@everyone1',
    'here',
    'ops@here.dev', // an address
    '@heres',
    '@here_and_now',
    '@hereby',
  ])('does not count %j', (text) => {
    expect(mentionsEveryoneOrHere(text)).toBe(false);
  });

  it('is the bots’ mass-mention rule too', () => {
    for (const text of ['@everyone', 'hi,@here', 'ada@everyone.example', 'nothing']) {
      expect(containsMassMention(text)).toBe(mentionsEveryoneOrHere(text));
    }
  });
});
