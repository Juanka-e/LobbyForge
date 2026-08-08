'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type RegistrationMode = 'open' | 'invite_only' | 'closed';

export default function LoginForm({
  guestEnabled,
  registrationMode,
  initialInviteCode,
}: {
  guestEnabled: boolean;
  registrationMode: RegistrationMode;
  initialInviteCode: string;
}) {
  const router = useRouter();
  const canRegister = registrationMode !== 'closed';
  const inviteOnly = registrationMode === 'invite_only';
  const [mode, setMode] = useState<'login' | 'register'>('login');
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
      setError(body.error ?? (mode === 'login' ? 'Sign in failed.' : 'Account could not be created.'));
      setBusy(false);
      return;
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
      setError(body.error ?? 'Guest sign in failed.');
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
        <div className="grid grid-cols-2 rounded-md bg-surface-container p-1" role="tablist" aria-label="Account access">
          <ModeButton active={mode === 'login'} onClick={() => switchMode('login')}>Sign in</ModeButton>
          <ModeButton active={mode === 'register'} onClick={() => switchMode('register')}>Create account</ModeButton>
        </div>
      ) : null}

      <form onSubmit={submitAccount} className="grid gap-4">
        {mode === 'register' ? (
          <Field label="Display name">
            <input
              value={accountDisplayName}
              onChange={(event) => setAccountDisplayName(event.target.value)}
              minLength={2}
              maxLength={48}
              required
              autoComplete="nickname"
              className="auth-input"
              placeholder="How people will see you"
            />
          </Field>
        ) : null}
        <Field label="Email">
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
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={mode === 'register' ? 12 : 1}
            maxLength={128}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            className="auth-input"
            placeholder={mode === 'register' ? 'At least 12 characters' : 'Enter your password'}
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
          className="w-full rounded-lg bg-primary-container px-4 py-2.5 font-semibold text-[#07101e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      {guestEnabled ? (
        <>
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span className="h-px flex-1 bg-border-subtle" />
            <span>or join as guest</span>
            <span className="h-px flex-1 bg-border-subtle" />
          </div>
          <form onSubmit={submitGuest} className="grid gap-4">
            <Field label="Guest display name">
              <input
                value={guestDisplayName}
                onChange={(event) => setGuestDisplayName(event.target.value)}
                minLength={2}
                maxLength={48}
                required
                autoComplete="nickname"
                className="auth-input"
                placeholder="How people will see you"
              />
            </Field>
            {inviteOnly ? <InviteField value={inviteCode} onChange={setInviteCode} required /> : null}
            <button
              type="submit"
              disabled={busy || guestDisplayName.trim().length < 2 || (inviteOnly && inviteCode.trim().length < 6)}
              className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2.5 font-semibold text-text-primary hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Please wait...' : 'Continue as guest'}
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
  return (
    <Field label={required ? 'Invite code' : 'Invite code (optional)'}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        minLength={required ? 6 : undefined}
        maxLength={16}
        required={required}
        autoComplete="one-time-code"
        className="auth-input font-mono"
        placeholder={required ? 'Required for this community' : 'Join a specific community'}
      />
    </Field>
  );
}
