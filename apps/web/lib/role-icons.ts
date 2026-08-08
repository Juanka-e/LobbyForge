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

