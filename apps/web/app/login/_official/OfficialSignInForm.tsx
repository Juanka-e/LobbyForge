'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { HUB_HOME_PATH } from '@/lib/hub-routes';
import { useId, useState, type FormEvent } from 'react';
import { LinkIcon } from '@/app/(marketing)/_components/icons';
import { CaptchaField } from '@/components/captcha/CaptchaField';
import { reportFormValidity } from '@/components/captcha/form-validity';
import { useCaptchaGate } from '@/components/captcha/useCaptchaGate';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';
import { completeDesktopHandoff } from '../desktop-handoff';
import { signInErrorMessage } from './auth-errors';
import GoogleMark from './GoogleMark';
import PasswordField from './PasswordField';
import { authAlternative, authInput, authLabel, authLink, authSubmit } from './styles';

/**
 * The official hub's sign-in, over the same `/api/auth/login` the
 * self-hosted sign-in uses. On success: the hub home.
 */
export default function OfficialSignInForm({
  googleEnabled,
  desktopLoginState,
  initialError,
  nextPath = HUB_HOME_PATH,
}: {
  googleEnabled: boolean;
  /** Native shell's pending handoff state (?desktopLoginState=…). */
  desktopLoginState?: string;
  /** A known `?error=` code from an auth redirect, already in words. */
  initialError: string | null;
  /** Where to go once signed in — `?next=`, already checked by the page. */
  nextPath?: string;
}) {
  const t = useT();
  const router = useRouter();
  const ids = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  // Adaptive sign-in: the challenge appears only after `captcha_required`.
  const gate = useCaptchaGate({ surface: 'login', prefetch: false });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // noValidate: the captcha checkbox must not block the send (form-validity.ts).
    if (!reportFormValidity(event.currentTarget)) return;
    setBusy(true);
    setError(null);
    const result = await gate.submit((fields) =>
      fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, ...fields }),
      })
    );
    if (result.kind !== 'response') {
      setError(t(result.kind === 'blocked' ? result.messageKey : 'auth.official.error.network'));
      setBusy(false);
      return;
    }
    const { response } = result;
    if (!response.ok) {
      const body = result.body as { error?: string };
      setError(signInErrorMessage(t, response.status, body.error));
      setBusy(false);
      return;
    }
    if (
      desktopLoginState &&
      (await completeDesktopHandoff({ email: email.trim(), password, state: desktopLoginState }))
    ) {
      return;
    }
    router.replace(nextPath as Route);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <div className="flex flex-col gap-2">
        <h1 className="text-[30px] font-semibold tracking-[-0.01em] text-text-primary">{t('auth.login.signIn')}</h1>
        <p className="text-[15px] text-text-secondary">{t('auth.official.signIn.subtitle')}</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-pretty text-sm text-text-primary">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} aria-busy={busy} noValidate className="flex flex-col gap-[22px]">
        <div className="flex flex-col gap-2">
          <label htmlFor={`${ids}-email`} className={authLabel}>
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
            className={authInput}
          />
        </div>
        <PasswordField
          id={`${ids}-password`}
          label={t('auth.login.password')}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          placeholder={t('auth.official.signIn.passwordPlaceholder')}
          labelAside={
            <Link href="/forgot-password" className={`${authLink} text-sm`}>
              {t('auth.login.forgotPassword')}
            </Link>
          }
        />
        <CaptchaField gate={gate} />
        <button type="submit" disabled={busy} className={authSubmit}>
          {busy ? t('auth.login.pleaseWait') : t('auth.login.signIn')}
        </button>
      </form>

      <div className="flex items-center gap-3 text-[13px] text-text-muted">
        <span aria-hidden className="h-px flex-1 bg-border-subtle" />
        {t('auth.login.or')}
        <span aria-hidden className="h-px flex-1 bg-border-subtle" />
      </div>

      <div className="flex flex-col gap-3">
        {googleEnabled ? (
          <a href={`/api/auth/oauth/google?redirect=${encodeURIComponent(nextPath)}`} className={authAlternative}>
            <GoogleMark />
            {t('auth.login.google')}
          </a>
        ) : null}
        <Link href="/connect" className={authAlternative}>
          <LinkIcon size={18} />
          {t('auth.official.connect')}
        </Link>
      </div>

      <p className="text-center text-[15px] text-text-secondary">
        {rich(t('auth.official.signIn.newHere'), {
          link: (
            <Link href="/register" className={authLink}>
              {t('auth.official.signIn.createAccount')}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}
