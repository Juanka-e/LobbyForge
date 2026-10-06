'use client';

import { useId, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useT } from '@/lib/i18n/client';
import {
  CODE_LENGTH,
  codeRefusalNotice,
  formatCountdown,
  normalizeCode,
  retryInstant,
  sendRefusalNotice,
  type Notice,
} from './email-status';
import { patchEmailStatus, refreshEmailStatus } from './email-status-store';
import { useCountdown } from './useCountdown';

export type ResendOutcome = { ok: true; resendAvailableAt: string | null } | { ok: false; notice: Notice; retryAt?: string | null };

/** How "Resend" works: the verify email, the caller's own (an email change), or none. */
export type ResendMode = 'verify' | (() => Promise<ResendOutcome>) | null;

type Feedback = (Notice & { tone: 'success' | 'error' }) | null;

const VERIFY_ENDPOINT = '/api/auth/email/verify';
const CHANGE_CONFIRM_ENDPOINT = '/api/auth/email/change/confirm';
const SEND_ENDPOINT = '/api/auth/email/verify/send';

/** Ask for a new verification email (`POST /api/auth/email/verify/send`). */
export async function resendVerificationEmail(): Promise<ResendOutcome> {
  let response: Response;
  try {
    response = await fetch(SEND_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch {
    return { ok: false, notice: { key: 'emailVerification.error.network' } };
  }
  const body = (await response.json().catch(() => ({}))) as { resendAvailableAt?: unknown; retryAfter?: unknown; error?: unknown };
  if (response.ok) {
    const at = typeof body.resendAvailableAt === 'string' ? body.resendAvailableAt : null;
    return { ok: true, resendAvailableAt: at };
  }
  return {
    ok: false,
    notice: sendRefusalNotice(response.status, body),
    retryAt: response.status === 429 ? retryInstant(body.retryAfter) : null,
  };
}

/**
 * The six-digit code from a verification (or email-change) email, with
 * "Resend" and a countdown. Used by the banner, the verify dialog and
 * Settings → My account. A link opened anywhere else does the same job;
 * the store's focus re-read then notices.
 */
export default function EmailCodeEntry({
  purpose,
  resend,
  resendAvailableAt = null,
  onConfirmed,
  inputRef,
  showLabel = false,
  extraActions,
  disabled = false,
}: {
  purpose: 'verify' | 'change';
  resend: ResendMode;
  /** When "Resend" opens again (the status's, or the caller's). */
  resendAvailableAt?: string | null;
  /** The server's answer to the code (an email change says whether other sessions were signed out). */
  onConfirmed?: (answer: Record<string, unknown>) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** A visible label above the field (the dialog, settings); the banner keeps it for screen readers. */
  showLabel?: boolean;
  /** Trailing actions in the same row (e.g. "Change email"). */
  extraActions?: ReactNode;
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // A 429 or a caller-run resend gives its own instant; the later one wins.
  const [localResendAt, setLocalResendAt] = useState<string | null>(null);
  const resendAt = later(resendAvailableAt, localResendAt);
  const remaining = useCountdown(resendAt);
  // Before the first tick (server render, hydration) an instant counts as
  // not yet reached; the effect settles it within the same frame.
  const waiting = remaining === null ? Boolean(resendAt) : remaining > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.length !== CODE_LENGTH || busy || disabled) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(purpose === 'verify' ? VERIFY_ENDPOINT : CHANGE_CONFIRM_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (response.ok) {
        const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        setCode('');
        setFeedback({
          tone: 'success',
          key: purpose === 'verify' ? 'emailVerification.code.verified' : 'emailVerification.change.confirmed',
        });
        await refreshEmailStatus();
        onConfirmed?.(answer);
        return;
      }
      const body: unknown = await response.json().catch(() => ({}));
      setFeedback({ tone: 'error', ...codeRefusalNotice(response.status, body) });
    } catch {
      setFeedback({ tone: 'error', key: 'emailVerification.error.network' });
    } finally {
      setBusy(false);
    }
  }

  async function runResend() {
    if (!resend || sending || waiting || disabled) return;
    setSending(true);
    setFeedback(null);
    const outcome = resend === 'verify' ? await resendVerificationEmail() : await resend();
    setSending(false);
    if (outcome.ok) {
      setLocalResendAt(outcome.resendAvailableAt);
      if (resend === 'verify') patchEmailStatus({ resendAvailableAt: outcome.resendAvailableAt });
      setFeedback({ tone: 'success', key: 'emailVerification.resend.sent' });
      return;
    }
    if (outcome.retryAt) setLocalResendAt(outcome.retryAt);
    if (outcome.notice.key === 'emailVerification.code.error.alreadyVerified') void refreshEmailStatus();
    setFeedback({ tone: 'error', ...outcome.notice });
  }

  const resendLabel = sending
    ? t('emailVerification.resend.sending')
    : waiting && remaining !== null
      ? t('emailVerification.resend.wait', { time: formatCountdown(remaining) })
      : t('emailVerification.resend.button');

  return (
    <div className="min-w-0">
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-code`} className={showLabel ? 'text-xs font-medium text-text-secondary' : 'sr-only'}>
            {t('emailVerification.code.label')}
          </label>
          <input
            id={`${id}-code`}
            ref={inputRef}
            value={code}
            onChange={(event) => {
              setCode(normalizeCode(event.target.value));
              if (feedback?.tone === 'error') setFeedback(null);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={CODE_LENGTH + 2}
            placeholder="000000"
            disabled={disabled}
            aria-invalid={feedback?.tone === 'error' ? true : undefined}
            aria-describedby={feedback ? `${id}-feedback` : undefined}
            className="h-10 w-[9.5rem] rounded-lg border border-border-strong bg-surface px-3 text-center font-mono text-base tracking-[0.35em] text-text-primary outline-none transition-colors placeholder:text-text-muted/70 focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={code.length !== CODE_LENGTH || busy || disabled}
          className="h-10 rounded-lg bg-primary-container px-4 text-sm font-semibold text-on-primary-container transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? t('emailVerification.code.checking') : t('emailVerification.code.submit')}
        </button>
        {resend ? (
          <button
            type="button"
            onClick={() => void runResend()}
            disabled={sending || waiting || disabled}
            className="h-10 rounded-lg px-3 text-sm font-medium tabular-nums text-primary transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:text-text-secondary disabled:hover:bg-transparent"
          >
            {resendLabel}
          </button>
        ) : null}
        {extraActions}
      </form>
      {feedback ? (
        <p
          id={`${id}-feedback`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={`mt-2 text-pretty text-sm ${feedback.tone === 'error' ? 'text-danger' : 'text-success'}`}
        >
          {t(feedback.key, feedback.params)}
        </p>
      ) : null}
    </div>
  );
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
