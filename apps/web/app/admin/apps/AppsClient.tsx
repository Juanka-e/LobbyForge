'use client';

import { useCallback, useState } from 'react';

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

const TRUST_LABELS: Record<string, string> = {
  official: 'Official',
  'verified-community': 'Verified',
  unverified: 'Unverified',
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
          throw new Error(detail.error ?? `Request failed (${res.status})`);
        }
        setApps((current) =>
          current.map((entry) => (entry.id === app.id ? { ...entry, ...next } : entry))
        );
        setMessage(
          next.installed
            ? next.enabled
              ? `${app.name} is installed and enabled — members can start it from a voice channel.`
              : `${app.name} is installed but disabled.`
            : `${app.name} was removed from this community.`
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [serverId]
  );

  return (
    <section className="mx-auto max-w-4xl pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Apps &amp; Activities</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Install the games and activities your community can start inside a voice channel. An app
          must be installed <em>and</em> enabled before it appears in the activity picker.
        </p>
      </header>

      {loadError ? (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Could not load apps: {loadError}
        </div>
      ) : null}
      {!serverId && !loadError ? (
        <div className="mb-4 rounded-lg border border-border-subtle bg-surface p-4 text-sm text-text-secondary">
          No community found for this account yet.
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
              ? `${app.minPlayers ?? 1}–${app.maxPlayers ?? 'any'} players`
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
                      {TRUST_LABELS[app.trustLevel] ?? app.trustLevel}
                    </span>
                  ) : null}
                  {app.enabled ? (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                      Enabled
                    </span>
                  ) : app.installed ? (
                    <span className="rounded bg-surface-container px-1.5 py-0.5 text-[11px] text-text-muted">
                      Disabled
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
                      {busy ? 'Working…' : app.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !serverId}
                      onClick={() => void mutate(app, { installed: false, enabled: false })}
                      className="rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busy || !serverId}
                    onClick={() => void mutate(app, { installed: true, enabled: true })}
                    className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? 'Working…' : 'Install'}
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
