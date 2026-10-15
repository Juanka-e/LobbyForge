/**
 * The viewer's notification settings (Settings → Notifications) as the
 * lobby applies them — read once per page from `GET /api/settings/me` and
 * shared by the chat (the open channel), the channel list (mentions
 * elsewhere) and the DM list. Client-only.
 *
 * Every setting the page offers now does what it says:
 *   level / desktopEnabled / showPreview   which messages raise a notification
 *   sound                                  the chime, a soft pop, or nothing
 *   unreadBadge                            red mention badges on channels
 *   suppressWhileInVoice                   no desktop notifications in a voice room
 */

export type NotificationLevel = 'all' | 'mentions' | 'nothing';
export type NotificationSound = 'default' | 'subtle' | 'none';

export interface NotificationPrefs {
  level: NotificationLevel;
  desktopEnabled: boolean;
  showPreview: boolean;
  sound: NotificationSound;
  unreadBadge: boolean;
  suppressWhileInVoice: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  level: 'mentions',
  desktopEnabled: true,
  showPreview: true,
  sound: 'default',
  unreadBadge: true,
  suppressWhileInVoice: true,
};

export function parseNotificationPrefs(input: unknown): NotificationPrefs {
  if (!input || typeof input !== 'object') return { ...DEFAULT_NOTIFICATION_PREFS };
  const raw = input as Record<string, unknown>;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  return {
    level: raw.level === 'all' || raw.level === 'nothing' ? raw.level : 'mentions',
    desktopEnabled: bool(raw.desktopEnabled, DEFAULT_NOTIFICATION_PREFS.desktopEnabled),
    showPreview: bool(raw.showPreview, DEFAULT_NOTIFICATION_PREFS.showPreview),
    sound: raw.sound === 'subtle' || raw.sound === 'none' ? raw.sound : 'default',
    unreadBadge: bool(raw.unreadBadge, DEFAULT_NOTIFICATION_PREFS.unreadBadge),
    suppressWhileInVoice: bool(raw.suppressWhileInVoice, DEFAULT_NOTIFICATION_PREFS.suppressWhileInVoice),
  };
}

let pending: Promise<NotificationPrefs> | null = null;

/** The settings, fetched once per page load (defaults when they cannot be read). */
export function loadNotificationPrefs(fetcher: typeof fetch = fetch): Promise<NotificationPrefs> {
  pending ??= fetcher('/api/settings/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => (response.ok ? ((await response.json()) as { settings?: { notifications?: unknown } }) : null))
    .then((body) => parseNotificationPrefs(body?.settings?.notifications))
    .catch(() => ({ ...DEFAULT_NOTIFICATION_PREFS }));
  return pending;
}

/** Test hook. */
export function __resetNotificationPrefsForTests(): void {
  pending = null;
}

/**
 * Whether a message should raise a desktop notification for this viewer.
 * `mentioned`: it names them (or pings everyone). Never for a visible tab.
 */
export function shouldNotify(
  prefs: NotificationPrefs,
  facts: { mentioned: boolean; inVoice: boolean; channelMuted?: boolean; hidden: boolean }
): boolean {
  if (!facts.hidden || facts.channelMuted) return false;
  if (!prefs.desktopEnabled || prefs.level === 'nothing') return false;
  if (prefs.suppressWhileInVoice && facts.inVoice) return false;
  return prefs.level === 'all' || facts.mentioned;
}

let audioContext: AudioContext | null = null;

/**
 * The notification sound — made here rather than left to the system, so
 * "Default chime", "Subtle pop" and "No sound" differ: two rising notes, one
 * soft low blip, or silence. Best effort: a browser that has not let the
 * page play audio yet stays silent.
 */
export function playNotificationSound(sound: NotificationSound): void {
  if (sound === 'none' || typeof window === 'undefined') return;
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audioContext ??= new Context();
    const context = audioContext;
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const notes = sound === 'subtle' ? [{ at: 0, freq: 520, gain: 0.05, length: 0.12 }] : [
      { at: 0, freq: 660, gain: 0.12, length: 0.14 },
      { at: 0.12, freq: 880, gain: 0.12, length: 0.2 },
    ];
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.freq;
      const start = context.currentTime + note.at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + note.length + 0.02);
    }
  } catch {
    // No audio: the notification still shows.
  }
}
