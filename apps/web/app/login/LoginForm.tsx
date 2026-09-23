'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/client';

type RegistrationMode = 'open' | 'invite_only' | 'closed';

export default function LoginForm({
  guestEnabled,
  registrationMode,
  initialInviteCode,
  initialMode = 'login',
  desktopLoginState,
}: {
  guestEnabled: boolean;
  registrationMode: RegistrationMode;
  initialInviteCode: string;
  /** Deep-link start mode (/register and ?mode=register land on the tab). */
  initialMode?: 'login' | 'register';
  /** Native shell's pending handoff state (?desktopLoginState=...). */
  desktopLoginState?: string;
}) {
  const t = useT();
  const router = useRouter();
  const canRegister = registrationMode !== 'closed';
  const inviteOnly = registrationMode === 'invite_only';
  const [mode, setMode] = useState<'login' | 'register'>(
    initialMode === 'register' && canRegister ? 'register' : 'login'
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [guestDisplayName, setGuestDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const payload = mode === 'login'
      ? { email: email.trim(), password }
      : {
          email: email.trim(),
          password,
          displayName: accountDisplayName.trim(),
          ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
        };
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? (mode === 'login' ? t('auth.login.signInFailed') : t('auth.login.registerFailed')));
      setBusy(false);
      return;
    }
    // Desktop browser-login flow: the NATIVE shell opened this page
    // with its own pending state (?desktopLoginState=...). Mint the
    // one-time handoff bound to that state, then hand control back via
    // the lobbyforge:// deep link — the shell drops it unless the
    // state matches its pending entry.
    if (desktopLoginState) {
      const handoff = await fetch('/api/auth/desktop-session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, state: desktopLoginState }),
      }).catch(() => null);
      const handoffBody = handoff
        ? ((await handoff.json().catch(() => ({}))) as { redirectUrl?: string })
        : {};
      if (handoff?.ok && handoffBody.redirectUrl) {
        window.location.href = handoffBody.redirectUrl;
        return;
      }
      // Handoff minting failed — fall through to the normal web path;
      // the desktop shell will simply not receive a session.
    }
    router.replace('/lobby');
    router.refresh();
  }

  async function submitGuest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch('/api/auth/guest', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayNameSeed: guestDisplayName.trim(),
        ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? t('auth.login.guestFailed'));
      setBusy(false);
      return;
    }
    router.replace('/lobby');
    router.refresh();
  }

  function switchMode(next: 'login' | 'register') {
    setMode(next);
    setError(null);
    setPassword('');
  }

  return (
    <div className="grid gap-6">
      {canRegister ? (
        <div className="grid grid-cols-2 rounded-md bg-surface-container p-1" role="tablist" aria-label={t('auth.login.tabsLabel')}>
          <ModeButton active={mode === 'login'} onClick={() => switchMode('login')}>{t('auth.login.signIn')}</ModeButton>
          <ModeButton active={mode === 'register'} onClick={() => switchMode('register')}>{t('auth.login.createAccount')}</ModeButton>
        </div>
      ) : null}

      <form onSubmit={submitAccount} className="grid gap-4">
        {mode === 'register' ? (
          <Field label={t('auth.login.displayName')}>
            <input
              value={accountDisplayName}
              onChange={(event) => setAccountDisplayName(event.target.value)}
              minLength={2}
              maxLength={48}
              required
              autoComplete="nickname"
              className="auth-input"
              placeholder={t('auth.login.displayNamePlaceholder')}
            />
          </Field>
        ) : null}
        <Field label={t('auth.login.email')}>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={254}
            autoComplete="email"
            className="auth-input"
            placeholder="you@example.com"
          />
        </Field>
        <Field label={t('auth.login.password')}>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={mode === 'register' ? 12 : 1}
            maxLength={128}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            className="auth-input"
            placeholder={mode === 'register' ? t('auth.login.passwordPlaceholderNew') : t('auth.login.passwordPlaceholder')}
          />
        </Field>
        {mode === 'register' && (inviteOnly || initialInviteCode) ? (
          <InviteField value={inviteCode} onChange={setInviteCode} required={inviteOnly} />
        ) : null}
        <button
          type="submit"
          disabled={
            busy ||
            !email.trim() ||
            !password ||
            (mode === 'register' && (accountDisplayName.trim().length < 2 || password.length < 12)) ||
            (mode === 'register' && inviteOnly && inviteCode.trim().length < 6)
          }
          className="w-full rounded-lg bg-primary-container px-4 py-2.5 font-semibold text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? t('auth.login.pleaseWait') : mode === 'login' ? t('auth.login.signIn') : t('auth.login.createAccount')}
        </button>
      </form>

      {guestEnabled ? (
        <>
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span className="h-px flex-1 bg-border-subtle" />
            <span>{t('auth.login.orGuest')}</span>
            <span className="h-px flex-1 bg-border-subtle" />
          </div>
          <form onSubmit={submitGuest} className="grid gap-4">
            <Field label={t('auth.login.guestDisplayName')}>
              <input
                value={guestDisplayName}
                onChange={(event) => setGuestDisplayName(event.target.value)}
                minLength={2}
                maxLength={48}
                required
                autoComplete="nickname"
                className="auth-input"
                placeholder={t('auth.login.displayNamePlaceholder')}
              />
            </Field>
            {inviteOnly ? <InviteField value={inviteCode} onChange={setInviteCode} required /> : null}
            <button
              type="submit"
              disabled={busy || guestDisplayName.trim().length < 2 || (inviteOnly && inviteCode.trim().length < 6)}
              className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2.5 font-semibold text-text-primary hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? t('auth.login.pleaseWait') : t('auth.login.continueAsGuest')}
            </button>
          </form>
        </>
      ) : null}
      {error ? <p role="alert" className="text-pretty text-sm text-danger">{error}</p> : null}
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={active
        ? 'rounded px-3 py-2 text-sm font-semibold text-text-primary shadow-sm bg-surface-raised'
        : 'rounded px-3 py-2 text-sm text-text-secondary hover:text-text-primary'}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-2 text-sm font-medium text-text-secondary">{label}{children}</label>;
}

function InviteField({ value, onChange, required }: { value: string; onChange: (value: string) => void; required: boolean }) {
  const t = useT();
  return (
    <Field label={required ? t('auth.login.inviteCode') : t('auth.login.inviteCodeOptional')}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        minLength={required ? 6 : undefined}
        maxLength={16}
        required={required}
        autoComplete="one-time-code"
        className="auth-input font-mono"
        placeholder={required ? t('auth.login.invitePlaceholderRequired') : t('auth.login.invitePlaceholderOptional')}
      />
    </Field>
  );
}
