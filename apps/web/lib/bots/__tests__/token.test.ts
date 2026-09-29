import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BOT_TOKEN_PATTERN,
  generateBotToken,
  hashBotToken,
  parseBotToken,
  readBotAuthorization,
  redactBotToken,
  verifyBotToken,
} from '../token';

const BOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('bot tokens', () => {
  it('embeds the bot id and a 256-bit secret in a recognisable format', () => {
    const { token, hash } = generateBotToken(BOT_ID);
    expect(token).toMatch(BOT_TOKEN_PATTERN);
    expect(token.startsWith('lfb_0f8fad5bd9cb469fa16570867728950e_')).toBe(true);
    expect(token).toHaveLength(4 + 32 + 1 + 43);
    expect(parseBotToken(token)).toEqual({ botId: BOT_ID });
    expect(hash.startsWith('sha256$')).toBe(true);
    expect(hash).not.toContain(token.split('_')[2]!);
  });

  it('never mints the same token twice', () => {
    const a = generateBotToken(BOT_ID).token;
    const b = generateBotToken(BOT_ID).token;
    expect(a).not.toBe(b);
  });

  it('refuses a bot id that is not a UUID', () => {
    expect(() => generateBotToken('../../etc')).toThrow();
  });

  it('verifies only the exact token', () => {
    const { token, hash } = generateBotToken(BOT_ID);
    expect(verifyBotToken(token, hash)).toBe(true);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyBotToken(tampered, hash)).toBe(false);
    expect(verifyBotToken(token, null)).toBe(false);
    expect(verifyBotToken(token, 'md5$abc')).toBe(false);
    expect(verifyBotToken(token, 'sha256$tooshort')).toBe(false);
    // A rotated token invalidates the old one.
    const rotated = generateBotToken(BOT_ID);
    expect(verifyBotToken(token, rotated.hash)).toBe(false);
  });

  it('hashes with domain separation (not a bare sha256 of the token)', () => {
    const { token } = generateBotToken(BOT_ID);
    const bare = createHash('sha256').update(token).digest('hex');
    expect(hashBotToken(token)).not.toBe(`sha256$${bare}`);
  });

  it('rejects malformed tokens before any lookup', () => {
    expect(parseBotToken('lfb_short_secret')).toBeNull();
    expect(parseBotToken(`lfb_${'g'.repeat(32)}_${'a'.repeat(43)}`)).toBeNull();
    expect(parseBotToken(`xfb_${'a'.repeat(32)}_${'a'.repeat(43)}`)).toBeNull();
  });

  it('reads only the Bot authorization scheme', () => {
    const { token } = generateBotToken(BOT_ID);
    expect(readBotAuthorization(`Bot ${token}`)).toBe(token);
    expect(readBotAuthorization(`bot ${token}`)).toBe(token);
    expect(readBotAuthorization(`Bearer ${token}`)).toBeNull();
    expect(readBotAuthorization(token)).toBeNull();
    expect(readBotAuthorization(`Bot ${token} extra`)).toBeNull();
    expect(readBotAuthorization(null)).toBeNull();
    expect(readBotAuthorization(`Bot ${'x'.repeat(300)}`)).toBeNull();
  });

  it('redacts a token for display', () => {
    const { token } = generateBotToken(BOT_ID);
    expect(redactBotToken(token)).toBe('lfb_0f8fad5b…');
    expect(redactBotToken('garbage')).toBe('lfb_…');
  });
});
