'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { CaptchaField } from '@/components/captcha/CaptchaField';
import { reportFormValidity } from '@/components/captcha/form-validity';
import { useCaptchaGate } from '@/components/captcha/useCaptchaGate';
import { LOBBYFORGE_REPO } from '@/lib/github-repo';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';
import { MIN_PASSWORD_LENGTH } from '@/lib/password-strength';
import { signUpErrorMessage } from './auth-errors';
import PasswordField from './PasswordField';
import PasswordStrengthMeter from './PasswordStrengthMeter';
import { authInput, authLabel, authLink, authSubmit } from './styles';

/**
 * The official hub's account creation, over the same `/api/auth/register`
 * a self-hosted instance uses (on the hub it creates an account that
 * joins no community yet). On success: the hub home.
 */
export default function OfficialSignUpForm() {
  const t = useT();
  const router = useRouter();
  const ids = useId();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hub sign-up is the `register` surface (docs/CAPTCHA.md §2).
  const gate = useCaptchaGate({ surface: 'register' });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // noValidate: the captcha checkbox must not block the send (form-validity.ts).
    if (!reportFormValidity(event.currentTarget)) return;
    setBusy(true);
    setError(null);
    const result = await gate.submit((fields) =>
      fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, displayName: displayName.trim(), ...fields }),
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
      setError(signUpErrorMessage(t, response.status, body.error));
      setBusy(false);
      return;
    }
    router.replace('/home');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-[30px] font-semibold tracking-[-0.01em] text-text-primary">{t('auth.official.signUp.title')}</h1>
        <p className="text-[15px] text-text-secondary">{t('auth.official.signUp.subtitle')}</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-pretty text-sm text-text-primary">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} aria-busy={busy} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label htmlFor={`${ids}-name`} className={authLabel}>
            {t('auth.login.displayName')}
          </label>
          <input
            id={`${ids}-name`}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            minLength={2}
            maxLength={48}
            autoComplete="nickname"
            aria-describedby={`${ids}-name-hint`}
            className={authInput}
          />
          <p id={`${ids}-name-hint`} className="text-[13px] text-text-muted">
            {t('auth.official.signUp.displayNameHint')}
          </p>
        </div>

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
          autoComplete="new-password"
          placeholder={t('auth.login.passwordPlaceholderNew')}
          minLength={MIN_PASSWORD_LENGTH}
          describedBy={`${ids}-strength`}
        >
          <PasswordStrengthMeter id={`${ids}-strength`} password={password} />
        </PasswordField>

        <div className="flex items-start gap-2.5">
          <input
            id={`${ids}-agree`}
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            required
            className="mt-0.5 size-[18px] shrink-0 rounded border-border-strong bg-surface text-primary focus:ring-primary focus:ring-offset-0"
          />
          <label htmlFor={`${ids}-agree`} className="text-sm leading-[1.5] text-text-secondary">
            {rich(t('auth.official.signUp.agree'), {
              link: (
                <a href={LOBBYFORGE_REPO.codeOfConductUrl} target="_blank" rel="noopener noreferrer" className={authLink}>
                  {t('auth.official.signUp.codeOfConduct')}
                  <span className="sr-only"> {t('auth.official.newTab')}</span>
                </a>
              ),
            })}
          </label>
        </div>

        <CaptchaField gate={gate} />
        <button type="submit" disabled={busy} className={authSubmit}>
          {busy ? t('auth.login.pleaseWait') : t('auth.login.createAccount')}
        </button>
      </form>

      <p className="text-center text-[15px] text-text-secondary">
        {rich(t('auth.official.signUp.haveAccount'), {
          link: (
            <Link href="/login" className={authLink}>
              {t('auth.login.signIn')}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}
