import { describe, expect, it } from 'vitest';
import {
  ACCENT_COLOR_PRESETS,
  normalizeAccentColor,
  normalizePronouns,
  normalizeUsername,
  pronounsProblem,
  RESERVED_USERNAMES,
  USERNAME_PROBLEM_KEYS,
  usernameProblem,
} from '@/lib/profile-fields';

describe('handles', () => {
  it('normalise to trimmed lowercase', () => {
    expect(normalizeUsername('  Ada_L.Dev ')).toBe('ada_l.dev');
  });

  it('follow the SQL CHECK and the dot rules', () => {
    expect(usernameProblem('ada')).toBeNull();
    expect(usernameProblem('a')).toBe('too_short');
    expect(usernameProblem('a'.repeat(33))).toBe('too_long');
    expect(usernameProblem('ada!')).toBe('characters');
    expect(usernameProblem('ADA')).toBe('characters');
    expect(usernameProblem('ada.')).toBe('dots');
    expect(usernameProblem('a..b')).toBe('dots');
    for (const name of RESERVED_USERNAMES) expect(usernameProblem(name)).toBe('reserved');
  });

  it('every problem has a message key', () => {
    for (const key of Object.values(USERNAME_PROBLEM_KEYS)) expect(key).toMatch(/^settings\.profile\.username\./);
  });
});

describe('pronouns', () => {
  it('collapse whitespace; empty is none', () => {
    expect(normalizePronouns('  she /  her ')).toBe('she / her');
    expect(normalizePronouns('   ')).toBeNull();
    expect(normalizePronouns(null)).toBeNull();
  });

  it('refuse control characters and more than 40 characters', () => {
    expect(pronounsProblem('they/them')).toBeNull();
    expect(pronounsProblem('x'.repeat(41))).toBe('too_long');
    expect(pronounsProblem('a\u0007b')).toBe('characters');
  });
});

describe('profile colour', () => {
  it('accepts #rrggbb in any case, stored lowercase; anything else is null', () => {
    expect(normalizeAccentColor('#5865F2')).toBe('#5865f2');
    for (const bad of ['5865f2', '#fff', 'red', '#12345g', 'url(x)', '', null, undefined]) {
      expect(normalizeAccentColor(bad)).toBeNull();
    }
  });

  it('every preset is a valid colour', () => {
    for (const color of ACCENT_COLOR_PRESETS) expect(normalizeAccentColor(color)).toBe(color);
  });
});
