/**
 * docs/PROFILES.md "Live updates": the `members:{serverId}` topic — parsed
 * like presence, authorised by membership alone, and forwarded only in the
 * three content-free shapes `sanitizeMemberEvent` lets through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  getChannelById: vi.fn(),
  getGameSessionById: vi.fn(),
  checkDmChannelAccess: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => mocks);

import { parseTopic, redisTopicName } from '../protocol.js';
import { authorizeTopicSubscribe } from '../authorize.js';
import { topicMatchesInvalidation } from '../access-invalidation.js';
import { MEMBER_EVENT_MAX_IDS, sanitizeMemberEvent } from '../member-events.js';

const SERVER_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: OTHER_ID });
});

describe('members topic', () => {
  it('parses as a two-part server topic and maps to its own Redis channel', () => {
    const parsed = parseTopic(`members:${SERVER_ID}`);
    expect(parsed).toEqual({ kind: 'members', serverId: SERVER_ID, resourceId: SERVER_ID });
    expect(redisTopicName('production', parsed!)).toBe(`lf:production:members:${SERVER_ID}`);
    expect(parseTopic(`members:${SERVER_ID}:extra`)).toBeNull();
    expect(parseTopic('members:')).toBeNull();
  });

  it('a member may subscribe; a non-member may not; no channel or permission lookups', async () => {
    mocks.isServerMember.mockResolvedValue(true);
    expect(await authorizeTopicSubscribe({}, USER_ID, `members:${SERVER_ID}`)).toMatchObject({ ok: true, kind: 'members' });
    mocks.isServerMember.mockResolvedValue(false);
    expect(await authorizeTopicSubscribe({}, USER_ID, `members:${SERVER_ID}`)).toEqual({ ok: false, reason: 'forbidden' });
    expect(mocks.getUserPermissions).not.toHaveBeenCalled();
    expect(mocks.canMemberAccessChannel).not.toHaveBeenCalled();
  });

  it('the owner passes without a membership row; a made-up id is an unknown topic', async () => {
    mocks.getServerById.mockResolvedValue({ id: SERVER_ID, ownerUserId: USER_ID });
    expect((await authorizeTopicSubscribe({}, USER_ID, `members:${SERVER_ID}`)).ok).toBe(true);
    expect(await authorizeTopicSubscribe({}, USER_ID, 'members:not-a-uuid')).toEqual({ ok: false, reason: 'unknown_topic' });
  });

  it('a kick, ban or role change in that server re-checks the subscription', () => {
    const topic = `members:${SERVER_ID}`;
    expect(topicMatchesInvalidation(topic, { kind: 'user-server-access', serverId: SERVER_ID, userId: USER_ID, reason: 'kick' } as never)).toBe(true);
    expect(topicMatchesInvalidation(topic, { kind: 'server-policy', serverId: SERVER_ID } as never)).toBe(true);
    expect(topicMatchesInvalidation(topic, { kind: 'server-policy', serverId: OTHER_ID } as never)).toBe(false);
  });
});

describe('sanitizeMemberEvent', () => {
  it('passes the three shapes and nothing else of the payload', () => {
    expect(sanitizeMemberEvent({ type: 'members-changed', userIds: [USER_ID], displayName: 'leak', bio: 'leak' })).toEqual({
      type: 'members-changed',
      userIds: [USER_ID],
    });
    expect(sanitizeMemberEvent({ type: 'members-removed', userIds: [USER_ID, USER_ID] })).toEqual({
      type: 'members-removed',
      userIds: [USER_ID],
    });
    expect(sanitizeMemberEvent({ type: 'roles-changed', roles: [{ name: 'x' }] })).toEqual({ type: 'roles-changed' });
  });

  it('drops unknown types, missing or malformed id lists and oversized ones', () => {
    expect(sanitizeMemberEvent(null)).toBeNull();
    expect(sanitizeMemberEvent('members-changed')).toBeNull();
    expect(sanitizeMemberEvent({ type: 'presence-update' })).toBeNull();
    expect(sanitizeMemberEvent({ type: 'members-changed' })).toBeNull();
    expect(sanitizeMemberEvent({ type: 'members-changed', userIds: [] })).toBeNull();
    expect(sanitizeMemberEvent({ type: 'members-changed', userIds: ['../etc'] })).toBeNull();
    expect(sanitizeMemberEvent({ type: 'members-changed', userIds: [USER_ID, 7] })).toBeNull();
    const many = Array.from({ length: MEMBER_EVENT_MAX_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(sanitizeMemberEvent({ type: 'members-changed', userIds: many })).toBeNull();
  });
});
