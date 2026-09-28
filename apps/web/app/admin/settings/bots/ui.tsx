'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Small building blocks for the Bots settings page, in the look of the
 * other Community Settings pages (sections on `bg-surface`, themed tokens
 * only, accent switches).
 */

export function Section({
  title,
  icon,
  intro,
  children,
}: {
  title: string;
  icon: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-2 flex items-center gap-2 border-b border-border-subtle pb-2 text-lg font-semibold text-text-primary">
        <span className="material-symbols-outlined text-primary" aria-hidden>{icon}</span>
        {title}
      </h2>
      {intro ? <p className="mb-4 text-sm text-text-secondary">{intro}</p> : null}
      {children}
    </section>
  );
}

export function Card({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <div data-testid={testId} className={`rounded-xl border border-border-subtle bg-surface p-5 ${className}`}>
      {children}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Accessible name — the switch has no visible text of its own. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 flex-none rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-surface-container-high'
      }`}
    >
      <span
        className={`absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-all ${
          checked ? 'right-1 bg-on-primary' : 'left-1 bg-text-muted'
        }`}
      />
    </button>
  );
}

export function Alert({ tone, children }: { tone: 'success' | 'danger' | 'info'; children: ReactNode }) {
  const toneClass =
    tone === 'success'
      ? 'border-success/40 bg-success/10 text-text-primary'
      : tone === 'danger'
        ? 'border-danger/40 bg-danger/10 text-danger'
        : 'border-border-subtle bg-surface-container/50 text-text-secondary';
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`mb-4 rounded-lg border p-3 text-sm ${toneClass}`}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: (id: string, hintId: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="block">
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </label>
      {children(id, hintId)}
      {hint ? (
        <p id={hintId} className="mt-1.5 text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';

export const primaryButtonClass =
  'rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50';

export const secondaryButtonClass =
  'rounded-md border border-border-strong px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

export const dangerButtonClass =
  'rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40';

/** A modal dialog: labelled, Escape closes, focus moves in and returns. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = panel.current?.querySelector<HTMLElement>('[data-autofocus], button, input, textarea, select');
    focusable?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Handled here: the settings frame underneath must not close too.
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-xl border border-border-subtle bg-surface p-5 shadow-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-text-primary">
          {title}
        </h2>
        <div className="mt-2 text-sm text-text-secondary">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}
