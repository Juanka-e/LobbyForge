/**
 * Bot API v2 protocol pieces outside the bot socket itself:
 *   - the `user:{uid}` browser topic (§4.3): parsed, mapped to
 *     `lf:{env}:user-events:{uid}`, authorised ONLY for that uid, and
 *     outside every browser invalidation blast radius;
 *   - `bot-access` invalidations never touch browser topics;
 *   - the bot client-message schema.
 */
import { describe, expect, it } from 'vitest';
import {
  BOT_EVENT_NAMES,
  BOT_EVENT_PERMISSIONS,
  BOT_FATAL_CLOSE_CODES,
  BotClientMessageSchema,
  BotCloseCode,
  botEventsChannel,
  parseTopic,
  redisTopicName,
} from '../protocol.js';
import { authorizeTopicSubscribe } from '../authorize.js';
import { topicMatchesInvalidation } from '../access-invalidation.js';
import { isBotGatewayPath } from '../bot-gateway.js';

const UID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

describe('user:{uid} topic', () => {
  it('parses and maps to the user-events Redis channel', () => {
    const parsed = parseTopic(`user:${UID}`);
    expect(parsed).toEqual({ kind: 'user', serverId: UID, resourceId: UID });
    expect(redisTopicName('test', parsed!)).toBe(`lf:test:user-events:${UID}`);
    expect(parseTopic('user:')).toBeNull();
    expect(parseTopic(`user:${UID}:extra`)).toBeNull();
  });

  it('is authorised only for the session with that uid (no database read)', async () => {
    const db = new Proxy({}, {
      get() {
        throw new Error('the user topic must not touch the database');
      },
    });
    await expect(authorizeTopicSubscribe(db, UID, `user:${UID}`)).resolves.toEqual({
      ok: true,
      kind: 'user',
      serverId: UID,
      resourceId: UID,
    });
    await expect(authorizeTopicSubscribe(db, OTHER, `user:${UID}`)).resolves.toEqual({
      ok: false,
      reason: 'forbidden',
    });
    await expect(authorizeTopicSubscribe(db, 'not-a-uuid', 'user:not-a-uuid')).resolves.toEqual({
      ok: false,
      reason: 'unknown_topic',
    });
  });

  it('no server/channel/DM invalidation can revoke it', () => {
    for (const event of [
      { kind: 'user-server-access' as const, serverId: UID, userId: UID, reason: 'kick' },
      { kind: 'server-policy' as const, serverId: UID, reason: 'roles_permissions_changed' },
      { kind: 'channel-policy' as const, serverId: UID, channelId: UID, reason: 'permissions_changed' },
      { kind: 'dm-access' as const, channelId: UID, reason: 'blocked' },
    ]) {
      expect(topicMatchesInvalidation(`user:${UID}`, event)).toBe(false);
    }
  });
});

describe('bot-access invalidation', () => {
  it('never matches browser topics (bot feeds are recomputed by the bot gateway)', () => {
    const event = { kind: 'bot-access' as const, botId: 'bot-1', serverId: 'srv-1' };
    expect(topicMatchesInvalidation('chat:srv-1:ch-1', event)).toBe(false);
    expect(topicMatchesInvalidation('presence:srv-1', event)).toBe(false);
  });
});

describe('bot protocol', () => {
  it('accepts identify and ping, nothing else', () => {
    expect(BotClientMessageSchema.safeParse({ type: 'identify', token: 'lfb_x' }).success).toBe(true);
    expect(BotClientMessageSchema.safeParse({ type: 'ping' }).success).toBe(true);
    expect(BotClientMessageSchema.safeParse({ type: 'identify' }).success).toBe(false);
    expect(BotClientMessageSchema.safeParse({ type: 'identify', token: 'x'.repeat(257) }).success).toBe(false);
    expect(BotClientMessageSchema.safeParse({ type: 'subscribe', topic: 'chat:a:b' }).success).toBe(false);
  });

  it('names the bot-events channel and the bot path', () => {
    expect(botEventsChannel('production', 'b1')).toBe('lf:production:bot-events:b1');
    expect(isBotGatewayPath('/ws/bot')).toBe(true);
    expect(isBotGatewayPath('/ws/bot?v=2')).toBe(true);
    expect(isBotGatewayPath('/ws')).toBe(false);
    expect(isBotGatewayPath('/ws/botx')).toBe(false);
    expect(isBotGatewayPath('/')).toBe(false);
  });

  it('has a permission rule for every event and documented close codes', () => {
    expect(Object.keys(BOT_EVENT_PERMISSIONS).sort()).toEqual([...BOT_EVENT_NAMES].sort());
    expect(BOT_EVENT_PERMISSIONS.message_create).toBe('read_messages');
    expect(BOT_EVENT_PERMISSIONS.member_join).toBe('read_members');
    expect(BOT_EVENT_PERMISSIONS.interaction_create).toBe('slash_commands');
    expect(BOT_FATAL_CLOSE_CODES).toEqual([BotCloseCode.UNAUTHORIZED, BotCloseCode.FORBIDDEN, BotCloseCode.REPLACED]);
  });
});
