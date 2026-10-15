/**
 * The 0050 profile fields — handle, pronouns, profile colour — and the
 * rules both the settings page and `PATCH /api/users/me/profile` apply
 * (docs/PROFILES.md "Profile fields"). Client-safe.
 *
 * The database keeps the last word: a format CHECK on `users.username` and
 * `users.accent_color`, and a unique constraint on the handle.
 */

export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 32;
export const PRONOUNS_MAX_LENGTH = 40;

/** Lowercase letters, digits, `_` and `.` — the SQL CHECK's pattern. */
const USERNAME_PATTERN = /^[a-z0-9_.]+$/;
const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;
/** C0/C1 control characters, refused in every free-text profile field. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Handles nobody may take: the two mass mentions (a handle is also a
 * mention), and names that would pass for the instance or its staff.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'everyone',
  'here',
  'admin',
  'administrator',
  'moderator',
  'mod',
  'owner',
  'system',
  'lobbyforge',
  'support',
  'staff',
  'bot',
  'webhook',
]);

export type UsernameProblem = 'too_short' | 'too_long' | 'characters' | 'dots' | 'reserved';

/** Trimmed and lowercased — `Ada_L` and `ada_l` are one handle. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Why a handle (already normalised) cannot be used, or null. Dots may not
 * start or end it or come in pairs, so `a..b` and `.ada` never look like
 * a path or an address.
 */
export function usernameProblem(username: string): UsernameProblem | null {
  if (username.length < USERNAME_MIN_LENGTH) return 'too_short';
  if (username.length > USERNAME_MAX_LENGTH) return 'too_long';
  if (!USERNAME_PATTERN.test(username)) return 'characters';
  if (username.startsWith('.') || username.endsWith('.') || username.includes('..')) return 'dots';
  if (RESERVED_USERNAMES.has(username)) return 'reserved';
  return null;
}

/** The settings page's message for each handle problem. */
export const USERNAME_PROBLEM_KEYS: Record<UsernameProblem | 'taken' | 'guest', string> = {
  too_short: 'settings.profile.username.tooShort',
  too_long: 'settings.profile.username.tooLong',
  characters: 'settings.profile.username.characters',
  dots: 'settings.profile.username.dots',
  reserved: 'settings.profile.username.reserved',
  taken: 'settings.profile.username.taken',
  guest: 'settings.profile.username.guest',
};

/** Pronouns as stored: trimmed, inner whitespace collapsed; null when empty. */
export function normalizePronouns(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

export function pronounsProblem(value: string): 'too_long' | 'characters' | null {
  if (CONTROL_CHARACTERS.test(value)) return 'characters';
  if (value.length > PRONOUNS_MAX_LENGTH) return 'too_long';
  return null;
}

/** `#RRGGBB` / `#rrggbb` → lowercase, or null when it is not a six-digit hex colour. */
export function normalizeAccentColor(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase();
  return ACCENT_COLOR_PATTERN.test(text) ? text : null;
}

/**
 * The swatches the settings page offers before the free picker. Mid-tone
 * so white text and the dark scrim of the banner buttons stay readable on
 * every one of them, in both themes.
 */
export const ACCENT_COLOR_PRESETS: readonly string[] = [
  '#5865f2',
  '#3b82f6',
  '#0ea5e9',
  '#14b8a6',
  '#22c55e',
  '#84cc16',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#a855f7',
  '#64748b',
];
