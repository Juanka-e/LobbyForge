'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import { SETTINGS_RETURN_KEY, settingsCloseTarget } from '@/lib/settings-return';

/**
 * Where closing goes: the lobby on a self-hosted instance; on the official
 * hub, the page the visitor came from (or the hub home) — see
 * lib/settings-return.ts. Read at close time, so it is always current.
 */
function closeTarget(): string {
  const official = document.documentElement.dataset.lfDeployment === 'official';
  let remembered: string | null = null;
  try {
    remembered = window.sessionStorage.getItem(SETTINGS_RETURN_KEY);
  } catch {
    remembered = null;
  }
  return settingsCloseTarget({ official, remembered });
}

export default function SettingsModalFrame({ children, label }: { children: ReactNode; label: string }) {
  const t = useT();
  const router = useRouter();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // A validated same-origin path (settingsCloseTarget), so the cast only
  // tells typed routes what the checks already guarantee.
  const close = useCallback(() => router.replace(closeTarget() as Route), [router]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const openDialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (openDialogs.length > 1) return;
      event.preventDefault();
      close();
    };

    window.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-50 h-dvh overflow-hidden bg-background"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={close}
        className="absolute right-3 top-3 z-10 grid size-10 place-items-center rounded-md border border-border-subtle bg-surface text-text-secondary shadow-sm transition-colors hover:bg-surface-container hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:right-5"
        aria-label={t('settings.frame.close')}
        title={t('settings.frame.close')}
      >
        <span className="material-symbols-outlined" aria-hidden>close</span>
      </button>
      {children}
    </div>
  );
}
