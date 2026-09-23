'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n/client';

interface PendingPlugin {
  pluginId: string;
  name: string;
  version: string;
  publisher: string;
  category: string | null;
  summary: string | null;
  submittedAt: string;
}

interface RegistryInstance {
  instanceId: string;
  name: string;
  domain: string;
  isVerified: boolean;
  isListed: boolean;
  isBlocked: boolean;
  onlineUsers: number;
  lastHeartbeatAt: string | null;
}

interface InstanceReport {
  id: string;
  instanceId: string;
  reporterName: string | null;
  reason: string;
  detail: string | null;
  status: string;
  createdAt: string;
}

/** The reasons `/api/directory/{id}/report` accepts; anything else shows as-is. */
const REASON_LABEL_KEYS: Record<string, string> = {
  spam: 'admin.moderation.reason.spam',
  nsfw: 'admin.moderation.reason.nsfw',
  abuse: 'admin.moderation.reason.abuse',
  malware: 'admin.moderation.reason.malware',
  other: 'admin.moderation.reason.other',
};

const REPORT_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'admin.moderation.reportStatus.pending',
  dismissed: 'admin.moderation.reportStatus.dismissed',
  actioned: 'admin.moderation.reportStatus.actioned',
};

interface ModerationData {
  pendingPlugins: PendingPlugin[];
  registryInstances: RegistryInstance[];
  reports?: InstanceReport[];
}

