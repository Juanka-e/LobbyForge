'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginForm({
  guestEnabled,
  inviteOnly,
  initialInviteCode,
}: {
  guestEnabled: boolean;
  inviteOnly: boolean;
  initialInviteCode: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitLocal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError(null);
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setLoginError(body.error ?? 'Sign in failed.');
      setLoginBusy(false);
      return;
    }
    router.replace('/lobby');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch('/api/auth/guest', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayNameSeed: displayName.trim(),
        ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? 'Sign in failed.');
      setBusy(false);
      return;
    }
    router.replace('/lobby');
  }

  return (
    <div className="grid gap-6">
    <form onSubmit={submitLocal} className="grid gap-4 border-t border-border-subtle pt-6">
      <label className="grid gap-2 text-sm font-medium text-text-secondary">
        Email
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
          className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-text-primary outline-none focus:border-primary"
          placeholder="you@example.com"
        />
      </label>
      <label className="grid gap-2 text-sm font-medium text-text-secondary">
        Password
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          maxLength={128}
          autoComplete="current-password"
          className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-text-primary outline-none focus:border-primary"
          placeholder="Enter your password"
        />
      </label>
      <button type="submit" disabled={loginBusy || !email.trim() || !password} className="w-full rounded-lg bg-primary-container px-4 py-2.5 font-semibold text-[#07101e] disabled:cursor-not-allowed disabled:opacity-50">
        {loginBusy ? 'Signing in...' : 'Sign in'}
      </button>
      {loginError ? <p role="alert" className="text-pretty text-sm text-danger">{loginError}</p> : null}
    </form>

    {guestEnabled ? (
    <>
    <div className="flex items-center gap-3 text-xs text-text-muted"><span className="h-px flex-1 bg-border-subtle" /><span>or join as guest</span><span className="h-px flex-1 bg-border-subtle" /></div>
    <form onSubmit={submit} className="grid gap-5 border-t border-border-subtle pt-6">
      <label className="grid gap-2 text-sm font-medium text-text-secondary">
        Display name
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          minLength={2}
          maxLength={48}
          required
          autoComplete="nickname"
          className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-text-primary outline-none focus:border-primary"
          placeholder="How people will see you"
        />
      </label>
      {inviteOnly ? (
        <label className="grid gap-2 text-sm font-medium text-text-secondary">
          Invite code
          <input
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
            minLength={6}
            maxLength={16}
            required
            autoComplete="one-time-code"
            className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 font-mono text-text-primary outline-none focus:border-primary"
            placeholder="Required for this community"
          />
        </label>
      ) : null}
      <button
        type="submit"
        disabled={busy || displayName.trim().length < 2 || (inviteOnly && inviteCode.trim().length < 6)}
        className="w-full rounded-lg bg-primary-container px-4 py-2.5 font-semibold text-[#07101e] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Joining...' : 'Continue to community'}
      </button>
      {error ? <p role="alert" className="text-pretty text-sm text-danger">{error}</p> : null}
    </form>
    </>
    ) : null}
    </div>
  );
}
