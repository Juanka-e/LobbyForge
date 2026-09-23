'use client';

import { useCallback, useState } from 'react';
import { useT } from '@/lib/i18n/client';

export interface AppView {
  id: string;
  name: string;
  version: string;
  type: 'game' | 'activity' | 'utility';
  summary: string | null;
  trustLevel: string | null;
  minPlayers: number | null;
  maxPlayers: number | null;
  installed: boolean;
  enabled: boolean;
}

/** Message keys for the catalogue trust levels; anything else shows as-is. */
const TRUST_LABEL_KEYS: Record<string, string> = {
  official: 'admin.apps.trustOfficial',
  'verified-community': 'admin.apps.trustVerified',
  unverified: 'admin.apps.trustUnverified',
};

export default function AppsClient({
  serverId,
  initialApps,
  loadError,
}: {
  serverId: string | null;
  initialApps: AppView[];
  loadError: string | null;
}) {
  const t = useT();
  const [apps, setApps] = useState<AppView[]>(initialApps);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const mutate = useCallback(
    async (app: AppView, next: { installed: boolean; enabled: boolean }) => {
      if (!serverId) return;
      setBusyId(app.id);
      setError(null);
      setMessage(null);
      try {
        const res = next.installed
          ? await fetch(`/api/servers/${serverId}/apps`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pluginId: app.id, enabled: next.enabled }),
            })
          : await fetch(`/api/servers/${serverId}/apps`, {
              method: 'DELETE',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pluginId: app.id }),
            });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(detail.error ?? t('admin.apps.requestFailed', { status: res.status }));
        }
        setApps((current) =>
          current.map((entry) => (entry.id === app.id ? { ...entry, ...next } : entry))
        );
        setMessage(
          next.installed
            ? next.enabled
              ? t('admin.apps.installedEnabled', { name: app.name })
              : t('admin.apps.installedDisabled', { name: app.name })
            : t('admin.apps.removed', { name: app.name })
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [serverId, t]
  );

  return (
    <section className="mx-auto max-w-4xl pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('admin.apps.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('admin.apps.intro')}</p>
      </header>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {t('admin.apps.loadError', { error: loadError })}
        </div>
      ) : null}
      {!serverId && !loadError ? (
        <div className="mb-4 rounded-lg border border-border-subtle bg-surface p-4 text-sm text-text-secondary">
          {t('admin.apps.noCommunity')}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mb-4 rounded-lg border border-border-subtle bg-surface p-4 text-sm text-text-secondary">
          {message}
        </div>
      ) : null}

      <ul className="space-y-3">
        {apps.map((app) => {
          const busy = busyId === app.id;
          const players =
            app.minPlayers || app.maxPlayers
              ? t('admin.apps.playerRange', {
                  min: app.minPlayers ?? 1,
                  max: app.maxPlayers ?? t('admin.apps.playerRangeAny'),
                })
              : null;
          return (
            <li
              key={app.id}
              className="rounded-xl border border-border-subtle bg-surface p-5 flex flex-wrap items-start justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-text-primary">{app.name}</h2>
                  <span className="rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-muted">
                    v{app.version}
                  </span>
                  {app.trustLevel ? (
                    <span className="rounded border border-success/40 px-1.5 py-0.5 text-[11px] text-success">
                      {TRUST_LABEL_KEYS[app.trustLevel] ? t(TRUST_LABEL_KEYS[app.trustLevel]!) : app.trustLevel}
                    </span>
                  ) : null}
                  {app.enabled ? (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                      {t('admin.apps.enabled')}
                    </span>
                  ) : app.installed ? (
                    <span className="rounded bg-surface-container px-1.5 py-0.5 text-[11px] text-text-muted">
                      {t('admin.apps.disabled')}
                    </span>
                  ) : null}
                </div>
                {app.summary ? (
                  <p className="mt-1 text-sm text-text-secondary">{app.summary}</p>
                ) : null}
                {players ? <p className="mt-1 text-xs text-text-muted">{players}</p> : null}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {app.installed ? (
                  <>
                    <button
                      type="button"
                      disabled={busy || !serverId}
                      onClick={() => void mutate(app, { installed: true, enabled: !app.enabled })}
                      className="rounded-lg border border-border-strong px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy ? t('admin.apps.working') : app.enabled ? t('admin.apps.disable') : t('admin.apps.enable')}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !serverId}
                      onClick={() => void mutate(app, { installed: false, enabled: false })}
                      className="rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('admin.apps.remove')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busy || !serverId}
                    onClick={() => void mutate(app, { installed: true, enabled: true })}
                    className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? t('admin.apps.working') : t('admin.apps.install')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
