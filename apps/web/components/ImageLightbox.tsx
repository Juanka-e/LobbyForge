'use client';

import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n/client';
import { useFocusTrap } from '@/lib/use-focus-trap';

export interface ImageLightboxProps {
  open: boolean;
  /** The image to show. Nothing renders without one. */
  src: string | null;
  /** Says what the image is — "Ayşe's avatar". Also the dialog's name. */
  alt: string;
  onClose: () => void;
  /**
   * "Open original" target. Defaults to `src`; pass null to leave the link
   * out (for an image that has no address of its own).
   */
  originalHref?: string | null;
  /** Where focus returns on close (defaults to what was focused on open). */
  returnFocusTo?: HTMLElement | null;
}

/**
 * A full-screen image viewer: a dimmed backdrop, the image centred at up
 * to about 80 vmin with a short zoom-in (none under reduced motion), an
 * "Open original" link and a close button. Escape, a backdrop click or the
 * X close it; focus stays inside while it is open.
 *
 * Generic on purpose — profile avatars and banners use it today, chat
 * image attachments can tomorrow. It carries `data-profile-layer` so a
 * popover it was opened from does not treat a click in it as "outside".
 */
export function ImageLightbox({ open, src, alt, onClose, originalHref, returnFocusTo }: ImageLightboxProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const visible = open && Boolean(src);
  useFocusTrap(rootRef, { active: visible, onEscape: onClose, initialFocus: closeRef, returnFocusTo });

  if (!visible || typeof document === 'undefined') return null;
  const href = originalHref === undefined ? src : originalHref;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      data-profile-layer
      data-testid="image-lightbox"
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
    >
      {/* The scrim: dims whatever theme is behind it, and closes on a click. */}
      <div className="absolute inset-0 bg-black/80" aria-hidden onMouseDown={onClose} />
      <figure className="lf-zoom-in relative flex max-h-full max-w-full flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- user images come from the same-origin image route */}
        <img
          src={src!}
          alt={alt}
          className="max-h-[80vmin] max-w-[min(90vw,1200px)] rounded-lg object-contain shadow-2xl"
          draggable={false}
        />
        {href ? (
          <figcaption>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-white/90 underline-offset-2 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              {t('shell.lightbox.openOriginal')}
              <span className="material-symbols-outlined text-[16px]" aria-hidden>open_in_new</span>
            </a>
          </figcaption>
        ) : null}
      </figure>
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label={t('shell.lightbox.close')}
        className="absolute right-4 top-4 grid size-10 place-items-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
      >
        <span className="material-symbols-outlined text-[22px]" aria-hidden>close</span>
      </button>
    </div>,
    document.body
  );
}
