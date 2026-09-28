'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { initialsFor } from '@/lib/hub-format';
import { ChevronDownIcon } from './icons';
import { focusRing } from './styles';

/**
 * The signed-in hub's account button. A disclosure, like the mobile menu:
 * `aria-expanded` on the button, the panel next in the reading order,
 * Escape / outside click to close. Sign out ends the session with the
 * same endpoint the settings page uses, then goes to the sign-in page.
 */
export default function AccountMenu({ name }: { name: string }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [openOn, setOpenOn] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  async function signOut() {
    setSigningOut(true);
    setError(null);
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
    if (!response?.ok) {
      setError(t('hub.nav.account.signOutFailed'));
      setSigningOut(false);
      return;
    }
    router.replace('/login');
    router.refresh();
  }

  const itemClass = `flex h-11 w-full items-center rounded-xl px-3 text-left text-[15px] text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-wait disabled:opacity-60 ${focusRing}`;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('hub.nav.account.menu', { name })}
        onClick={() => setOpenOn(open ? null : pathname)}
        className={`flex h-11 items-center gap-2.5 rounded-full border border-border-subtle bg-surface py-0 pl-1.5 pr-1.5 text-sm text-text-primary transition-colors hover:bg-surface-raised sm:pr-3 ${focusRing}`}
      >
        <span aria-hidden className="flex size-8 items-center justify-center rounded-full bg-ember text-sm font-bold text-on-ember">
          {Array.from(initialsFor(name, t.locale))[0]}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:inline">{name}</span>
        <ChevronDownIcon size={14} className="hidden sm:block" />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-border-subtle bg-surface p-2 shadow-xl"
      >
        <p className="truncate px-3 pb-2 pt-1.5 text-xs text-text-muted">{t('hub.nav.account.signedInAs', { name })}</p>
        <ul className="flex flex-col gap-0.5">
          <li>
            <Link href="/settings" onClick={() => setOpenOn(null)} className={itemClass}>
              {t('hub.nav.account.settings')}
            </Link>
          </li>
          <li>
            <button type="button" onClick={signOut} disabled={signingOut} className={itemClass}>
              {signingOut ? t('hub.nav.account.signingOut') : t('hub.nav.account.signOut')}
            </button>
          </li>
        </ul>
        {error ? (
          <p role="alert" className="px-3 pb-1.5 pt-2 text-sm text-text-secondary">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
