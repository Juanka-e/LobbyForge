/**
 * Role icon vocabulary.
 *
 * Discord-style: a role icon is EITHER a Material Symbols name (the
 * original allowlist — back-compat for existing roles) OR any Unicode
 * emoji the host picks (single emoji, ZWJ sequences, flags, keycaps).
 *
 * Safety: icons render inside member lists, so arbitrary strings are NOT
 * accepted — the value must be a single grapheme built ONLY from emoji
 * code points, variation selectors, ZWJ and skin-tone modifiers, with a
 * hard length cap (matches the DB column). No text, no control chars,
 * no combining-mark spam.
 */
export const ROLE_ICONS = [
  'shield',
  'verified',
  'star',
  'crown',
  'sports_esports',
  'music_note',
  'groups',
  'palette',
] as const;

export type RoleIcon = (typeof ROLE_ICONS)[number];

/**
 * Emoji construction set: Extended_Pictographic (the actual emoji),
 * ZWJ (family/profession sequences), variation selector FE0F,
 * skin-tone modifiers (1F3FB–1F3FF), enclosing keycap 20E3 (with
 * digit/#/* bases) and regional indicators (flags).
 */
const EMOJI_SEQUENCE_RE = new RegExp(
  String.raw`^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}\p{RI}0-9#*\u{FE0E}])+$`,
  'u'
);

/** At least one pictographic/flag/keycap base must be present. */
const HAS_EMOJI_BASE_RE = new RegExp(String.raw`[\p{Extended_Pictographic}\p{RI}\u{20E3}]`, 'u');

export function isValidRoleIcon(value: string): boolean {
  if (value.length === 0 || value.length > 32) return false;
  // Material names stay valid (existing rows + the icon picker).
  if ((ROLE_ICONS as readonly string[]).includes(value)) return true;
  if (!EMOJI_SEQUENCE_RE.test(value)) return false;
  return HAS_EMOJI_BASE_RE.test(value);
}