export default function ModerationClient() {
  const t = useT();
  const [data, setData] = useState<ModerationData>({ pendingPlugins: [], registryInstances: [], reports: [] });
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/moderation', { credentials: 'same-origin' });
      if (res.ok) setData(await res.json());
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function reviewPlugin(pluginId: string, decision: 'approved' | 'rejected') {
    setActioning(pluginId);
    try {
      await fetch('/api/marketplace/review', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId, decision }),
      });
      await reload();
    } finally {
      setActioning(null);
    }
  }

  async function resolveReport(reportId: string, action: 'dismiss' | 'actioned') {
    setActioning(reportId);
    try {
      await fetch('/api/admin/moderation', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'report', reportId, action }),
      });
      await reload();
    } finally {
      setActioning(null);
    }
  }

  async function moderateInstance(instanceId: string, action: 'list' | 'unlist' | 'block') {
    setActioning(instanceId);
    try {
      // Use the registry moderation API (inline for now)
      await fetch('/api/admin/moderation', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'instance', instanceId, action }),
      });
      await reload();
    } finally {
      setActioning(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-text-muted p-8">{t('admin.moderation.loading')}</p>;
  }

  return (
    <section className="space-y-8 pb-32">
      <header>
        <h1 className="text-2xl font-semibold text-text-primary">{t('admin.moderation.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('admin.moderation.intro')}</p>
      </header>

      {/* Pending plugin submissions */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2 border-b border-border-subtle pb-2">
          <span className="material-symbols-outlined text-primary text-[20px]">extension</span>
          {t('admin.moderation.pluginQueue', { count: data.pendingPlugins.length })}
        </h2>
        {data.pendingPlugins.length === 0 ? (
          <div className="rounded-xl border border-border-subtle bg-surface p-6 flex items-center gap-3">
            <span className="material-symbols-outlined text-success text-[20px]">check_circle</span>
            <p className="text-sm text-text-primary">{t('admin.moderation.noPending')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {data.pendingPlugins.map((p) => (
              <article key={p.pluginId} className="rounded-xl border border-border-subtle bg-surface p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-text-primary">{p.name}</h3>
                      <span className="text-xs text-text-muted">v{p.version}</span>
                      {p.category ? (
                        <span className="rounded-full bg-surface-container px-2 py-0.5 text-[10px] text-text-muted">{p.category}</span>
                      ) : null}
                    </div>
                    <p className="text-xs text-text-muted">
                      {t('admin.moderation.submittedBy', {
                        publisher: p.publisher,
                        date: new Date(p.submittedAt).toLocaleDateString(t.locale),
                      })}
                    </p>
                    {p.summary ? <p className="text-sm text-text-secondary mt-2">{p.summary}</p> : null}
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => reviewPlugin(p.pluginId, 'approved')}
                      disabled={actioning === p.pluginId}
                      className="rounded-md bg-success/20 px-3 py-1.5 text-xs font-semibold text-success hover:bg-success/30 disabled:opacity-40"
                    >
                      {t('admin.moderation.approve')}
                    </button>
                    <button
                      onClick={() => reviewPlugin(p.pluginId, 'rejected')}
                      disabled={actioning === p.pluginId}
                      className="rounded-md bg-danger/20 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/30 disabled:opacity-40"
                    >
                      {t('admin.moderation.reject')}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Instance reports (discovery complaints) */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2 border-b border-border-subtle pb-2">
          <span className="material-symbols-outlined text-warning text-[20px]">flag</span>
          {t('admin.moderation.reportsTitle', {
            count: (data.reports ?? []).filter((r) => r.status === 'pending').length,
          })}
        </h2>
        {(data.reports ?? []).length === 0 ? (
          <p className="text-sm text-text-muted">{t('admin.moderation.noReports')}</p>
        ) : (
          <div className="space-y-3">
            {(data.reports ?? []).map((r) => (
              <article key={r.id} className="rounded-xl border border-border-subtle bg-surface p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning uppercase">
                        {REASON_LABEL_KEYS[r.reason] ? t(REASON_LABEL_KEYS[r.reason]!) : r.reason}
                      </span>
                      <span className="text-xs text-text-muted">
                        {t('admin.moderation.reportMeta', {
                          instance: r.instanceId,
                          reporter: r.reporterName ?? t('admin.moderation.unknownReporter'),
                          date: new Date(r.createdAt).toLocaleDateString(t.locale),
                        })}
                      </span>
                      {r.status !== 'pending' ? (
                        <span className="rounded-full bg-surface-container px-2 py-0.5 text-[10px] text-text-muted">
                          {REPORT_STATUS_LABEL_KEYS[r.status] ? t(REPORT_STATUS_LABEL_KEYS[r.status]!) : r.status}
                        </span>
                      ) : null}
                    </div>
                    {r.detail ? <p className="text-sm text-text-secondary mt-1">{r.detail}</p> : null}
                  </div>
                  {r.status === 'pending' ? (
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        onClick={() => resolveReport(r.id, 'dismiss')}
                        disabled={actioning === r.id}
                        className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-container disabled:opacity-40"
                      >
                        {t('admin.moderation.dismiss')}
                      </button>
                      <button
                        onClick={() => resolveReport(r.id, 'actioned')}
                        disabled={actioning === r.id}
                        className="rounded-md bg-primary/15 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/25 disabled:opacity-40"
                      >
                        {t('admin.moderation.markActioned')}
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Registry instances */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2 border-b border-border-subtle pb-2">
          <span className="material-symbols-outlined text-tertiary text-[20px]">public</span>
          {t('admin.moderation.directoryTitle', { count: data.registryInstances.length })}
        </h2>
        {data.registryInstances.length === 0 ? (
          <p className="text-sm text-text-muted">{t('admin.moderation.noInstances')}</p>
        ) : (
          <div className="rounded-xl border border-border-subtle bg-surface overflow-hidden divide-y divide-border-subtle">
            {data.registryInstances.map((inst) => (
              <div key={inst.instanceId} className="flex items-center justify-between p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">{inst.name}</span>
                    {inst.isVerified ? <span className="material-symbols-outlined text-[14px] text-primary">verified</span> : null}
                    {inst.isBlocked ? (
                      <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] text-danger">
                        {t('admin.moderation.blocked')}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-text-muted truncate">
                    {inst.domain} · {t('admin.moderation.onlineCount', { count: inst.onlineUsers })}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => moderateInstance(inst.instanceId, inst.isListed ? 'unlist' : 'list')}
                    disabled={actioning === inst.instanceId}
                    className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-container disabled:opacity-40"
                  >
                    {inst.isListed ? t('admin.moderation.unlist') : t('admin.moderation.list')}
                  </button>
                  <button
                    onClick={() => moderateInstance(inst.instanceId, 'block')}
                    disabled={actioning === inst.instanceId}
                    className="rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-40"
                  >
                    {t('admin.moderation.block')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
