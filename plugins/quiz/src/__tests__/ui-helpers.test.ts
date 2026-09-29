import { describe, expect, it } from 'vitest';
import {
  isTypingTarget,
  nativeLanguageName,
  optionIndexForKey,
  optionLetter,
  resolvePlayerName,
  secondsLeft,
  staggerFor,
  timeFraction,
} from '../ui/helpers';
import { optionSwatch, OPTION_SWATCHES } from '../ui/palette';
import { newQuizPlayer } from '../state';

describe('keyboard shortcuts', () => {
  it('maps 1–4 and A–D (either case) to the options on screen', () => {
    expect(optionIndexForKey('1', 4)).toBe(0);
    expect(optionIndexForKey('4', 4)).toBe(3);
    expect(optionIndexForKey('a', 4)).toBe(0);
    expect(optionIndexForKey('D', 4)).toBe(3);
  });

  it('ignores keys beyond the options, other keys and modifier chords', () => {
    expect(optionIndexForKey('5', 4)).toBeNull();
    expect(optionIndexForKey('e', 4)).toBeNull();
    expect(optionIndexForKey('0', 4)).toBeNull();
    expect(optionIndexForKey('Enter', 4)).toBeNull();
    expect(optionIndexForKey(' ', 4)).toBeNull();
    expect(optionIndexForKey('a', 4, { ctrlKey: true })).toBeNull();
    expect(optionIndexForKey('1', 4, { metaKey: true })).toBeNull();
    expect(optionIndexForKey('b', 2, { altKey: false })).toBe(1);
  });

  it('stays out of the way while the user types', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('answer letters and colours', () => {
  it('gives every option its own letter and colour', () => {
    expect([0, 1, 2, 3].map(optionLetter)).toEqual(['A', 'B', 'C', 'D']);
    expect(new Set([0, 1, 2, 3, 4, 5].map(optionSwatch)).size).toBe(OPTION_SWATCHES.length);
  });
});

describe('names', () => {
  const roster = [newQuizPlayer('u1', null, 0), newQuizPlayer('u2', 'Kaya', 0), newQuizPlayer('u3', null, 0)];
  const fallback = (n: number | null) => (n === null ? 'Someone' : `Player ${n}`);

  it('prefers the live session name, then the name stored at join, then the join number', () => {
    const session = [{ userId: 'u1', name: 'Mira' }, { userId: 'u2', name: null }];
    expect(resolvePlayerName('u1', session, roster, fallback)).toBe('Mira');
    expect(resolvePlayerName('u2', session, roster, fallback)).toBe('Kaya');
    expect(resolvePlayerName('u3', session, roster, fallback)).toBe('Player 3');
    expect(resolvePlayerName('stranger', session, roster, fallback)).toBe('Someone');
  });

  it('names a pack language in that language', () => {
    expect(nativeLanguageName('en')).toBe('English');
    expect(nativeLanguageName('tr')).toBe('Türkçe');
  });
});

describe('time', () => {
  it('counts whole seconds down to a deadline and never below zero', () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
    expect(secondsLeft(null, 0)).toBeNull();
  });

  it('gives the share of time left for the bar', () => {
    expect(timeFraction(0, 20_000, 5_000)).toBe(0.75);
    expect(timeFraction(0, 20_000, 30_000)).toBe(0);
    expect(timeFraction(null, 20_000, 0)).toBe(0);
  });

  it('staggers time calls per user, within 1.5 s', () => {
    const delays = ['a', 'b', 'user-123', 'x'.repeat(40)].map(staggerFor);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1_500);
    }
    expect(staggerFor('a')).toBe(staggerFor('a'));
  });
});
