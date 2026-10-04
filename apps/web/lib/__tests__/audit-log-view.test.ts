/**
 * The audit page's rows: actor and user-target names in ONE batch lookup
 * (names only — never the avatar data URLs), and channel names only for
 * channels this viewer may see. The visibility rule is the real
 * lib/lobby-channel-access.ts over a mocked database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  listAuditLogsForServer: vi.fn(),
  listChannelsForServer: vi.fn(),
  listUserDisplayNames: vi.fn(),
  isServerMember: vi.fn(),
  getUserPermissions: vi.fn(),
  listVisibleChannelsForMember: vi.fn(),
  getUserById: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => db);
vi.mock('@/lib/message-authorization', () => ({ authorizeChannelMessageAccess: vi.fn() }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ __mockDb: true }) }));

import { loadAuditEntries } from '@/lib/audit-log-view';

const SERVER_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const OWNER = '0a1b2c3d-0000-4000-8000-0000000000ff';
const VIEWER = '0a1b2c3d-0000-4000-8000-000000000030';
const MOD = '0a1b2c3d-0000-4000-8000-000000000031';
const MALLORY = '0a1b2c3d-0000-4000-8000-0000000000aa';
const LOUNGE = '0a1b2c3d-0000-4000-8000-000000000002';
const SECRET_ROOM = '0a1b2c3d-0000-4000-8000-000000000003';

const channel = (id: string, name: string) => ({ id, serverId: SERVER_ID, name, type: 'voice', position: 0 });

function row(overrides: Record<string, unknown>) {
  return {
    id: `row-${Math.random()}`,
    serverId: SERVER_ID,
    actorUserId: null,
    action: 'voice.track_rejected',
    targetType: 'user',
    targetId: MALLORY,
    metadata: {},
    createdAt: new Date('2026-10-04T10:00:00Z'),
    ...overrides,
  };
}

const fakeDb = { __mockDb: true } as never;

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.listUserDisplayNames.mockResolvedValue(new Map([[MALLORY, 'Mallory'], [MOD, 'Ayşe']]));
  db.listChannelsForServer.mockResolvedValue([channel(LOUNGE, 'Main Lounge'), channel(SECRET_ROOM, 'Staff Room')]);
  db.isServerMember.mockResolvedValue(true);
  db.getUserPermissions.mockResolvedValue(['mute_members']);
  db.listVisibleChannelsForMember.mockResolvedValue([channel(LOUNGE, 'Main Lounge')]);
});

describe('loadAuditEntries', () => {
  it('resolves actor and user-target names in one batch, and never loads users one by one', async () => {
    db.listAuditLogsForServer.mockResolvedValue([
      row({ action: 'voice.disconnect', actorUserId: MOD, metadata: { channelId: LOUNGE } }),
      row({ metadata: { channelId: LOUNGE, source: 'camera', type: 'audio', blockedSeconds: 600 } }),
    ]);
    const entries = await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: VIEWER });
    expect(db.listUserDisplayNames).toHaveBeenCalledTimes(1);
    expect([...db.listUserDisplayNames.mock.calls[0]![1]].sort()).toEqual([MALLORY, MOD].sort());
    // security-review FILE-001: a full user row carries avatar / banner data URLs.
    expect(db.getUserById).not.toHaveBeenCalled();
    expect(entries.map((e) => [e.action, e.actorName, e.targetName])).toEqual([
      ['voice.disconnect', 'Ayşe', 'Mallory'],
      ['voice.track_rejected', null, 'Mallory'],
    ]);
    expect(entries[1]).toMatchObject({ targetId: MALLORY, targetType: 'user', createdAt: '2026-10-04T10:00:00.000Z' });
  });

  it('only looks up user targets with a uuid id (no bot identities, no channel or role ids)', async () => {
    db.listAuditLogsForServer.mockResolvedValue([
      row({ targetId: 'bot:music' }),
      row({ action: 'role.update', targetType: 'role', targetId: LOUNGE }),
    ]);
    const entries = await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: VIEWER });
    expect(db.listUserDisplayNames).not.toHaveBeenCalled();
    expect(entries.map((e) => e.targetName)).toEqual([null, null]);
  });

  it('names a channel the viewer can see, and leaves a hidden or deleted one unnamed', async () => {
    db.listAuditLogsForServer.mockResolvedValue([
      row({ metadata: { channelId: LOUNGE } }),
      row({ metadata: { channelId: SECRET_ROOM } }),
      row({ metadata: { channelId: '0a1b2c3d-0000-4000-8000-000000000099' } }),
      row({ metadata: { channelId: 'not-a-uuid' } }),
    ]);
    const entries = await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: VIEWER });
    expect(entries.map((e) => e.channelName)).toEqual(['Main Lounge', null, null, null]);
    expect(db.listVisibleChannelsForMember).toHaveBeenCalledWith(fakeDb, SERVER_ID, VIEWER);
  });

  it('the owner (and MANAGE_CHANNELS) see every channel name', async () => {
    db.listAuditLogsForServer.mockResolvedValue([row({ metadata: { channelId: SECRET_ROOM } })]);
    const asOwner = await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: OWNER });
    expect(asOwner[0]!.channelName).toBe('Staff Room');

    db.getUserPermissions.mockResolvedValue(['manage_channels']);
    const asManager = await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: VIEWER });
    expect(asManager[0]!.channelName).toBe('Staff Room');
  });

  it('names no channel for a viewer who is not a member', async () => {
    db.isServerMember.mockResolvedValue(false);
    db.listAuditLogsForServer.mockResolvedValue([row({ metadata: { channelId: LOUNGE } })]);
    const entries = await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: VIEWER });
    expect(entries[0]!.channelName).toBeNull();
  });

  it('skips the channel query when no row points at a channel, and returns [] for an empty log', async () => {
    db.listAuditLogsForServer.mockResolvedValue([row({ action: 'member.kick', metadata: {} })]);
    await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: VIEWER });
    expect(db.listChannelsForServer).not.toHaveBeenCalled();

    db.listAuditLogsForServer.mockResolvedValue([]);
    expect(await loadAuditEntries(fakeDb, { serverId: SERVER_ID, ownerUserId: OWNER, viewerUserId: VIEWER })).toEqual([]);
    expect(db.listAuditLogsForServer).toHaveBeenLastCalledWith(fakeDb, SERVER_ID, { limit: 100 });
  });
});
