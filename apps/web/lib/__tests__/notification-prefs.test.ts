import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetNotificationPrefsForTests,
  DEFAULT_NOTIFICATION_PREFS,
  loadNotificationPrefs,
  parseNotificationPrefs,
  shouldNotify,
} from '@/lib/notification-prefs';

beforeEach(() => __resetNotificationPrefsForTests());

describe('parseNotificationPrefs', () => {
  it('keeps known values and falls back for the rest', () => {
    expect(parseNotificationPrefs({ level: 'all', sound: 'subtle', unreadBadge: false, suppressWhileInVoice: false })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      level: 'all',
      sound: 'subtle',
      unreadBadge: false,
      suppressWhileInVoice: false,
    });
    expect(parseNotificationPrefs({ level: 'loud', sound: 'horn', desktopEnabled: 'yes' })).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });
});

describe('loadNotificationPrefs', () => {
  it('reads the settings once per page; a failure gives the defaults', async () => {
    const fetcher = vi.fn(async () => Response.json({ settings: { notifications: { level: 'nothing' } } }));
    expect((await loadNotificationPrefs(fetcher as never)).level).toBe('nothing');
    await loadNotificationPrefs(fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(1);
    __resetNotificationPrefsForTests();
    expect(await loadNotificationPrefs((async () => { throw new Error('offline'); }) as never)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });
});

describe('shouldNotify', () => {
  const hidden = { mentioned: true, inVoice: false, hidden: true };

  it('only for a hidden tab, an unmuted channel and an enabled setting', () => {
    expect(shouldNotify(DEFAULT_NOTIFICATION_PREFS, hidden)).toBe(true);
    expect(shouldNotify(DEFAULT_NOTIFICATION_PREFS, { ...hidden, hidden: false })).toBe(false);
    expect(shouldNotify(DEFAULT_NOTIFICATION_PREFS, { ...hidden, channelMuted: true })).toBe(false);
    expect(shouldNotify({ ...DEFAULT_NOTIFICATION_PREFS, desktopEnabled: false }, hidden)).toBe(false);
    expect(shouldNotify({ ...DEFAULT_NOTIFICATION_PREFS, level: 'nothing' }, hidden)).toBe(false);
  });

  it('"mentions" needs a mention; "all" does not', () => {
    expect(shouldNotify(DEFAULT_NOTIFICATION_PREFS, { ...hidden, mentioned: false })).toBe(false);
    expect(shouldNotify({ ...DEFAULT_NOTIFICATION_PREFS, level: 'all' }, { ...hidden, mentioned: false })).toBe(true);
  });

  it('"Suppress while in voice" keeps a voice room quiet — and only when it is on', () => {
    expect(shouldNotify(DEFAULT_NOTIFICATION_PREFS, { ...hidden, inVoice: true })).toBe(false);
    expect(shouldNotify({ ...DEFAULT_NOTIFICATION_PREFS, suppressWhileInVoice: false }, { ...hidden, inVoice: true })).toBe(true);
  });
});
