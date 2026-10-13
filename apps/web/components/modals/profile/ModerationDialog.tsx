'use client';

import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n/client';
import { useFocusTrap } from '@/lib/use-focus-trap';

export type ModerationKind = 'timeout' | 'untimeout' | 'kick' | 'ban';

/**
 * Timeout lengths — Discord's own set, inside the route's 28-day cap.
 * The admin Members page has no timeout control to copy from.
 */
export const TIMEOUT_DURATIONS = [
  { id: '60s', ms: 60_000, unit: 'seconds', count: 60 },
  { id: '5m', ms: 5 * 60_000, unit: 'minutes', count: 5 },
  { id: '10m', ms: 10 * 60_000, unit: 'minutes', count: 10 },
  { id: '1h', ms: 60 * 60_000, unit: 'hours', count: 1 },
  { id: '1d', ms: 24 * 60 * 60_000, unit: 'days', count: 1 },
  { id: '1w', ms: 7 * 24 * 60 * 60_000, unit: 'weeks', count: 1 },
] as const;

export type TimeoutDurationId = (typeof TIMEOUT_DURATIONS)[number]['id'];

/** The ban route accepts a reason of up to 512 characters (as the admin page's prompt sends). */
export const BAN_REASON_MAX = 512;

export interface ModerationRequest {
  kind: ModerationKind;
  durationMs?: number;
  reason?: string;
}

/**
 * The confirmation before a moderation action from a profile: Timeout (with
 * a length), Remove timeout, Kick, or Ban (with an optional reason, like
 * the admin Members page). The route's refusal is shown inside the dialog.
 */
export function ModerationDialog({
  kind,
  name,
  onCancel,
  onConfirm,
}: {
  kind: ModerationKind;
  name: string;
  onCancel: () => void;
  /** Resolves to an error message to show, or null when it worked. */
  onConfirm: (request: ModerationRequest) => Promise<string | null>;
}) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [duration, setDuration] = useState<TimeoutDurationId>('10m');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFocusTrap(rootRef, { active: true, onEscape: busy ? undefined : onCancel, initialFocus: cancelRef });

  const title = t(`shell.profile.moderation.${kind}.title`, { name });
  const description = t(`shell.profile.moderation.${kind}.description`, { name });
  const confirmLabel = t(`shell.profile.moderation.${kind}.confirm`);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const request: ModerationRequest =
      kind === 'timeout'
        ? { kind, durationMs: TIMEOUT_DURATIONS.find((option) => option.id === duration)!.ms }
        : kind === 'ban'
          ? { kind, reason: reason.trim() || undefined }
          : { kind };
    const failure = await onConfirm(request);
    // On success the parent closes the dialog; on failure it stays open with the reason.
    setBusy(false);
    if (failure) setError(failure);
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" data-profile-layer>
      <div className="absolute inset-0 bg-black/60" aria-hidden onMouseDown={busy ? undefined : onCancel} />
      <div
        ref={rootRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="lf-pop-in relative w-full max-w-sm rounded-xl border border-border-subtle bg-surface-raised p-5 shadow-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-text-primary">
          {title}
        </h2>
        <p id={descriptionId} className="mt-1.5 text-sm leading-5 text-text-secondary">
          {description}
        </p>

        {kind === 'timeout' ? (
          <fieldset className="mt-4">
            <legend className="mb-2 text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              {t('shell.profile.moderation.timeout.duration')}
            </legend>
            <div className="grid grid-cols-2 gap-1.5">
              {TIMEOUT_DURATIONS.map((option) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors ${
                    duration === option.id
                      ? 'border-primary bg-primary/10 text-text-primary'
                      : 'border-border-subtle text-text-secondary hover:bg-surface-container'
                  }`}
                >
                  <input
                    type="radio"
                    name={`${titleId}-duration`}
                    value={option.id}
                    checked={duration === option.id}
                    onChange={() => setDuration(option.id)}
                    className="size-3.5 border-border-subtle bg-transparent text-primary focus:ring-primary"
                  />
                  {t(`shell.profile.duration.${option.unit}`, { count: option.count })}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {kind === 'ban' ? (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              {t('shell.profile.moderation.ban.reason')}
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={BAN_REASON_MAX}
              rows={3}
              placeholder={t('shell.profile.moderation.ban.reasonPlaceholder')}
              className="w-full resize-none rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className={`rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 ${
              kind === 'untimeout'
                ? 'bg-primary text-on-primary focus-visible:outline-primary'
                : // The page colour on danger reads 6:1 or better in every theme.
                  'bg-danger text-background focus-visible:outline-danger'
            }`}
          >
            {busy ? t('shell.modal.working') : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
