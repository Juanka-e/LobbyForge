'use client';

import type { UserRow } from '@lobbyforge/db';

export default function MyAccountBody({
  user,
  signedIn,
}: {
  user: UserRow | null;
  signedIn: boolean;
}) {
  if (!signedIn || !user) {
    return (
      <section className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold text-text-primary">My Account</h1>
        <p className="mt-2 text-sm text-text-muted">Sign in to view your account details.</p>
      </section>
    );
  }

  return (
    <section className="max-w-3xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">My Account</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Manage your local account for this self-hosted community.
          </p>
        </header>

        <Section title="Account Identity">
          <Row label="Display name" value={user.displayName} readOnly />
          <Row label="Email" value={user.email ?? 'Not set'} badge="Planned" />
          <Row
            label="Account type"
            value={user.isGuest ? 'Guest account' : 'Local account'}
            readOnly
          />
          <p className="text-xs text-text-muted italic pt-4 border-t border-border-subtle">
            This account belongs to this community only.
          </p>
        </Section>

        <Section title="Login & Security">
          <Row
            label="Password"
            value={user.isGuest ? 'Not set (guest)' : 'Set'}
            badge="Planned"
          />
          <Row label="Two-step verification" value="Off" badge="Planned" />
          <Row
            label="Recovery email"
            value={user.email ? 'Verified' : 'Not set'}
            badge={user.email ? undefined : 'Planned'}
          />
        </Section>

        <Section title="Session Security">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-surface-raised flex items-center justify-center border border-border-subtle">
              <span className="material-symbols-outlined text-success">computer</span>
            </div>
            <div>
              <h3 className="text-sm text-text-primary">Current device</h3>
              <p className="text-xs text-text-muted">Active now</p>
            </div>
          </div>
          <Row
            label="Other active sessions"
            value="Manage signed-in devices"
            href="/settings/active-sessions"
            action="Open"
            last
          />
        </Section>

        <Section title="Account Actions" tone="danger">
          <Row label="Export local profile data" value="Not available yet" badge="Planned" last />
        </Section>
      </section>
  );
}

function Section({
  title,
  children,
  tone = 'default',
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <section className="space-y-4">
      <h2
        className={`text-xs uppercase tracking-wider border-b border-border-subtle pb-2 ${
          tone === 'danger' ? 'text-danger' : 'text-text-secondary'
        }`}
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
  badge,
  last = false,
}: {
  label: string;
  value: string;
  readOnly?: boolean;
  action?: string;
  href?: string;
  badge?: string;
  last?: boolean;
}) {
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
          Read-only
        </span>
      ) : badge ? (
        <span className="px-2 py-1 rounded bg-surface-container-high text-text-muted text-[10px] uppercase tracking-wide">
          {badge}
        </span>
      ) : action && href ? (
        <a href={href} className="btn-secondary-sm">
          {action}
        </a>
      ) : null}
    </div>
  );
}
