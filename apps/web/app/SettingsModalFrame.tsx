'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';

export default function SettingsModalFrame({ children, label }: { children: ReactNode; label: string }) {
  const router = useRouter();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => router.replace('/lobby'), [router]);

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
        aria-label="Close settings"
        title="Close settings"
      >
        <span className="material-symbols-outlined" aria-hidden>close</span>
      </button>
      {children}
    </div>
  );
}
