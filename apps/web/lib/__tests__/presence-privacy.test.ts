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
});
