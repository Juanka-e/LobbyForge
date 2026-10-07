'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';

/**
 * The lobby's navigation — the community rail and the channel sidebar —
 * as a slide-in drawer on phones, and unchanged in place from `md` up.
 *
 * Below `md` a menu button opens the drawer as a modal dialog: focus moves
 * into it and stays there, Escape or the backdrop closes it, and focus
 * goes back to the menu button. Picking a destination closes it too: a
 * link, or any control marked `data-mobile-nav-close` (a channel, a DM,
 * the activities entry). While closed on a phone the drawer is
 * `visibility: hidden`, so its off-screen controls are out of the tab
 * order and the accessibility tree.
 *
 * Usage: wrap the <ServerRail> + <Sidebar> in <MobileNav>. The menu button
 * is fixed at the top left below `md`, so a centre-column header keeps
 * `pl-16 md:pl-6` (see LobbyMainArea's ChannelHeader) to stay clear of it.
 */

/** The Tailwind `md` breakpoint (tailwind.config.ts uses the defaults). */
export const MOBILE_NAV_DESKTOP_QUERY = '(min-width: 768px)';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function MobileNav({ children }: { children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  const close = useCallback(() => setOpen(false), []);

  // Opening moves focus into the drawer; closing hands it back to the
  // menu button (only after an open, never on the first render).
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const first = drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // Growing past the breakpoint turns the drawer back into the static
  // sidebar: a dialog left "open" there would trap focus for nothing.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_NAV_DESKTOP_QUERY);
    if (query.matches) {
      setOpen(false);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [open]);

  function onDrawerClick(event: MouseEvent<HTMLDivElement>) {
    if (!open) return;
    const target = event.target as Element | null;
    if (target?.closest('a[href], [data-mobile-nav-close]')) close();
  }

  function onDrawerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    const drawer = drawerRef.current;
    // Menus portalled out of the drawer bubble their keys here too; they
    // handle their own Escape and Tab.
    if (!drawer || !drawer.contains(document.activeElement)) return;
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.closest('[hidden], [aria-hidden="true"]')
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      {/* The menu button (below md only). */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 w-10 h-10 rounded-lg bg-surface-raised border border-border-subtle flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={t('lobby.nav.open')}
        aria-expanded={open}
        aria-controls={drawerId}
      >
        <span className="material-symbols-outlined text-[20px]" aria-hidden>menu</span>
      </button>

      {/* Backdrop */}
      {open ? (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={close}
          aria-hidden
          data-testid="mobile-nav-backdrop"
        />
      ) : null}

      {/* The drawer: off-canvas and hidden on phones until opened, static from md up. */}
      <div
        ref={drawerRef}
        id={drawerId}
        data-testid="mobile-nav-drawer"
        data-open={open ? 'true' : 'false'}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? t('lobby.nav.label') : undefined}
        onClick={onDrawerClick}
        onKeyDown={onDrawerKeyDown}
        // Visibility is transitioned only on the way out (it stays visible
        // while the drawer slides away). On the way in it must flip at
        // once: a `hidden → visible` transition is still `hidden` on its
        // first frame, and the browser refuses to focus into it.
        className={`fixed md:static inset-y-0 left-0 z-50 flex max-w-[calc(100vw-3rem)] md:max-w-none duration-200 md:visible md:translate-x-0 ${
          open
            ? 'visible translate-x-0 transition-transform shadow-2xl md:shadow-none'
            : 'invisible -translate-x-full transition-[transform,visibility]'
        }`}
      >
        {children}
        {open ? (
          <button
            type="button"
            onClick={close}
            className="md:hidden absolute top-3 left-full ml-2 w-10 h-10 rounded-lg bg-surface-raised border border-border-subtle flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            aria-label={t('lobby.nav.close')}
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden>close</span>
          </button>
        ) : null}
      </div>
    </>
  );
}
