'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useT } from '@/lib/i18n/client';
import EmailCodeEntry, { type ResendOutcome } from '@/components/email-verification/EmailCodeEntry';
import { formatCountdown, needsVerification, retryInstant, sendRefusalNotice } from '@/components/email-verification/email-status';
import { useCountdown } from '@/components/email-verification/useCountdown';
import { refreshEmailStatus, useEmailStatus } from '@/components/email-verification/email-status-store';

const CHANGE_ENDPOINT = '/api/auth/email/change';

/** Why an email change was refused, as a message key (EMAIL.md §4.3). */
export function changeErrorKey(httpStatus: number, body: unknown): string {
  const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
  if (code === 'invalid_password') return 'emailVerification.change.error.password';
  if (code === 'invalid_email') return 'emailVerification.change.error.email';
  if (code === 'email_taken') return 'emailVerification.change.error.taken';
  if (code === 'disposable_email') return 'emailVerification.change.error.disposable';
  if (httpStatus === 429 || httpStatus === 503) return sendRefusalNotice(httpStatus, body).key;
  return 'emailVerification.change.error.generic';
}

type ChangeResult =
  | { kind: 'changed' }
  | { kind: 'pending' }
  | { kind: 'error'; key: string; retryAt: string | null };

async function postChange(newEmail: string, currentPassword: string): Promise<ChangeResult> {
  let response: Response;
  try {
    response = await fetch(CHANGE_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newEmail, currentPassword }),
    });
  } catch {
    return { kind: 'error', key: 'emailVerification.error.network', retryAt: null };
  }
  const body = (await response.json().catch(() => ({}))) as { changed?: unknown; pending?: unknown; retryAfter?: unknown };
  if (response.ok) return body.pending === true || response.status === 202 ? { kind: 'pending' } : { kind: 'changed' };
  return {
    kind: 'error',
    key: changeErrorKey(response.status, body),
    retryAt: response.status === 429 ? retryInstant(body.retryAfter) : null,
  };
}

/**
 * Settings → My account → Email: the address, whether it is verified, the
 * code entry while it is not, and "Change email" (current password + the
 * new address). With mail set up the change waits for the code sent to
 * the new inbox; with no mail and verification off it is immediate.
 */
