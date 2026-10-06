'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useT } from '@/lib/i18n/client';
import { MIN_PASSWORD_LENGTH } from '@/lib/password-strength';
import { authFlowStyles } from '@/app/login/auth-flow-styles';
import PasswordField from '@/app/login/_official/PasswordField';
import PasswordStrengthMeter from '@/app/login/_official/PasswordStrengthMeter';
import { CODE_LENGTH, normalizeCode } from '@/components/email-verification/email-status';
import { forgetResetEmail, recallResetEmail } from '@/components/email-verification/reset-email';

type Mode = 'link' | 'code';

/**
 * Why a reset was refused, as a message key — the route answers with codes.
 *
 * By code, the route says only `invalid_code` whatever went wrong (wrong,
 * expired, too many tries, no such account): saying which would tell a
 * stranger something about the address. So the code path has one message.
 * The link path keeps its own (invalid or expired link).
 */
export function resetErrorKey(httpStatus: number, body: unknown, mode: 'link' | 'code' = 'link'): string {
  const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
  if (httpStatus === 429) return 'emailVerification.error.rateLimited';
  if (httpStatus === 503) return 'emailVerification.forgot.unavailable';
  if (code === 'invalid_password' || code === 'weak_password' || code === 'password_too_short') {
    return 'emailVerification.reset.error.password';
  }
  if (mode === 'code') {
    return code === 'invalid_code' || code === 'expired' || code === 'too_many_attempts' || code === 'invalid_request'
      ? 'emailVerification.reset.error.codeFailed'
      : 'emailVerification.reset.failed';
  }
  if (code === 'invalid_token') return 'emailVerification.reset.error.invalidToken';
  if (code === 'expired') return 'emailVerification.reset.error.expired';
  return 'emailVerification.reset.failed';
}

/** The refusals after which only a new email helps. */
const NEEDS_NEW_EMAIL = new Set([
  'emailVerification.reset.error.invalidToken',
  'emailVerification.reset.error.expired',
  'emailVerification.reset.error.codeFailed',
]);

/**
 * `/reset-password`: a new password (the sign-up's rule and meter), with
 * the link's token — or the address and the code from the email instead.
 * A successful reset signs every device out (EMAIL.md §4.3), so it ends
 * at sign-in.
 */
export default function ResetPasswordForm({ token, official }: { token: string | null; official: boolean }) {
  const t = useT();
  const ids = useId();
  const styles = authFlowStyles(official);
  const [mode, setMode] = useState<Mode>(token ? 'link' : 'code');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [sessionsKept, setSessionsKept] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const doneHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // The address /forgot-password just sent to, for the code form.
  useEffect(() => {
    const remembered = recallResetEmail();
    if (remembered) setEmail((current) => current || remembered);
  }, []);

  useEffect(() => {
    if (done) doneHeadingRef.current?.focus();
  }, [done]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.reportValidity();
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorKey('emailVerification.reset.error.password');
      return;
    }
    if (mode === 'code' && code.length !== CODE_LENGTH) {
      setErrorKey('emailVerification.reset.error.codeFailed');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    const payload =
      mode === 'link' && token
        ? { token, newPassword: password }
        : { email: email.trim(), code, newPassword: password };
    try {
      const response = await fetch('/api/auth/password/reset', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { warning?: unknown };
        forgetResetEmail();
        setPassword('');
        // The password changed, but other sessions could not be signed out.
        setSessionsKept(body.warning === 'sessions_not_revoked');
        setDone(true);
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      setErrorKey(resetErrorKey(response.status, body, mode === 'link' && token ? 'link' : 'code'));
    } catch {
      setErrorKey('emailVerification.error.network');
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setErrorKey(null);
  }

  if (done) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="material-symbols-outlined text-[32px] text-success" aria-hidden>
            check_circle
          </span>
          <h1 ref={doneHeadingRef} tabIndex={-1} className={`${styles.title} outline-none`}>
            {t('emailVerification.reset.doneTitle')}
          </h1>
          <p role="status" className={styles.lead}>
            {t(sessionsKept ? 'emailVerification.reset.doneBodySessionsKept' : 'emailVerification.reset.doneBody')}
          </p>
        </div>
        <Link href="/login" className={styles.submit}>
          {t('auth.login.signIn')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className={styles.title}>{t('emailVerification.reset.title')}</h1>
        <p className={styles.lead}>
          {t(mode === 'link' ? 'emailVerification.reset.leadLink' : 'emailVerification.reset.leadCode')}
        </p>
      </div>

      {errorKey ? (
        <div role="alert" className={styles.alert}>
          <p>{t(errorKey)}</p>
          {NEEDS_NEW_EMAIL.has(errorKey) ? (
            <p className="mt-1">
              <Link href="/forgot-password" className={styles.link}>
                {t('emailVerification.reset.requestNew')}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={submit} aria-busy={busy} noValidate className="flex flex-col gap-5">
        {mode === 'code' ? (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor={`${ids}-email`} className={styles.label}>
                {t('auth.login.email')}
              </label>
              <input
                id={`${ids}-email`}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                maxLength={254}
                autoComplete="email"
                placeholder={t('auth.official.emailPlaceholder')}
                className={styles.input}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor={`${ids}-code`} className={styles.label}>
                {t('emailVerification.code.label')}
              </label>
              <input
                id={`${ids}-code`}
                value={code}
                onChange={(event) => setCode(normalizeCode(event.target.value))}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={CODE_LENGTH + 2}
                placeholder="000000"
                className={`${styles.input} font-mono tracking-[0.35em]`}
              />
            </div>
          </>
        ) : null}

        <PasswordField
          id={`${ids}-password`}
          label={t('emailVerification.reset.newPassword')}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          placeholder={t('auth.login.passwordPlaceholderNew')}
          minLength={MIN_PASSWORD_LENGTH}
          describedBy={`${ids}-strength`}
          inputClassName={styles.input}
          labelClassName={styles.label}
        >
          <PasswordStrengthMeter id={`${ids}-strength`} password={password} />
        </PasswordField>

        <button type="submit" disabled={busy} className={styles.submit}>
          {busy ? t('auth.login.pleaseWait') : t('emailVerification.reset.submit')}
        </button>
      </form>

      <div className="flex flex-col items-center gap-2 text-center text-sm text-text-secondary">
        {mode === 'link' ? (
          <button type="button" onClick={() => switchMode('code')} className={styles.link}>
            {t('emailVerification.reset.useCode')}
          </button>
        ) : token ? (
          <button type="button" onClick={() => switchMode('link')} className={styles.link}>
            {t('emailVerification.reset.useLink')}
          </button>
        ) : (
          <Link href="/forgot-password" className={styles.link}>
            {t('emailVerification.reset.requestNew')}
          </Link>
        )}
        <Link href="/login" className={styles.link}>
          {t('emailVerification.forgot.backToSignIn')}
        </Link>
      </div>
    </div>
  );
}
