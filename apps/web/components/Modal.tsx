'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: ModalSize;
  children: ReactNode;
  /** Optional footer; if omitted a default close affordance is not added. */
  footer?: ReactNode;
  /** Disable the close-on-Escape behavior (e.g. for blocking dialogs). */
  disableEscape?: boolean;
  /** Disable clicking the backdrop to close. */
  disableBackdropClose?: boolean;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
};

const TITLE_ID = 'modal-title';

/**
 * Calm Future modal shell.
 *
 * Renders into document.body via portal, locks body scroll while open,
 * closes on Escape + backdrop click, and traps focus to the panel.
 * Each modal content lives in its own component so this stays a
 * composable wrapper.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
  disableEscape = false,
  disableBackdropClose = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousActiveRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      previousActiveRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || disableEscape) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, disableEscape, onClose]);

  useEffect(() => {
    if (!open) return;
    const node = panelRef.current;
    if (!node) return;
    const focusable = node.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(event) => {
        if (disableBackdropClose) return;
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? TITLE_ID : undefined}
        className={`w-full ${SIZE_CLASS[size]} bg-surface-raised border border-border-strong rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 max-h-[90vh]`}
      >
        {(title || description) && (
          <header className="p-6 pb-4 flex items-start justify-between gap-4">
            <div>
              {title ? (
                <h2
                  id={TITLE_ID}
                  className="text-xl font-semibold text-text-primary tracking-tight"
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p className="text-sm text-text-muted mt-1">{description}</p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Close dialog"
              onClick={onClose}
              className="text-text-muted hover:text-text-primary p-1 rounded-full hover:bg-surface-variant transition-colors"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </header>
        )}
        <div className="px-6 py-2 overflow-y-auto flex-1">{children}</div>
        {footer ? (
          <footer className="p-6 pt-4 bg-surface-container-low/50 border-t border-border-subtle flex justify-end items-center gap-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

export function ModalCancelButton({
  onClick,
  children = 'Cancel',
  disabled = false,
}: {
  onClick: () => void;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-4 py-2 rounded-lg text-sm font-medium text-text-secondary border border-border-strong hover:bg-surface-variant hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

export function ModalPrimaryButton({
  onClick,
  children,
  disabled = false,
  loading = false,
  tone = 'primary',
  icon,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'primary' | 'danger';
  icon?: string;
}) {
  const className =
    tone === 'danger'
      ? 'px-5 py-2.5 rounded-lg bg-danger text-[#07101e] text-sm font-medium hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed'
      : 'px-5 py-2.5 rounded-lg bg-primary-container text-[#07101e] text-sm font-medium hover:brightness-110 shadow-[0_0_15px_rgba(143,184,255,0.15)] transition-all disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className={className}
    >
      <span className="inline-flex items-center gap-2">
        {icon ? <span className="material-symbols-outlined text-[18px]">{icon}</span> : null}
        {loading ? 'Working...' : children}
      </span>
    </button>
  );
}
