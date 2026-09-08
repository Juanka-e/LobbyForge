/**
 * LF-SEC-003: pure matching logic for the access-invalidation bus —
 * which live topics fall inside an event's blast radius.
 */
import { describe, expect, it } from 'vitest';
import { topicMatchesInvalidation } from '../access-invalidation.js';

describe('topicMatchesInvalidation', () => {
  it('user-server-access matches the named user\'s server topics', () => {
    const event = {
      kind: 'user-server-access' as const,
      serverId: 'srv-1',
      userId: 'user-9',
      reason: 'kick',
    };
    expect(topicMatchesInvalidation('chat:srv-1:ch-1', event)).toBe(true);
    expect(topicMatchesInvalidation('activity-state:srv-1:s-1', event)).toBe(true);
    expect(topicMatchesInvalidation('presence:srv-1', event)).toBe(true);
    expect(topicMatchesInvalidation('chat:srv-2:ch-1', event)).toBe(false);
    expect(topicMatchesInvalidation('dm:dm-1', event)).toBe(false);
  });

  it('channel-policy matches only the named channel', () => {
    const event = {
      kind: 'channel-policy' as const,
      serverId: 'srv-1',
      channelId: 'ch-7',
      reason: 'permissions_changed',
    };
    expect(topicMatchesInvalidation('chat:srv-1:ch-7', event)).toBe(true);
    expect(topicMatchesInvalidation('chat:srv-1:ch-8', event)).toBe(false);
    expect(topicMatchesInvalidation('chat:srv-2:ch-7', event)).toBe(false);
  });

  it('server-policy revalidates EVERY topic of the server', () => {
    const event = {
      kind: 'server-policy' as const,
      serverId: 'srv-1',
      reason: 'roles_permissions_changed',
    };
    expect(topicMatchesInvalidation('chat:srv-1:ch-1', event)).toBe(true);
    expect(topicMatchesInvalidation('presence:srv-1', event)).toBe(true);
    expect(topicMatchesInvalidation('chat:srv-2:ch-1', event)).toBe(false);
  });

  it('dm-access matches only the named DM channel', () => {
    const event = {
      kind: 'dm-access' as const,
      channelId: 'dm-5',
      reason: 'blocked',
    };
    expect(topicMatchesInvalidation('dm:dm-5', event)).toBe(true);
    expect(topicMatchesInvalidation('dm:dm-6', event)).toBe(false);
    expect(topicMatchesInvalidation('chat:srv-1:dm-5', event)).toBe(false);
  });

  it('unknown topics never match', () => {
    const event = {
      kind: 'server-policy' as const,
      serverId: 'srv-1',
      reason: 'roles_permissions_changed',
    };
    expect(topicMatchesInvalidation('garbage', event)).toBe(false);
    expect(topicMatchesInvalidation('', event)).toBe(false);
  });
});
