import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_PRIVACY_SETTINGS, type UserPrivacySettings } from '@lobbyforge/db';
import { applyPresencePrivacy } from '@/lib/presence-privacy';
import type { UserPresenceSnapshot } from '@/lib/redis';

const basePresence: UserPresenceSnapshot = {
  userId: 'target-user',
  status: 'online',
  channelId: 'channel-1',
  lastSeen: 1_000,
  activity: {
    kind: 'game',
    label: 'Playing Quiz',
    pluginId: 'quiz',
    serverName: 'LobbyForge Test',
  },
};

function privacy(patch: Partial<UserPrivacySettings>): UserPrivacySettings {
  return { ...DEFAULT_USER_PRIVACY_SETTINGS, ...patch };
}

describe('applyPresencePrivacy', () => {
  it('hides online status when visibility is nobody', () => {
    const result = applyPresencePrivacy(
      basePresence,
      privacy({ onlineStatusVisibility: 'nobody' }),
      { isSelf: false, isServerMember: true }
    );
    expect(result.status).toBe('hidden');
  });

  it('beta-review: a hidden status does not leak through lastSeen', () => {
    const result = applyPresencePrivacy(
      basePresence,
      privacy({ onlineStatusVisibility: 'nobody' }),
      { isSelf: false, isServerMember: true }
    );
    expect(result.lastSeen).toBe(0);
  });

  it('a hidden status hides the voice room and the activity too (final test pass)', () => {
    // Activity sharing with everyone does not override a hidden status:
    // "Playing Quiz" or a channel id would say the user is online, and where.
    const result = applyPresencePrivacy(
      basePresence,
      privacy({ onlineStatusVisibility: 'nobody', activityVisibility: 'everyone' }),
      { isSelf: false, isServerMember: true }
    );
    expect(result).toEqual({ userId: 'target-user', status: 'hidden', channelId: null, lastSeen: 0 });
  });

  it('a status hidden from non-members also hides the channel from them, not from members', () => {
    const settings = privacy({ onlineStatusVisibility: 'server_members' });
    const stranger = applyPresencePrivacy(basePresence, settings, { isSelf: false, isServerMember: false });
    expect(stranger).toMatchObject({ status: 'hidden', channelId: null, lastSeen: 0 });
    expect(stranger.activity).toBeUndefined();
    const member = applyPresencePrivacy(basePresence, settings, { isSelf: false, isServerMember: true });
    expect(member).toMatchObject({ status: 'online', channelId: 'channel-1', lastSeen: 1_000 });
  });

  it('the user still sees their own channel and activity with a hidden status', () => {
    const self = applyPresencePrivacy(
      basePresence,
      privacy({ onlineStatusVisibility: 'nobody', activityVisibility: 'nobody' }),
      { isSelf: true, isServerMember: true }
    );
    expect(self).toMatchObject({ status: 'online', channelId: 'channel-1', lastSeen: 1_000 });
    expect(self.activity).toMatchObject({ kind: 'game' });
  });

  it('keeps own status visible even when visibility is nobody', () => {
    const result = applyPresencePrivacy(
      basePresence,
      privacy({ onlineStatusVisibility: 'nobody' }),
      { isSelf: true, isServerMember: true }
    );
    expect(result.status).toBe('online');
  });

  it('hides game activity when current-game sharing is disabled', () => {
    const result = applyPresencePrivacy(
      basePresence,
      privacy({ showCurrentGame: false }),
      { isSelf: false, isServerMember: true }
    );
    expect(result.activity).toBeUndefined();
  });

  it('removes server name from visible activity by default', () => {
    const result = applyPresencePrivacy(
      basePresence,
      DEFAULT_USER_PRIVACY_SETTINGS,
      { isSelf: false, isServerMember: true }
    );
    expect(result.activity).toMatchObject({ kind: 'game', label: 'Playing Quiz', pluginId: 'quiz' });
    expect(result.activity?.serverName).toBeUndefined();
  });

  it('treats friends visibility as self-only until a friends graph exists', () => {
    const result = applyPresencePrivacy(
      basePresence,
      privacy({ activityVisibility: 'friends' }),
      { isSelf: false, isServerMember: true }
    );
    expect(result.activity).toBeUndefined();
  });

  it('strips channelId when the channel is not visible to the viewer (beta-review F8)', () => {
    const result = applyPresencePrivacy(basePresence, DEFAULT_USER_PRIVACY_SETTINGS, {
      isSelf: false,
      isServerMember: true,
      visibleChannelIds: new Set(['some-other-channel']),
    });
    expect(result.channelId).toBeNull();
  });

  it('keeps channelId for visible channels, for self, and when no visibility set is given', () => {
    const visible = applyPresencePrivacy(basePresence, DEFAULT_USER_PRIVACY_SETTINGS, {
      isSelf: false,
      isServerMember: true,
      visibleChannelIds: new Set(['channel-1']),
    });
    expect(visible.channelId).toBe('channel-1');

    const self = applyPresencePrivacy(basePresence, DEFAULT_USER_PRIVACY_SETTINGS, {
      isSelf: true,
      isServerMember: true,
      visibleChannelIds: new Set(),
    });
    expect(self.channelId).toBe('channel-1');

    const unrestricted = applyPresencePrivacy(basePresence, DEFAULT_USER_PRIVACY_SETTINGS, {
      isSelf: false,
      isServerMember: true,
    });
    expect(unrestricted.channelId).toBe('channel-1');
  });
});
