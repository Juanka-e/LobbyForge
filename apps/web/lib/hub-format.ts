/**
 * Small display helpers for the official hub: community tiles and the
 * identity colour of each activity.
 */

import { initialOf } from './initial';

/**
 * "Night Owls" → "NO", "hushle" → "H". Whole graphemes, not code units or
 * code points: emoji, flags and accents stay whole (see `lib/initial.ts`).
 */
export function initialsFor(name: string, locale: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((word) => initialOf(word, { locale, fallback: '' }))
    .join('');
  return letters || '?';
}

/**
 * Pastel tile colours for community initials. The initials are drawn in a
 * fixed near-black on top, which reads on every one of these in every
 * theme, so the pair needs no theme variant.
 */
export const COMMUNITY_TINTS = ['#8FB8FF', '#A8B3C5', '#E7B86A', '#7CCFA6', '#C9B6FF', '#E68A9B'] as const;

/** A stable tint per community, so a community keeps its colour between visits. */
export function tintFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return COMMUNITY_TINTS[hash % COMMUNITY_TINTS.length]!;
}

/**
 * Each activity's identity hue: `dark` is the design's pale ink for the
 * dark and dim themes, `light` a deeper shade of the same hue that keeps
 * text contrast on the light theme (see `hub-tones.module.css`).
 */
export interface Tone {
  dark: string;
  light: string;
}

const ACTIVITY_TONES: Record<string, Tone> = {
  hushle: { dark: '#E7B86A', light: '#8A5A00' },
  quiz: { dark: '#8FB8FF', light: '#2F5FA8' },
  'vampire-village': { dark: '#E68A9B', light: '#A8354B' },
  'watch-party': { dark: '#7CCFA6', light: '#1F7A52' },
  poll: { dark: '#C3CCDA', light: '#4A5568' },
  'dice-bot': { dark: '#C9B6FF', light: '#6B4FBB' },
};

const DEFAULT_TONE: Tone = { dark: '#8FB8FF', light: '#2F5FA8' };

export function activityTone(pluginId: string): Tone {
  return ACTIVITY_TONES[pluginId] ?? DEFAULT_TONE;
}

/**
 * How many people an activity is for, from its manifest's `playerConfig`:
 * "4–12 players", or "up to 50" when anyone from one person up can join.
 * `null` when the manifest does not say — the card then shows no count.
 */
export function playerRange(
  config: { minPlayers?: number; maxPlayers?: number } | null | undefined
): { kind: 'range'; min: number; max: number } | { kind: 'upTo'; max: number } | null {
  const max = config?.maxPlayers;
  if (!max || !Number.isFinite(max) || max < 1) return null;
  const min = config?.minPlayers ?? 1;
  if (min <= 1 || min >= max) return { kind: 'upTo', max };
  return { kind: 'range', min, max };
}
