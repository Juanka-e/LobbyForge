'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CaptchaField } from '@/components/captcha/CaptchaField';
import { reportFormValidity } from '@/components/captcha/form-validity';
import { useCaptchaGate } from '@/components/captcha/useCaptchaGate';
import { useT } from '@/lib/i18n/client';
import { authFlowStyles } from '@/app/login/auth-flow-styles';
import { rememberResetEmail } from '@/components/email-verification/reset-email';

type Phase = 'form' | 'sent' | 'unavailable';

/** Where an answer leaves the page. Every account-or-not answer is the same 202. */
export function forgotOutcome(
  httpStatus: number,
  body: Record<string, unknown>
): { phase: Phase } | { error: string } {
  if (httpStatus >= 200 && httpStatus < 300) return { phase: 'sent' };
  if (httpStatus === 503 && body.error === 'mail_quota') return { error: 'emailVerification.error.mailQuota' };
  if (httpStatus === 503) return { phase: 'unavailable' };
  if (httpStatus === 429) return { error: 'emailVerification.error.rateLimited' };
  if (body.error === 'invalid_email') return { error: 'emailVerification.change.error.email' };
  return { error: 'emailVerification.forgot.failed' };
}

/**
 * `/forgot-password`: an email address and the `password_reset` bot check
 * (docs/CAPTCHA.md). The answer never says whether an account exists —
 * the page says the same "if an account exists" sentence either way.
 */
export default function ForgotPasswordForm({ official }: { official: boolean }) {
  const t = useT();
  const ids = useId();
  const styles = authFlowStyles(official);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const gate = useCaptchaGate({ surface: 'password_reset' });

  useEffect(() => {
    if (phase !== 'form') headingRef.current?.focus();
  }, [phase]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // noValidate: the captcha checkbox must not block the send (form-validity.ts).
    if (!reportFormValidity(event.currentTarget)) return;
    const address = email.trim();
    setBusy(true);
    setError(null);
    const result = await gate.submit((fields) =>
      fetch('/api/auth/password/forgot', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, ...fields }),
      })
    );
    setBusy(false);
    if (result.kind !== 'response') {
      setError(t(result.kind === 'blocked' ? result.messageKey : 'emailVerification.error.network'));
      return;
    }
    const outcome = forgotOutcome(result.response.status, result.body);
    if ('error' in outcome) {
      setError(t(outcome.error));
      return;
    }
    if (outcome.phase === 'sent') {
      rememberResetEmail(address);
      setSentTo(address);
    }
    setPhase(outcome.phase);
  }

  if (phase === 'unavailable') {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h1 ref={headingRef} tabIndex={-1} className={`${styles.title} outline-none`}>
            {t('emailVerification.forgot.title')}
          </h1>
        </div>
        <p role="alert" className={styles.alert}>
          {t('emailVerification.forgot.unavailable')}
        </p>
        <Link href="/login" className={styles.secondary}>
          {t('emailVerification.forgot.backToSignIn')}
        </Link>
      </div>
    );
  }

  if (phase === 'sent') {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="material-symbols-outlined text-[32px] text-primary" aria-hidden>
            forward_to_inbox
          </span>
          <h1 ref={headingRef} tabIndex={-1} className={`${styles.title} outline-none`}>
            {t('emailVerification.forgot.sentTitle')}
          </h1>
          <p role="status" className={styles.lead}>
            {t('emailVerification.forgot.sentBody', { email: sentTo })}
          </p>
        </div>
        <Link href="/reset-password" className={styles.submit}>
          {t('emailVerification.forgot.enterCode')}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={() => {
              setPhase('form');
              setError(null);
            }}
            className={styles.link}
          >
            {t('emailVerification.forgot.tryAgain')}
          </button>
          <Link href="/login" className={styles.link}>
            {t('emailVerification.forgot.backToSignIn')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className={styles.title}>{t('emailVerification.forgot.title')}</h1>
        <p className={styles.lead}>{t('emailVerification.forgot.lead')}</p>
      </div>

      {error ? (
        <p role="alert" className={styles.alert}>
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} aria-busy={busy} noValidate className="flex flex-col gap-5">
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
        <CaptchaField gate={gate} />
        <button type="submit" disabled={busy} className={styles.submit}>
          {busy ? t('auth.login.pleaseWait') : t('emailVerification.forgot.submit')}
        </button>
      </form>

      <p className="text-center text-sm text-text-secondary">
        <Link href="/login" className={styles.link}>
          {t('emailVerification.forgot.backToSignIn')}
        </Link>
      </p>
    </div>
  );
}
