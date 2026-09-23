import { describe, expect, it } from 'vitest';
import { contrastRatio, deriveAccent, parseHex } from '../accent.js';

/**
 * The accent is a user preference written inline on <html>, so no theme
 * rule can override it. These tests pin the thing that matters: whatever
 * the user picks, it has to READ on the theme they are using. The
 * default ice blue sits at ~1.9:1 on white, which is what made the
 * light theme's accent text unreadable.
 */
const WHITE = parseHex('#ffffff')!;
const LIGHT_SURFACE = parseHex('#eef2f7')!;
const DARK_PAGE = parseHex('#101419')!;
const DEFAULT_ACCENT = '#8FB8FF';

function ratioOnLight(hex: string): number {
  return contrastRatio(parseHex(hex)!, WHITE);
}

describe('deriveAccent', () => {
  it('leaves the accent untouched on dark themes', () => {
    // Users pick their accent while looking at a dark page; it is
    // already right there, and changing it would be a surprise.
    expect(deriveAccent(DEFAULT_ACCENT, 'dark').accent.toLowerCase()).toBe('#8fb8ff');
    expect(deriveAccent(DEFAULT_ACCENT, 'dim').accent.toLowerCase()).toBe('#8fb8ff');
  });

  it('keeps the default accent readable on a dark page', () => {
    const { accent } = deriveAccent(DEFAULT_ACCENT, 'dark');
    expect(contrastRatio(parseHex(accent)!, DARK_PAGE)).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens the accent until it reads on the light theme', () => {
    expect(ratioOnLight(DEFAULT_ACCENT)).toBeLessThan(4.5); // the bug
    const { accent } = deriveAccent(DEFAULT_ACCENT, 'light');
    expect(ratioOnLight(accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(parseHex(accent)!, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['#8FB8FF', '#FFD166', '#7CCFA6', '#E98282', '#FFFFFF', '#C0FFEE'])(
    'makes any picked accent (%s) readable on the light theme',
    (picked) => {
      const { accent } = deriveAccent(picked, 'light');
      expect(ratioOnLight(accent)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it('pairs every accent with a foreground that reads on it', () => {
    for (const picked of ['#8FB8FF', '#07101E', '#FFD166', '#1c56b8', '#000000']) {
      for (const theme of ['dark', 'light'] as const) {
        const { accent, onAccent } = deriveAccent(picked, theme);
        expect(contrastRatio(parseHex(accent)!, parseHex(onAccent)!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('is idempotent — deriving twice does not keep darkening', () => {
    const once = deriveAccent(DEFAULT_ACCENT, 'light').accent;
    const twice = deriveAccent(once, 'light').accent;
    expect(twice).toBe(once);
  });

  it('leaves an unparseable value alone rather than inventing a colour', () => {
    expect(deriveAccent('not-a-colour', 'light').accent).toBe('not-a-colour');
  });

  it('accepts shorthand hex', () => {
    expect(parseHex('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
  });
});
