/**
 * Tests for per-topic authorization.
 *
 * The gateway calls `authorizeTopicSubscribe(...)` on every `subscribe`
 * message. The rule is the same one the SSE route enforces on its
 * snapshot fetch: server owner always passes; everyone else must be
 * a member of the server whose id appears in the topic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerById: vi.fn(),
  isServerMember: vi.fn(),
  getGameSessionById: vi.fn(),
  getUserPermissions: vi.fn(),
  canMemberAccessChannel: vi.fn(),
  isDmChannelParticipant: vi.fn(),
}));

vi.mock('@lobbyforge/db', () => ({
  getServerById: mocks.getServerById,
  isServerMember: mocks.isServerMember,
  getGameSessionById: mocks.getGameSessionById,
  getUserPermissions: mocks.getUserPermissions,
  canMemberAccessChannel: mocks.canMemberAccessChannel,
  isDmChannelParticipant: mocks.isDmChannelParticipant,
}));

import { authorizeTopicSubscribe } from '../authorize.js';

const SERVER_ID = 'srv-1';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_ID = '00000000-0000-0000-0000-000000000099';

const fakeDb = { __mockDb: true };

function mockServer(overrides: Partial<{ ownerUserId: string; deletedAt: Date | null }> = {}) {
  return {
    id: SERVER_ID,
    name: 'A',
    slug: null,
    ownerUserId: overrides.ownerUserId ?? OWNER_ID,
    iconUrl: null,
    defaultLocale: 'en',
    isPublic: false,
    createdAt: new Date('2026-06-20T00:00:00Z'),
    deletedAt: overrides.deletedAt ?? null,
  };
}

beforeEach(() => {
  mocks.getServerById.mockReset();
  mocks.isServerMember.mockReset();
  mocks.getGameSessionById.mockReset();
  mocks.getUserPermissions.mockReset().mockResolvedValue([]);
  mocks.canMemberAccessChannel.mockReset().mockResolvedValue(true);
  mocks.isDmChannelParticipant.mockReset();
});

describe('authorizeTopicSubscribe', () => {
  it('accepts a topic whose server the user owns', async () => {
    mocks.getServerById.mockResolvedValue(mockServer({ ownerUserId: USER_ID }));
    // SEC-002: even for the OWNER, an activity-state topic resolves the
    // session (to find its channel) — mock a consistent one.
    mocks.getGameSessionById.mockResolvedValue({
      id: 'abc', serverId: SERVER_ID, channelId: 'ch-1', pluginId: 'hushle',
    });
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `activity-state:${SERVER_ID}:abc`);
    expect(result.ok).toBe(true);
    expect(mocks.isServerMember).not.toHaveBeenCalled();
  });

  it('accepts a topic whose server the user is a member of', async () => {
    mocks.getServerById.mockResolvedValue(mockServer());
    mocks.isServerMember.mockResolvedValue(true);
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `chat:${SERVER_ID}:xyz`);
    expect(result.ok).toBe(true);
    expect(mocks.isServerMember).toHaveBeenCalledWith(fakeDb, USER_ID, SERVER_ID);
  });

  it('rejects when the user is neither owner nor member', async () => {
    mocks.getServerById.mockResolvedValue(mockServer());
    mocks.isServerMember.mockResolvedValue(false);
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `chat:${SERVER_ID}:xyz`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('forbidden');
  });

  it('rejects when the server does not exist', async () => {
    mocks.getServerById.mockResolvedValue(null);
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `chat:${SERVER_ID}:xyz`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('server_not_found');
  });

  it('rejects unknown topic shapes', async () => {
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, 'bogus:srv:abc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_topic');
  });
});

describe('authorizeTopicSubscribe — SEC-002 channel visibility', () => {
  const CHANNEL_ID = 'ch-1';
  const SESSION_ID = 'sess-1';

  it('rejects a chat topic for a channel the member cannot SEE (private room)', async () => {
    mocks.getServerById.mockResolvedValue(mockServer());
    mocks.isServerMember.mockResolvedValue(true);
    mocks.getUserPermissions.mockResolvedValue([]);            // no manage bypass
    mocks.canMemberAccessChannel.mockResolvedValue(false);    // gated channel
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `chat:${SERVER_ID}:${CHANNEL_ID}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('forbidden');
  });

  it('rejects an activity-state topic when the session lives in a private channel', async () => {
    mocks.getServerById.mockResolvedValue(mockServer());
    mocks.isServerMember.mockResolvedValue(true);
    mocks.getGameSessionById.mockResolvedValue({
      id: SESSION_ID, serverId: SERVER_ID, channelId: CHANNEL_ID, pluginId: 'hushle',
    });
    mocks.getUserPermissions.mockResolvedValue([]);
    mocks.canMemberAccessChannel.mockResolvedValue(false);
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `activity-state:${SERVER_ID}:${SESSION_ID}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('forbidden');
    expect(mocks.canMemberAccessChannel).toHaveBeenCalledWith(fakeDb, SERVER_ID, CHANNEL_ID, USER_ID);
  });

  it('rejects an activity-state topic whose session belongs to another server', async () => {
    mocks.getServerById.mockResolvedValue(mockServer());
    mocks.isServerMember.mockResolvedValue(true);
    mocks.getGameSessionById.mockResolvedValue({ id: SESSION_ID, serverId: 'OTHER', channelId: CHANNEL_ID });
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `activity-state:${SERVER_ID}:${SESSION_ID}`);
    expect(result.ok).toBe(false);
  });

  it('manage_channels bypasses the channel gate', async () => {
    mocks.getServerById.mockResolvedValue(mockServer());
    mocks.isServerMember.mockResolvedValue(true);
    mocks.getUserPermissions.mockResolvedValue(['manage_channels']);
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `chat:${SERVER_ID}:${CHANNEL_ID}`);
    expect(result.ok).toBe(true);
    expect(mocks.canMemberAccessChannel).not.toHaveBeenCalled();
  });

  it('presence topics stay membership-only (no channel scope)', async () => {
    mocks.getServerById.mockResolvedValue(mockServer());
    mocks.isServerMember.mockResolvedValue(true);
    const result = await authorizeTopicSubscribe(fakeDb, USER_ID, `presence:${SERVER_ID}`);
    expect(result.ok).toBe(true);
    expect(mocks.canMemberAccessChannel).not.toHaveBeenCalled();
  });
});
