/**
 * Class strings shared by the hub's pages, so every button and link has
 * the same shape and the same visible keyboard focus. Sizes are added at
 * the call site (the design uses 40, 44, 48 and 52 px buttons).
 */

export const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

/** Accent-filled call to action. */
export const buttonPrimary = `inline-flex items-center justify-center gap-2 bg-primary font-semibold text-on-primary transition-[filter] hover:brightness-110 ${focusRing}`;

/** Outlined secondary action. */
export const buttonOutline = `inline-flex items-center justify-center gap-2 border border-border-strong font-medium text-text-primary transition-colors hover:bg-surface-raised ${focusRing}`;

/** A text link inside running copy or a card footer. */
export const textLink = `rounded-sm font-medium text-primary underline-offset-4 hover:underline ${focusRing}`;

/** The small uppercase label above a heading. */
export const eyebrow = 'text-xs font-medium uppercase tracking-[0.16em] sm:text-[13px] sm:tracking-[0.18em]';

/** Page-width container: 1240 px of content, the design's grid. */
export const container = 'mx-auto w-full max-w-[1240px] px-5 sm:px-8 xl:px-0';
