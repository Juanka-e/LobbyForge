import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEffectiveUserSettings = vi.fn();
const updateUserAudio = vi.fn();
const updateUserKeybinds = vi.fn();
const updateUserNotifications = vi.fn();
const updateUserPrivacySettings = vi.fn();
const updateUserTheme = vi.fn();
const requireMaterializedSession = vi.fn();
const recordSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getEffectiveUserSettings,
  updateUserAudio,
  updateUserKeybinds,
  updateUserNotifications,
  updateUserPrivacySettings,
  updateUserTheme,
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({ __testDb: true }) }));
vi.mock('@/lib/api-auth', () => ({ requireMaterializedSession }));
vi.mock('@/lib/security-headers', () => ({ withApiSecurity: (handler: unknown) => handler }));
vi.mock('@/lib/session-tracker', () => ({ recordSession }));

const BASE_SETTINGS = {
  theme: 'dark',
  notifications: {},
  audio: {},
  privacy: {
    profileVisibility: 'server_members',
    onlineStatusVisibility: 'server_members',
    activityVisibility: 'server_members',
    showCurrentGame: true,
    showMusicStatus: true,
    showWatchPartyStatus: true,
    showServerNameInActivity: false,
  },
  keybinds: {},
  updatedAt: new Date('2026-06-23T00:00:00.000Z'),
};

beforeEach(() => {
  getEffectiveUserSettings.mockReset().mockResolvedValue(BASE_SETTINGS);
  updateUserAudio.mockReset().mockImplementation(async (_db, _uid, audio) => ({
    ...BASE_SETTINGS,
    audio,
  }));
  updateUserKeybinds.mockReset().mockImplementation(async (_db, _uid, keybinds) => ({
    ...BASE_SETTINGS,
    keybinds,
  }));
  updateUserNotifications.mockReset().mockImplementation(async (_db, _uid, notifications) => ({
    ...BASE_SETTINGS,
    notifications,
  }));
  updateUserPrivacySettings.mockReset().mockImplementation(async (_db, _uid, privacy) => ({
    ...BASE_SETTINGS,
    privacy,
  }));
  updateUserTheme.mockReset().mockImplementation(async (_db, _uid, theme) => ({
    ...BASE_SETTINGS,
    theme,
  }));
  recordSession.mockReset();
  requireMaterializedSession.mockReset().mockReturnValue({
    ok: true,
    session: {
      uid: '00000000-0000-0000-0000-000000000001',
      gid: 'g_00000000000000000000000000000001',
      name: 'Owner',
    },
  });
});

async function patch(body: unknown) {
  const { PATCH } = await import('../route.js');
  return PATCH(
    new Request('https://example.test/api/settings/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {}
  );
}

describe('PATCH /api/settings/me', () => {
  it('rejects nested notification payloads before they reach storage', async () => {
    const response = await patch({ notifications: { sound: { nested: true } } });

    expect(response.status).toBe(400);
    expect(updateUserNotifications).not.toHaveBeenCalled();
  });

  it('rejects unknown top-level settings keys', async () => {
    const response = await patch({ theme: 'dark', role: 'owner' });

    expect(response.status).toBe(400);
    expect(updateUserTheme).not.toHaveBeenCalled();
  });

  it('persists bounded flat audio preferences', async () => {
    const response = await patch({
      audio: {
        inputVolume: 80,
        noiseSuppression: true,
        inputMode: 'voice_activity',
      },
    });

    expect(response.status).toBe(200);
    expect(updateUserAudio).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      {
        inputVolume: 80,
        noiseSuppression: true,
        inputMode: 'voice_activity',
      }
    );
  });

  it('persists bounded keybind preferences', async () => {
    const response = await patch({
      keybinds: {
        pushToTalk: { code: 'AltLeft', label: 'Left Alt' },
      },
    });

    expect(response.status).toBe(200);
    expect(updateUserKeybinds).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      {
        pushToTalk: { code: 'AltLeft', label: 'Left Alt' },
      }
    );
  });
});
