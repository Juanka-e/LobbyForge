'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keep keyboard focus inside one dialog layer (the profile card, the full
 * profile, the image viewer, a confirmation) and hand it back on close.
 *
 * The listeners sit on `document` and act only on events whose target is
 * INSIDE this layer's DOM node. Layers are portalled side by side under
 * <body>, so a viewer opened from the card handles its own keys and the
 * card never sees them; and because React delivers its own handlers on
 * the portal container first, a menu inside a layer can stop an Escape
 * (`stopPropagation`) before the layer closes.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable elements inside `root`, in DOM order (hidden and inert subtrees excluded). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.closest('[hidden], [inert], [aria-hidden="true"]')
  );
}

export interface FocusTrapOptions {
  active: boolean;
  /** Escape inside the layer. */
  onEscape?: () => void;
  /** Focused on open; else the first focusable element, else the layer itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Where focus goes on close. Defaults to whatever was focused when the
   * layer opened. Only applied when focus is still inside the layer (or
   * nowhere) — a click elsewhere keeps what it focused.
   */
  returnFocusTo?: HTMLElement | null;
  /** A change starts a new opening (the same layer now shows someone else). */
  resetKey?: string;
}

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, options: FocusTrapOptions): void {
  const { active, initialFocus, returnFocusTo, resetKey } = options;
  const onEscapeRef = useRef(options.onEscape);
  onEscapeRef.current = options.onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const previous = (returnFocusTo ?? (document.activeElement as HTMLElement | null)) || null;

    const target = initialFocus?.current ?? focusableWithin(container)[0] ?? container;
    if (target === container && !container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    // A layer that is still being placed may not take focus yet: try once more on the next frame.
    const retry =
      document.activeElement === target || typeof requestAnimationFrame === 'undefined'
        ? null
        : requestAnimationFrame(() => {
            if (container.isConnected && !container.contains(document.activeElement)) target.focus({ preventScroll: true });
          });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const inside = event.target instanceof Node && container.contains(event.target);
      if (!inside) return;
      if (event.key === 'Escape') {
        if (!onEscapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableWithin(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      if (retry !== null) cancelAnimationFrame(retry);
      document.removeEventListener('keydown', onKeyDown);
      const focused = document.activeElement;
      const focusLeftWithLayer = !focused || focused === document.body || container.contains(focused);
      if (focusLeftWithLayer && previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // `initialFocus` and `returnFocusTo` are read once per opening on purpose.
  }, [active, containerRef, resetKey]);
}
