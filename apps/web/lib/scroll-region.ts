/**
 * Focus styling for a scrolling region that takes keyboard focus
 * (`tabIndex={0}`), as axe's `scrollable-region-focusable` asks: without
 * it, a region with nothing focusable inside cannot be scrolled from the
 * keyboard.
 *
 * The ring is drawn INSIDE the region — such regions usually fill a shell
 * with `overflow: hidden`, which would clip an outer ring — and only for
 * keyboard focus (`:focus-visible`), so a mouse click into the page shows
 * nothing.
 */
export const SCROLL_REGION_FOCUS_CLASS =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary';
