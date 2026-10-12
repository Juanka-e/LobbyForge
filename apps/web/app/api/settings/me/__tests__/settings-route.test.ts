import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEffectiveUserSettings = vi.fn();
const getUserLocale = vi.fn();
const setUserLocale = vi.fn();
const updateUserAudio = vi.fn();
const updateUserKeybinds = vi.fn();
const updateUserNotifications = vi.fn();
const updateUserPrivacySettings = vi.fn();
const updateUserTheme = vi.fn();
const requireMaterializedSession = vi.fn();
const recordSession = vi.fn();

vi.mock('@lobbyforge/db', () => ({
  getEffectiveUserSettings,
  getUserLocale,
  setUserLocale,
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
  getUserLocale.mockReset().mockResolvedValue(null);
  setUserLocale.mockReset().mockImplementation(async (_db, _uid, locale) => locale);
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

  describe('the account language (0048)', () => {
    const UID = '00000000-0000-0000-0000-000000000001';

    it('saves an installed language, in its installed spelling, and answers it', async () => {
      const response = await patch({ locale: 'TR' });

      expect(response.status).toBe(200);
      expect(setUserLocale).toHaveBeenCalledWith(expect.anything(), UID, 'tr');
      expect((await response.json()).settings.locale).toBe('tr');
    });

    it('clears it with null — "Match my browser"', async () => {
      const response = await patch({ locale: null });

      expect(response.status).toBe(200);
      expect(setUserLocale).toHaveBeenCalledWith(expect.anything(), UID, null);
      expect((await response.json()).settings.locale).toBeNull();
    });

    it('refuses a language this instance does not ship, and anything that is not a code', async () => {
      for (const locale of ['de', 'xx-YY', '../../etc', '', 'e', 42]) {
        const response = await patch({ locale });
        expect(response.status).toBe(400);
      }
      expect(setUserLocale).not.toHaveBeenCalled();
    });

    it('leaves the language alone when the body does not mention it', async () => {
      getUserLocale.mockResolvedValue('tr');
      const response = await patch({ theme: 'light' });

      expect(response.status).toBe(200);
      expect(setUserLocale).not.toHaveBeenCalled();
      expect((await response.json()).settings.locale).toBe('tr');
    });

    it('accepts a language-only body', async () => {
      expect((await patch({ locale: 'en' })).status).toBe(200);
      expect(setUserLocale).toHaveBeenCalledWith(expect.anything(), UID, 'en');
    });
  });
});

describe('GET /api/settings/me', () => {
  it('answers the account language with the other settings (null = follows the browser)', async () => {
    const { GET } = await import('../route.js');
    getUserLocale.mockResolvedValueOnce(null);
    const unset = await GET(new Request('https://example.test/api/settings/me'), {});
    expect((await unset.json()).settings.locale).toBeNull();
    getUserLocale.mockResolvedValueOnce('tr');
    const chosen = await GET(new Request('https://example.test/api/settings/me'), {});
    expect((await chosen.json()).settings.locale).toBe('tr');
  });
});
