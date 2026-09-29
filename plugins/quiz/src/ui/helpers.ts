/** Pure helpers for the panel — no React, so they are unit-tested directly. */

import type { QuizPlayer } from '../state';

export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export function optionLetter(index: number): string {
  return OPTION_LETTERS[index] ?? String(index + 1);
}

/**
 * The answer a key picks while the question has focus: `1`–`6` or `A`–`F`
 * (either case), limited to the options on screen. Anything else — and any
 * key held with Ctrl, Alt or Meta — is not ours.
 */
export function optionIndexForKey(
  key: string,
  optionCount: number,
  modifiers: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}
): number | null {
  if (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey) return null;
  if (key.length !== 1) return null;
  let index = -1;
  if (key >= '1' && key <= '9') index = key.charCodeAt(0) - '1'.charCodeAt(0);
  else {
    const upper = key.toUpperCase();
    index = (OPTION_LETTERS as readonly string[]).indexOf(upper);
  }
  return index >= 0 && index < optionCount ? index : null;
}

/** Is the key event coming from somewhere the user types? Then shortcuts stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}

export interface SessionPlayer {
  userId: string;
  name?: string | null;
}

/**
 * Who is this? The name the host passes in `players` (live), then the name
 * the host had when the player joined (stored in the quiz state), then
 * "Player 3" by join order.
 */
export function resolvePlayerName(
  userId: string,
  sessionPlayers: readonly SessionPlayer[],
  roster: readonly QuizPlayer[],
  fallback: (joinNumber: number | null) => string
): string {
  const shown = sessionPlayers.find((player) => player.userId === userId)?.name?.trim();
  if (shown) return shown;
  const index = roster.findIndex((player) => player.id === userId);
  const stored = index >= 0 ? roster[index]!.name?.trim() : null;
  if (stored) return stored;
  return fallback(index >= 0 ? index + 1 : null);
}

/** A language's own name ("English", "Türkçe"), or its code when the runtime cannot say. */
export function nativeLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // Older runtimes: fall through.
  }
  return code.toUpperCase();
}

/**
 * A stable per-user delay (0–1.5 s) so players who notice the deadline at
 * the same moment do not all call time at once.
 */
export function staggerFor(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return Math.abs(hash) % 1_500;
}

/** Whole seconds left before `deadline`, never negative; null without a deadline. */
export function secondsLeft(deadline: number | null | undefined, now: number): number | null {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Share of the time left, 0–1. */
export function timeFraction(startedAt: number | null | undefined, deadline: number | null | undefined, now: number): number {
  if (typeof startedAt !== 'number' || typeof deadline !== 'number' || deadline <= startedAt) return 0;
  return Math.min(1, Math.max(0, (deadline - now) / (deadline - startedAt)));
}
