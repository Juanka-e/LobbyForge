'use client';

import { useRef } from 'react';
import { useT } from '@/lib/i18n/client';

/**
 * Keep the latest value of a prop in a ref, so long-lived widget listeners
 * call the current callback without being torn down on every render.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Resolve with `fallback` when `promise` has not settled after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/**
 * The placeholder a visible widget sits in while its script loads. It has
 * the widget's own height, so the form does not jump when it appears.
 */
export function ChallengeLoading({ minHeight }: { minHeight: number }) {
  const t = useT();
  return (
    <div
      role="status"
      style={{ minHeight }}
      className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 text-sm text-text-muted"
    >
      <span
        aria-hidden
        className="size-4 shrink-0 animate-spin rounded-full border-2 border-text-muted border-r-transparent motion-reduce:animate-none"
      />
      {t('captcha.challenge.loading')}
    </div>
  );
}

/**
 * A widget that could not load: say so, and offer a real retry. `blocked`
 * is the page's own policy refusing the provider (see `useCspBlocked`),
 * which only a reload of the page can fix.
 */
export function ChallengeLoadError({ onRetry, blocked = false }: { onRetry: () => void; blocked?: boolean }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm text-text-primary"
    >
      <span className="min-w-0 flex-1 text-pretty">
        {t(blocked ? 'captcha.challenge.blocked' : 'captcha.challenge.loadFailed')}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {t(blocked ? 'captcha.challenge.reloadPage' : 'captcha.challenge.retry')}
      </button>
    </div>
  );
}

/** Start over with a fresh document (and so this page's own CSP). */
export function reloadPage(): void {
  window.location.reload();
}
