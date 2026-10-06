'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UserRowWithoutImages } from '@lobbyforge/db';
import { ChangePasswordModal } from '@/components/modals/ChangePasswordModal';
import { retryAfterMinutes } from '@/app/login/login-errors';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';
import AccountEmailSection from './AccountEmailSection';

/** What the page says after the dialog closed on a successful change. */
type PasswordNotice = 'changed' | 'sessionsNotRevoked';

export default function MyAccountBody({
  user,
  signedIn,
}: {
  user: UserRowWithoutImages | null;
  signedIn: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<PasswordNotice | null>(null);

  async function changePassword(input: { currentPassword: string; newPassword: string }) {
    const response = await fetch('/api/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; warning?: string; retryAfter?: number };
    // Too many wrong current passwords (per-user limit): say how long.
    if (response.status === 429) {
      throw new Error(t('auth.login.error.rateLimited', { minutes: retryAfterMinutes(body.retryAfter) }));
    }
    if (!response.ok) throw new Error(body.error ?? t('settings.account.security.changeFailed'));
    // security-review AUTH-001 follow-up: the password is changed even when
    // the other sessions could not be signed out. That is a success with a
    // warning — shown in the viewer's language — never a failure that
    // invites a retry with the now-old password.
    setPasswordNotice(body.warning === 'sessions_not_revoked' ? 'sessionsNotRevoked' : 'changed');
  }

  async function signOut() {
    setSigningOut(true);
    setAccountError(null);
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setAccountError(body.error ?? t('settings.account.session.signOutFailed'));
      setSigningOut(false);
      return;
    }
    router.replace('/login');
    router.refresh();
  }

  if (!signedIn || !user) {
    return (
      <section className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.account')}</h1>
        <p className="mt-2 text-sm text-text-muted">{t('settings.account.signedOut')}</p>
      </section>
    );
  }

  return (
    <section className="max-w-3xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.account')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('settings.account.description')}</p>
        </header>

        <Section title={t('settings.account.identity.title')}>
          <Row label={t('settings.account.identity.displayName')} value={user.displayName} readOnly />
          {user.isGuest ? (
            <Row
              label={t('settings.account.identity.email')}
              value={user.email ?? t('settings.account.identity.emailNotSet')}
              readOnly
            />
          ) : null}
          <Row
            label={t('settings.account.identity.type')}
            value={t(user.isGuest ? 'settings.account.identity.guest' : 'settings.account.identity.local')}
            readOnly
          />
          <p className="text-xs text-text-muted italic pt-4 border-t border-border-subtle">
            {t('settings.account.identity.note')}
          </p>
        </Section>

        {/* EMAIL.md §4.3: the address, its verification and "Change email".
            `#email` is where every "Change email" link lands. */}
        {user.isGuest ? null : (
          <Section id="email" title={t('emailVerification.settings.title')}>
            <AccountEmailSection email={user.email} />
          </Section>
        )}

        <Section title={t('settings.account.security.title')}>
          <Row
            label={t('settings.account.security.password')}
            value={t(user.isGuest ? 'settings.account.security.passwordGuest' : 'settings.account.security.passwordSet')}
            action={user.isGuest ? undefined : t('settings.account.security.change')}
            onAction={
              user.isGuest
                ? undefined
                : () => {
                    setPasswordNotice(null);
                    setPasswordOpen(true);
                  }
            }
            badge={user.isGuest ? t('settings.account.security.unavailable') : undefined}
          />
          {passwordNotice === 'changed' ? (
            <p role="status" className="flex items-start gap-2 text-sm text-text-primary">
              <span className="material-symbols-outlined text-[18px] text-success" aria-hidden>check_circle</span>
              <span>{t('settings.account.security.changed')}</span>
            </p>
          ) : passwordNotice === 'sessionsNotRevoked' ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-container-low p-3 text-sm text-text-primary"
            >
              <span className="material-symbols-outlined text-[18px] text-danger" aria-hidden>warning</span>
              <span>
                {rich(t('settings.account.security.changedSessionsNotRevoked'), {
                  link: (
                    <a
                      href="/settings/active-sessions"
                      className="font-medium text-primary underline underline-offset-2 hover:text-text-primary"
                    >
                      {t('settings.nav.user.sessions')}
                    </a>
                  ),
                })}
              </span>
            </p>
          ) : null}
        </Section>

        <Section title={t('settings.account.session.title')}>
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-surface-raised flex items-center justify-center border border-border-subtle">
              <span className="material-symbols-outlined text-success">computer</span>
            </div>
            <div>
              <h3 className="text-sm text-text-primary">{t('settings.account.session.currentDevice')}</h3>
              <p className="text-xs text-text-muted">{t('settings.account.session.activeNow')}</p>
            </div>
          </div>
          <Row
            label={t('settings.account.session.others')}
            value={t('settings.account.session.othersHint')}
            href="/settings/active-sessions"
            action={t('settings.account.session.open')}
          />
          <Row
            label={t('settings.account.session.current')}
            value={t(signingOut ? 'settings.account.session.signingOut' : 'settings.account.session.signOutHint')}
            action={t('settings.account.session.signOut')}
            onAction={signingOut ? undefined : signOut}
            last
          />
          {accountError ? <p role="alert" className="text-sm text-danger">{accountError}</p> : null}
        </Section>

        <ChangePasswordModal
          open={passwordOpen}
          onClose={() => setPasswordOpen(false)}
          onSave={changePassword}
        />
      </section>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-4">
      <h2
        className="text-xs uppercase tracking-wider border-b border-border-subtle pb-2 text-text-secondary"
      >
        {title}
      </h2>
      <div className="rounded-xl bg-surface border border-border-subtle p-6 space-y-6">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  readOnly = false,
  action,
  href,
  onAction,
  badge,
  last = false,
}: {
  label: string;
  value: string;
  readOnly?: boolean;
  action?: string;
  href?: string;
  onAction?: () => void;
  badge?: string;
  last?: boolean;
}) {
  const t = useT();
  return (
    <div
      className={`flex justify-between items-center ${
        last ? '' : 'border-b border-border-subtle pb-6'
      }`}
    >
      <div>
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{label}</p>
        {value ? <p className="text-sm text-text-primary">{value}</p> : null}
      </div>
      {readOnly ? (
        <span className="px-2 py-1 rounded bg-surface-container-high text-text-muted text-[10px] uppercase tracking-wide">
          {t('settings.account.readOnly')}
        </span>
      ) : badge ? (
        <span className="px-2 py-1 rounded bg-surface-container-high text-text-muted text-[10px] uppercase tracking-wide">
          {badge}
        </span>
      ) : action && onAction ? (
        <button type="button" onClick={onAction} className="btn-secondary-sm">
          {action}
        </button>
      ) : action && href ? (
        <a href={href} className="btn-secondary-sm">
          {action}
        </a>
      ) : null}
    </div>
  );
}
