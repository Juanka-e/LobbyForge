/**
 * Answer swatches — one per letter, as in the design. They are FILLS with
 * dark text on top (7:1 or better on every one), so they read the same on
 * the dark, dim and light themes. Colour is never the only cue: every
 * swatch carries its letter.
 */
export const OPTION_SWATCHES = ['#FF8F80', '#6FB1FF', '#F5C451', '#5FD3A5', '#C9B6FF', '#F59BC8'] as const;

export const ON_SWATCH = '#07101E';

export function optionSwatch(index: number): string {
  return OPTION_SWATCHES[index % OPTION_SWATCHES.length]!;
}

export const MONO_FONT = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const DISPLAY_FONT = "'Bricolage Grotesque', inherit";

/** Visually hidden but read by screen readers. */
export const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;
