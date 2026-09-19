import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * beta-review (S3): the /lobby server component serialized EVERY channel
 * (role-gated names live-confirmed in the HTML) plus the first text
 * channel's messages without authorization. The helper it now uses must
 * mirror the channels/messages APIs.
 */

const dbFns = {
  getUserPermissions: vi.fn(),
  isServerMember: vi.fn(),
  listVisibleChannelsForMember: vi.fn(),
};
vi.mock('@lobbyforge/db', () => dbFns);
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDbClient: true }) }));
const authorizeChannelMessageAccess = vi.fn();
vi.mock('@/lib/message-authorization', () => ({
  authorizeChannelMessageAccess: (...args: unknown[]) => authorizeChannelMessageAccess(...args),
}));

const DB = { __mockDbClient: true } as never;
const SERVER = 'srv-1';
const OWNER = 'owner';
const MEMBER = 'member';

function channel(id: string, type: 'text' | 'voice', position: number) {
  return { id, serverId: SERVER, name: id, type, position, pluginId: null, topic: null, createdAt: new Date() };
}
const ALL = [
  channel('general', 'text', 0),
  channel('staff-only', 'text', 1),
  channel('lounge', 'voice', 2),
  channel('staff-voice', 'voice', 3),
];

beforeEach(() => {
  for (const fn of Object.values(dbFns)) fn.mockReset();
  authorizeChannelMessageAccess.mockReset();
  dbFns.isServerMember.mockResolvedValue(true);
  dbFns.getUserPermissions.mockResolvedValue(['send_messages', 'read_message_history']);
  // Unordered, like the real query — the helper must keep INPUT order.
  dbFns.listVisibleChannelsForMember.mockResolvedValue([ALL[2], ALL[0]]);
});

async function load() {
  return import('../lobby-channel-access');
}

describe('resolveLobbyChannelView', () => {
  it('a plain member only gets channels they can see (text AND voice), in position order', async () => {
    const { resolveLobbyChannelView } = await load();
    const view = await resolveLobbyChannelView(DB, { serverId: SERVER, userId: MEMBER, ownerUserId: OWNER, channels: ALL });
    expect(view.allowed).toBe(true);
    if (!view.allowed) return;
    expect(view.channels.map((c) => c.id)).toEqual(['general', 'lounge']);
    expect(dbFns.listVisibleChannelsForMember).toHaveBeenCalledWith(DB, SERVER, MEMBER);
  });

  it('MANAGE_CHANNELS (or administrator) sees every channel', async () => {
    const { resolveLobbyChannelView } = await load();
    dbFns.getUserPermissions.mockResolvedValue(['manage_channels']);
    const view = await resolveLobbyChannelView(DB, { serverId: SERVER, userId: MEMBER, ownerUserId: OWNER, channels: ALL });
    expect(view.allowed && view.channels).toEqual(ALL);
    expect(dbFns.listVisibleChannelsForMember).not.toHaveBeenCalled();
  });

  it('the owner sees every channel without a membership probe', async () => {
    const { resolveLobbyChannelView } = await load();
    dbFns.getUserPermissions.mockResolvedValue(['administrator']);
    const view = await resolveLobbyChannelView(DB, { serverId: SERVER, userId: OWNER, ownerUserId: OWNER, channels: ALL });
    expect(view.allowed && view.channels).toEqual(ALL);
    expect(dbFns.isServerMember).not.toHaveBeenCalled();
  });

  it('a banned / removed viewer gets nothing', async () => {
    const { resolveLobbyChannelView } = await load();
    dbFns.isServerMember.mockResolvedValue(false);
    const view = await resolveLobbyChannelView(DB, { serverId: SERVER, userId: MEMBER, ownerUserId: OWNER, channels: ALL });
    expect(view).toEqual({ allowed: false });
    expect(dbFns.listVisibleChannelsForMember).not.toHaveBeenCalled();
  });
});

describe('canReadLobbyChannelMessages', () => {
  it('delegates to the canonical READ policy of the messages API', async () => {
    const { canReadLobbyChannelMessages } = await load();
    authorizeChannelMessageAccess.mockResolvedValue({ ok: true, context: {} });
    await expect(canReadLobbyChannelMessages({ userId: MEMBER, serverId: SERVER, channelId: 'general' })).resolves.toBe(true);
    expect(authorizeChannelMessageAccess).toHaveBeenCalledWith({
      userId: MEMBER,
      serverId: SERVER,
      channelId: 'general',
      operation: 'read',
    });
  });

  it('is false when the read check denies (no READ_MESSAGE_HISTORY / hidden channel)', async () => {
    const { canReadLobbyChannelMessages } = await load();
    authorizeChannelMessageAccess.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    await expect(canReadLobbyChannelMessages({ userId: MEMBER, serverId: SERVER, channelId: 'general' })).resolves.toBe(false);
  });
});