export default function AccountEmailSection({ email }: { email: string | null }) {
  const t = useT();
  const router = useRouter();
  const ids = useId();
  const { status, loaded } = useEmailStatus();
  const [editing, setEditing] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // A rate limit says when the next try is allowed: count down to it.
  const [retryAt, setRetryAt] = useState<string | null>(null);
  const retryIn = useCountdown(errorKey === 'emailVerification.error.rateLimited' ? retryAt : null);
  const waitingToRetry = retryIn === null ? Boolean(retryAt) && errorKey === 'emailVerification.error.rateLimited' : retryIn > 0;
  const [notice, setNotice] = useState<string | null>(null);
  // What the last change sent, kept while this page is open so "Resend"
  // can ask again without retyping the password.
  const lastChange = useRef<{ newEmail: string; password: string } | null>(null);
  const [changeResendAt, setChangeResendAt] = useState<string | null>(null);

  const current = status?.email ?? email;
  const verified = status?.verified ?? false;
  const asksForVerification = status && needsVerification(status) ? status : null;
  const pendingChange = status?.pendingChange ?? null;
  // No mail and verification off: the server changes the address at once.
  const direct = status ? status.mode === 'off' && !status.mailConfigured : false;

  function openEditor() {
    setEditing(true);
    setErrorKey(null);
    setNotice(null);
    setNewEmail(pendingChange ?? '');
    setPassword('');
  }

  async function submitChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.reportValidity();
      return;
    }
    const address = newEmail.trim();
    if (current && address.toLowerCase() === current.toLowerCase()) {
      setErrorKey('emailVerification.change.error.same');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    setRetryAt(null);
    const result = await postChange(address, password);
    setBusy(false);
    if (result.kind === 'error') {
      setErrorKey(result.key);
      setRetryAt(result.retryAt);
      return;
    }
    setEditing(false);
    setPassword('');
    if (result.kind === 'changed') {
      lastChange.current = null;
      setNotice(t('emailVerification.change.changed', { email: address }));
      await refreshEmailStatus();
      router.refresh();
      return;
    }
    lastChange.current = { newEmail: address, password };
    setChangeResendAt(null);
    await refreshEmailStatus();
  }

  async function resendChange(): Promise<ResendOutcome> {
    const last = lastChange.current;
    if (!last) return { ok: false, notice: { key: 'emailVerification.change.error.resendNeedsPassword' } };
    const result = await postChange(last.newEmail, last.password);
    if (result.kind === 'error') return { ok: false, notice: { key: result.key }, retryAt: result.retryAt };
    // The server answers with no cooldown instant for a change: hold "Resend" for the documented 60 s.
    const at = new Date(Date.now() + 60_000).toISOString();
    setChangeResendAt(at);
    return { ok: true, resendAvailableAt: at };
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">{t('settings.account.identity.email')}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
            <span className="break-all">{current ?? t('settings.account.identity.emailNotSet')}</span>
            {/* "Not verified" means nothing while the instance does not ask. */}
            {current && loaded && status && (verified || status.mode !== 'off') ? (
              verified ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs font-medium text-text-primary">
                  <span className="material-symbols-outlined text-[14px] text-success" aria-hidden>
                    verified
                  </span>
                  {t('emailVerification.state.verified')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-ember/40 bg-ember/10 px-2 py-0.5 text-xs font-medium text-text-primary">
                  <span className="material-symbols-outlined text-[14px] text-ember" aria-hidden>
                    mark_email_unread
                  </span>
                  {t('emailVerification.state.unverified')}
                </span>
              )
            ) : null}
          </p>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={openEditor}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('emailVerification.action.changeEmail')}
          </button>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="flex items-start gap-2 text-sm text-text-primary">
          <span className="material-symbols-outlined text-[18px] text-success" aria-hidden>
            check_circle
          </span>
          <span>{notice}</span>
        </p>
      ) : null}

      {pendingChange && !editing ? (
        <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/10 p-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('emailVerification.change.pendingTitle')}</h3>
            <p className="mt-0.5 text-pretty text-sm text-text-secondary">
              {t('emailVerification.change.pendingBody', { email: pendingChange })}
            </p>
          </div>
          <EmailCodeEntry
            purpose="change"
            resend={lastChange.current ? resendChange : null}
            resendAvailableAt={changeResendAt}
            showLabel
            onConfirmed={(answer) => {
              lastChange.current = null;
              setNotice(
                t(
                  answer.warning === 'sessions_not_revoked'
                    ? 'emailVerification.change.confirmedNoticeSessionsKept'
                    : 'emailVerification.change.confirmedNotice',
                  { email: pendingChange }
                )
              );
              router.refresh();
            }}
            extraActions={
              lastChange.current ? null : (
                <button
                  type="button"
                  onClick={openEditor}
                  className="h-10 rounded-lg px-3 text-sm font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {t('emailVerification.change.sendAgain')}
                </button>
              )
            }
          />
        </div>
      ) : null}

      {asksForVerification && !pendingChange && !editing ? (
        <div className="space-y-3 rounded-lg border border-ember/40 bg-ember/10 p-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {t(asksForVerification.restricted ? 'emailVerification.banner.titleRestricted' : 'emailVerification.banner.title')}
            </h3>
            <p className="mt-0.5 text-pretty text-sm text-text-secondary">
              {t('emailVerification.banner.body', { email: asksForVerification.email ?? '' })}
            </p>
            {!asksForVerification.mailConfigured ? (
              <p className="mt-1 text-pretty text-sm text-text-secondary">{t('emailVerification.banner.mailOff')}</p>
            ) : null}
          </div>
          <EmailCodeEntry
            purpose="verify"
            resend={asksForVerification.mailConfigured ? 'verify' : null}
            resendAvailableAt={asksForVerification.resendAvailableAt}
            showLabel
          />
        </div>
      ) : null}

      {editing ? (
        <form onSubmit={submitChange} noValidate className="space-y-4 rounded-lg border border-border-subtle bg-surface-container/40 p-4">
          <h3 className="text-sm font-semibold text-text-primary">{t('emailVerification.change.title')}</h3>
          <p className="text-pretty text-sm text-text-secondary">
            {t(direct ? 'emailVerification.change.leadDirect' : 'emailVerification.change.leadConfirm')}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={`${ids}-new-email`} className="mb-1.5 block text-xs text-text-muted">
                {t('emailVerification.change.newEmail')}
              </label>
              <input
                id={`${ids}-new-email`}
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                required
                maxLength={254}
                autoComplete="email"
                className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={`${ids}-password`} className="mb-1.5 block text-xs text-text-muted">
                {t('emailVerification.change.currentPassword')}
              </label>
              <input
                id={`${ids}-password`}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                maxLength={128}
                autoComplete="current-password"
                className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
              />
            </div>
          </div>
          {errorKey === 'emailVerification.error.rateLimited' && retryAt ? (
            // Once the wait is over the line says so, and the button opens again.
            <p role="alert" className="text-pretty text-sm tabular-nums text-danger">
              {waitingToRetry && retryIn !== null
                ? t('emailVerification.error.rateLimitedWait', { time: formatCountdown(retryIn) })
                : waitingToRetry
                  ? t(errorKey)
                  : t('emailVerification.error.rateLimitOver')}
            </p>
          ) : errorKey ? (
            <p role="alert" className="text-pretty text-sm text-danger">
              {t(errorKey)}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setErrorKey(null);
                setPassword('');
              }}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy || waitingToRetry}
              className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? t('auth.login.pleaseWait') : t(direct ? 'emailVerification.change.submitDirect' : 'emailVerification.change.submit')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
