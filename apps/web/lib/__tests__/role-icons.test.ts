import { describe, expect, it } from 'vitest';
import { ROLE_ICONS, isValidRoleIcon } from '../role-icons.js';

describe('isValidRoleIcon — Discord-style emoji icons (safe-unlimited)', () => {
  it('accepts every legacy Material icon name (back-compat)', () => {
    for (const name of ROLE_ICONS) {
      expect(isValidRoleIcon(name), name).toBe(true);
    }
  });

  it('accepts single emoji, ZWJ sequences, flags and skin tones', () => {
    expect(isValidRoleIcon('🎮')).toBe(true);
    expect(isValidRoleIcon('👑')).toBe(true);
    expect(isValidRoleIcon('👨‍💻')).toBe(true); // ZWJ profession sequence
    expect(isValidRoleIcon('🏳️‍🌈')).toBe(true); // flag ZWJ sequence
    expect(isValidRoleIcon('🇹🇷')).toBe(true); // regional-indicator flag
    expect(isValidRoleIcon('👍🏽')).toBe(true); // skin-tone modifier
  });

  it('rejects plain text and mixed text+emoji strings', () => {
    expect(isValidRoleIcon('admin')).toBe(false);
    expect(isValidRoleIcon('a🎮')).toBe(false);
    expect(isValidRoleIcon('🎮x')).toBe(false);
    expect(isValidRoleIcon('gamers rule')).toBe(false);
  });

  it('rejects control characters, HTML/markup and script payloads', () => {
    expect(isValidRoleIcon('<script>')).toBe(false);
    expect(isValidRoleIcon('<img src=x onerror=alert(1)>')).toBe(false);
    expect(isValidRoleIcon('🎮\n')).toBe(false);
    expect(isValidRoleIcon('\u0000')).toBe(false);
    expect(isValidRoleIcon('🎮\u200B')).toBe(false); // zero-width space (not ZWJ)
  });

  it('enforces the length cap (32 UTF-16 units — matches the DB column)', () => {
    expect(isValidRoleIcon('🎮'.repeat(16))).toBe(true); // 16 surrogate pairs = 32 units
    expect(isValidRoleIcon('🎮'.repeat(17))).toBe(false); // 34 units
    expect(isValidRoleIcon('')).toBe(false);
  });
});
