/**
 * Making the user's chosen accent readable on whichever theme is active.
 *
 * The accent is a PREFERENCE, not a theme token: `AppearanceRuntime`
 * writes it as an inline custom property on `<html>`, which beats any
 * `.lf-theme-*` rule. So a light theme cannot simply declare its own
 * accent — the preference would win, and the default ice blue (#8FB8FF)
 * sits at roughly 1.9:1 on white, failing WCAG AA badly for the ~500
 * places that use the accent as INK (`text-primary`, borders, tints).
 *
 * Instead the preference is honoured and adapted: the same hue, darkened
 * only as far as it must be to read on a light page, and paired with a
 * foreground picked from its luminance so a button fill always carries
 * legible text.
 */

export type ResolvedTheme = 'dark' | 'dim' | 'light';

export interface DerivedAccent {
  /** The accent to use as ink and as a fill. */
  accent: string;
  /** Foreground for text sitting ON the accent. */
  onAccent: string;
}

/** WCAG AA for normal text. */
const TARGET_CONTRAST = 4.5;
/** The lightest surface the accent must read against on the light theme. */
const LIGHT_SURFACE: Rgb = [255, 255, 255];

type Rgb = [number, number, number];

export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);
  const [hi, lo] = first > second ? [first, second] : [second, first];
  return (hi + 0.05) / (lo + 0.05);
}

function scale(rgb: Rgb, factor: number): Rgb {
  return [rgb[0] * factor, rgb[1] * factor, rgb[2] * factor];
}

/**
 * Darken toward black in small steps until the colour reads against
 * `against`, keeping the hue. Gives up at black, which always passes.
 */
function darkenUntilReadable(rgb: Rgb, against: Rgb): Rgb {
  let current = rgb;
  for (let step = 0; step < 24; step += 1) {
    if (contrastRatio(current, against) >= TARGET_CONTRAST) return current;
    current = scale(current, 0.9);
  }
  return [0, 0, 0];
}

/**
 * The foreground for text on this accent: whichever of near-black or
 * white reads better. Near-black rather than pure black to match the
 * palette's `on-primary`.
 */
function foregroundFor(rgb: Rgb): string {
  const dark: Rgb = [7, 16, 30];
  return contrastRatio(rgb, dark) >= contrastRatio(rgb, LIGHT_SURFACE) ? '#07101e' : '#ffffff';
}

/**
 * Adapt a preferred accent to a theme. Dark themes take it unchanged —
 * a light accent is exactly right on a near-black page, and users pick
 * their accent while looking at one.
 */
export function deriveAccent(preferred: string, theme: ResolvedTheme): DerivedAccent {
  const rgb = parseHex(preferred);
  if (!rgb) return { accent: preferred, onAccent: '#07101e' };
  if (theme !== 'light') {
    return { accent: toHex(rgb), onAccent: foregroundFor(rgb) };
  }
  const readable = darkenUntilReadable(rgb, LIGHT_SURFACE);
  return { accent: toHex(readable), onAccent: foregroundFor(readable) };
}
