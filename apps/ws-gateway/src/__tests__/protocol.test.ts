/**
 * Tests for the wire protocol parser.
 *
 * The gateway's only correctness-sensitive input parsing lives here.
 * subscribe/unsubscribe payloads are validated against the zod schema,
 * and topic strings are normalized to a `(kind, serverId, resourceId)`
 * tuple. Unknown topic shapes are rejected — the server replies with
 * `code: 'unknown_topic'`.
 */
import { describe, it, expect } from 'vitest';
import {
  ClientMessageSchema,
  parseTopic,
  redisTopicName,
} from '../protocol.js';

describe('parseTopic', () => {
  it('parses activity-state topics', () => {
    const parsed = parseTopic('activity-state:srv-1:00000000-0000-0000-0000-000000000aaa');
    expect(parsed).toEqual({
      kind: 'activity-state',
      serverId: 'srv-1',
      resourceId: '00000000-0000-0000-0000-000000000aaa',
    });
  });

  it('parses chat topics', () => {
    const parsed = parseTopic('chat:srv-2:00000000-0000-0000-0000-000000000bbb');
    expect(parsed).toEqual({
      kind: 'chat',
      serverId: 'srv-2',
      resourceId: '00000000-0000-0000-0000-000000000bbb',
    });
  });

  it('rejects unknown kinds', () => {
    expect(parseTopic('bogus:srv:x')).toBeNull();
  });

  it('rejects malformed topics', () => {
    expect(parseTopic('activity-state:srv-1')).toBeNull();
    expect(parseTopic('activity-state::id')).toBeNull();
    expect(parseTopic('')).toBeNull();
  });
});

describe('redisTopicName', () => {
  it('builds the wire-format topic name', () => {
    const parsed = parseTopic('activity-state:srv-1:abc')!;
    expect(redisTopicName('dev', parsed)).toBe('lf:dev:activity-state:srv-1:abc');
  });

  it('honors the env prefix', () => {
    const parsed = parseTopic('chat:srv-1:abc')!;
    expect(redisTopicName('prod', parsed)).toBe('lf:prod:chat:srv-1:abc');
  });
});

describe('ClientMessageSchema', () => {
  it('accepts a subscribe message', () => {
    const parsed = ClientMessageSchema.parse({
      type: 'subscribe',
      topic: 'activity-state:srv-1:abc',
    });
    expect(parsed.type).toBe('subscribe');
  });

  it('accepts an unsubscribe message', () => {
    const parsed = ClientMessageSchema.parse({
      type: 'unsubscribe',
      topic: 'chat:srv-1:abc',
    });
    expect(parsed.type).toBe('unsubscribe');
  });

  it('rejects unknown types', () => {
    const result = ClientMessageSchema.safeParse({ type: 'garbage', topic: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects empty topic strings', () => {
    const result = ClientMessageSchema.safeParse({ type: 'subscribe', topic: '' });
    expect(result.success).toBe(false);
  });

  it('rejects topics longer than 512 chars', () => {
    const topic = 'a'.repeat(513);
    const result = ClientMessageSchema.safeParse({ type: 'subscribe', topic });
    expect(result.success).toBe(false);
  });
});