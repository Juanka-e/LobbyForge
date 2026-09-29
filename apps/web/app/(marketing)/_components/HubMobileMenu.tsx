'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { isCurrent, type HubNavLink } from './HubNavLinks';
import { CloseIcon, MenuIcon, StarIcon } from './icons';
import { buttonOutline, buttonPrimary, focusRing } from './styles';

/**
 * The narrow-screen menu: a disclosure (WAI-ARIA APG) — a button with
 * `aria-expanded` that shows or hides the panel right after it in the
 * reading order. Escape closes it and returns focus to the button; so
 * do a click outside and following a link. It closes by itself when the
 * route changes, because "open" is remembered per page.
 */
export default function HubMobileMenu({
  links,
  label,
  signedIn,
  repoUrl,
  starLabel,
}: {
  links: HubNavLink[];
  /** The navigation landmark's name — the same as the desktop nav's. */
  label: string;
  signedIn: boolean;
  repoUrl: string;
  /** "Star on GitHub", with the live count when there is one. */
  starLabel: { text: string; count: string | null; countLabel: string | null };
}) {
  const t = useT();
  const pathname = usePathname();
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn !== null && openOn === pathname;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenOn(null);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpenOn(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const close = () => setOpenOn(null);

  return (
    <div ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpenOn(open ? null : pathname)}
        className={`flex size-11 items-center justify-center rounded-xl border border-border-subtle text-text-primary transition-colors hover:bg-surface-raised ${focusRing}`}
      >
        {open ? <CloseIcon size={20} /> : <MenuIcon size={20} />}
        <span className="sr-only">{t('hub.nav.menu')}</span>
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-border-subtle bg-background px-5 pb-6 pt-3 shadow-xl sm:px-8"
      >
        <nav aria-label={label}>
          <ul className="flex flex-col gap-1">
            {links.map((link) => {
              const current = isCurrent(link, pathname);
              const shape = `flex h-12 items-center rounded-xl px-3 text-base transition-colors ${
                current ? 'bg-surface-raised font-medium text-text-primary' : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
              } ${focusRing}`;
              return (
                <li key={link.href}>
                  {link.kind === 'internal' ? (
                    <Link href={link.href} aria-current={current ? 'page' : undefined} onClick={close} className={shape}>
                      {link.label}
                    </Link>
                  ) : (
                    <a href={link.href} onClick={close} className={shape}>
                      {link.label}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        {signedIn ? null : (
          <div className="mt-4 flex flex-col gap-3 border-t border-border-subtle/60 pt-4">
            <a href={repoUrl} onClick={close} className={`${buttonOutline} h-12 rounded-[14px] px-5 text-[15px]`}>
              <StarIcon className="text-ember" />
              {starLabel.text}
              {starLabel.count ? (
                <>
                  <span aria-hidden className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-semibold tabular-nums text-text-secondary">
                    {starLabel.count}
                  </span>
                  <span className="sr-only"> {starLabel.countLabel}</span>
                </>
              ) : null}
            </a>
            <Link href="/register" onClick={close} className={`${buttonPrimary} h-12 rounded-[14px] px-5 text-[15px]`}>
              {t('hub.nav.getStarted')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
