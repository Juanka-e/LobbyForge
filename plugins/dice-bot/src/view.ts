/**
 * The Dice Bot panel's rules, kept free of React and of text so they can be
 * tested on their own: which dice the picker offers, how the stats table is
 * ordered, how old a roll is. The panel maps what these return onto its
 * translated messages.
 *
 * Imports from `./index` are TYPE-only — `index.ts` imports the panel, so
 * a runtime import back would be the ESM cycle `constants.ts` describes.
 */
import { DICE_MAX_SIDES, DICE_MIN_SIDES } from './constants';
import type { DiceRoll, DiceStats } from './index';

/**
 * The die sizes the picker offers. Every entry must survive the reducer's
 * clamp (`min(DICE_MAX_SIDES, max(DICE_MIN_SIDES, sides))`) untouched,
 * otherwise the UI would promise a die the server refuses to roll. The
 * filter makes that a guarantee rather than a comment.
 */
export const DICE_DIE_SIZES: readonly number[] = [2, 4, 6, 8, 10, 12, 20, 100].filter(
  (sides) => sides >= DICE_MIN_SIDES && sides <= DICE_MAX_SIDES
);

/** The die a viewer starts on — the reducer's own default. */
export const DICE_DEFAULT_SIDES = 6;

/** How many rolls the feed lists before summarising the older ones. */
export const DICE_VISIBLE_HISTORY = 8;

export interface DiceStatRow extends DiceStats {
  userId: string;
  /** The mean roll, `sum / rolls`; 0 before a first roll. */
  average: number;
}

/**
 * Per-player stats as table rows, leader first: the highest single roll,
 * then the higher total, then more rolls, then the id — so two equal rows
 * never swap places between renders.
 */
export function diceStatRows(stats: Record<string, DiceStats> | null | undefined): DiceStatRow[] {
  if (!stats || typeof stats !== 'object') return [];
  return Object.entries(stats)
    .map(([userId, entry]) => {
      const rolls = Number(entry?.rolls) || 0;
      const sum = Number(entry?.sum) || 0;
      const best = Number(entry?.best) || 0;
      return { userId, rolls, sum, best, average: rolls > 0 ? sum / rolls : 0 };
    })
    .sort((a, b) => b.best - a.best || b.sum - a.sum || b.rolls - a.rolls || a.userId.localeCompare(b.userId));
}

/** A roll as the panel can trust it: the state arrives as raw JSON. */
export function isDiceRoll(value: unknown): value is DiceRoll {
  if (!value || typeof value !== 'object') return false;
  const roll = value as Record<string, unknown>;
  return (
    typeof roll.playerId === 'string' &&
    typeof roll.sides === 'number' &&
    typeof roll.value === 'number' &&
    typeof roll.at === 'string'
  );
}

/** The rolls the feed lists, newest first, and how many older ones it leaves out. */
export function recentRolls(history: unknown, limit = DICE_VISIBLE_HISTORY): { visible: DiceRoll[]; hidden: number } {
  const all = Array.isArray(history) ? history.filter(isDiceRoll) : [];
  const visible = all.slice(0, limit);
  return { visible, hidden: all.length - visible.length };
}

export type Elapsed = { unit: 'now' } | { unit: 'seconds' | 'minutes' | 'hours' | 'days'; count: number };

/** How long ago `iso` was, in its largest whole unit; null for a timestamp that does not parse. */
export function elapsedSince(iso: string, now: number): Elapsed | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return { unit: 'now' };
  if (seconds < 60) return { unit: 'seconds', count: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.floor(hours / 24) };
}
