/**
 * Bot API v2 §4.1: the gateway verifies bot tokens exactly like the REST
 * API. The web app's implementation is imported here so the two hash
 * functions can never drift apart.
 */
import { describe, expect, it } from 'vitest';
import {
  ABSENT_BOT_HASH,
  hashBotToken,
  parseBotToken,
  readBotAuthorization,
  verifyBotToken,
} from '../bot-token.js';
import * as web from '../../../web/lib/bots/token.js';

const BOT_ID = '0f8a3c2e-1b4d-4e6f-8a9b-0c1d2e3f4a5b';

describe('gateway bot token twin', () => {
  it('hashes exactly like the web app (domain-separated sha256$hex)', () => {
    const { token, hash } = web.generateBotToken(BOT_ID);
    expect(hashBotToken(token)).toBe(hash);
    expect(hashBotToken(token)).toBe(web.hashBotToken(token));
    expect(hash.startsWith('sha256$')).toBe(true);
  });

  it('accepts what the web app mints and parses the embedded bot id', () => {
    const { token, hash } = web.generateBotToken(BOT_ID);
    expect(parseBotToken(token)).toEqual({ botId: BOT_ID });
    expect(parseBotToken(token)).toEqual(web.parseBotToken(token));
    expect(verifyBotToken(token, hash)).toBe(true);
  });

  it('refuses a different token, a missing or foreign hash', () => {
    const a = web.generateBotToken(BOT_ID);
    const b = web.generateBotToken(BOT_ID);
    expect(verifyBotToken(b.token, a.hash)).toBe(false);
    expect(verifyBotToken(a.token, null)).toBe(false);
    expect(verifyBotToken(a.token, 'bcrypt$whatever')).toBe(false);
    expect(verifyBotToken(a.token, 'sha256$abcd')).toBe(false);
    expect(verifyBotToken(a.token, ABSENT_BOT_HASH)).toBe(false);
  });

  it('only reads `Authorization: Bot <token>`', () => {
    expect(readBotAuthorization('Bot lfb_x')).toBe('lfb_x');
    expect(readBotAuthorization('bot   lfb_x ')).toBe('lfb_x');
    expect(readBotAuthorization(['Bot lfb_x'])).toBe('lfb_x');
    expect(readBotAuthorization('Bearer lfb_x')).toBeNull();
    expect(readBotAuthorization('Bot a b')).toBeNull();
    expect(readBotAuthorization(`Bot ${'x'.repeat(300)}`)).toBeNull();
    expect(readBotAuthorization(undefined)).toBeNull();
    for (const header of ['Bot lfb_x', 'Bearer y', 'Bot a b', '']) {
      expect(readBotAuthorization(header)).toBe(web.readBotAuthorization(header));
    }
  });

  it('rejects malformed tokens without a lookup id', () => {
    expect(parseBotToken('lfb_short_x')).toBeNull();
    expect(parseBotToken(`lfb_${'A'.repeat(32)}_${'a'.repeat(43)}`)).toBeNull();
  });
});
