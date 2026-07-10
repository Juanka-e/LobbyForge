'use client';

import { useCallback, useEffect, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';

/**
 * M21.5-bandwidth — Admin bandwidth counter + alert.
 *
 * Reads `/api/admin/bandwidth` every 30s and renders:
 *   - top-line cards (total / today / alert status)
 *   - per-server table with hourly bar chart
 *   - "Acknowledge alert" button when the threshold has been exceeded
 *
 * The threshold itself is configured through the `LOBBYFORGE_BANDWIDTH_ALERT_BYTES`
 * env var on the server; this page only surfaces the resulting alert.
 */

interface HourlyPoint {
  hour: string;
  bytes: number;
}

interface ServerTotal {
  serverId: string;
  serverName: string;
  totalBytes: number;
  todayBytes: number;
  alertTriggered: boolean;
  hourly: HourlyPoint[];
}

interface Response {
  totals: ServerTotal[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatHour(label: string): string {
  // label is YYYY-MM-DDTHH (UTC)
  const parts = label.split('T');
  if (parts.length !== 2) return label;
  return `${parts[1]}:00`;
}

const POLL_INTERVAL_MS = 30_000;
const THRESHOLD_BYTES = process.env.NEXT_PUBLIC_LOBBYFORGE_BANDWIDTH_ALERT_BYTES
  ? Number(process.env.NEXT_PUBLIC_LOBBYFORGE_BANDWIDTH_ALERT_BYTES)
  : null;

export default function BandwidthPage() {
  const [totals, setTotals] = useState<ServerTotal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/bandwidth', { credentials: 'same-origin' });
      if (res.status === 403) {
        setError('Admin token required.');
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Response;
      setTotals(data.totals);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  async function acknowledge(serverId: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/bandwidth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge-alert', serverId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const grandTotal = totals.reduce((sum, s) => sum + s.totalBytes, 0);
  const todayTotal = totals.reduce((sum, s) => sum + s.todayBytes, 0);
  const anyAlert = totals.some((s) => s.alertTriggered);

  return (
    <SettingsShell scope="community">
      <section className="max-w-5xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">Bandwidth</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Per-server bandwidth counter driven by LiveKit RTC stats. Updates every 30s.
          </p>
        </header>

        {anyAlert ? (
          <div className="rounded-lg border border-danger/50 bg-danger/10 p-4 flex items-start gap-3">
            <span className="material-symbols-outlined text-danger flex-shrink-0">warning</span>
            <div className="flex-1">
              <p className="text-sm text-danger font-semibold">Bandwidth threshold exceeded</p>
              <p className="text-xs text-text-secondary mt-1">
                One or more servers have crossed the configured alert threshold. Acknowledge the alert
                once you&apos;ve investigated.
              </p>
            </div>
          </div>
        ) : null}

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            label="Total bandwidth"
            value={formatBytes(grandTotal)}
            sub="All-time across every server"
            icon="data_usage"
          />
          <StatCard
            label="Today"
            value={formatBytes(todayTotal)}
            sub="Since 00:00 UTC"
            icon="today"
          />
          <StatCard
            label="Alert status"
            value={anyAlert ? 'Over budget' : 'OK'}
            tone={anyAlert ? 'danger' : 'success'}
            sub={
              THRESHOLD_BYTES
                ? `Threshold: ${formatBytes(THRESHOLD_BYTES)} per server`
                : 'No threshold configured (LOBBYFORGE_BANDWIDTH_ALERT_BYTES unset)'
            }
            icon={anyAlert ? 'warning' : 'check_circle'}
          />
        </section>

        <section className="space-y-4">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">
            Per-server breakdown
          </h2>
          <div className="rounded-xl bg-surface border border-border-subtle divide-y divide-border-subtle/50">
            {loading ? (
              <div className="p-6 text-sm text-text-muted">Loading…</div>
            ) : totals.length === 0 ? (
              <div className="p-6 text-sm text-text-muted">
                No servers yet. Create a community to start tracking bandwidth.
              </div>
            ) : (
              totals.map((s) => (
                <ServerBandwidthRow
                  key={s.serverId}
                  total={s}
                  onAcknowledge={() => acknowledge(s.serverId)}
                  busy={busy}
                />
              ))
            )}
          </div>
        </section>

        <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
          <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">info</span>
          <p className="text-xs text-text-muted leading-relaxed">
            Bandwidth is measured at each connected client using LiveKit&apos;s RTC stats and
            accumulated in Redis. The numbers are an estimate — actual server-side traffic at the
            LiveKit SFU may be slightly higher because of packet overhead and retransmits.
            {THRESHOLD_BYTES
              ? ` Alert threshold is configured at ${formatBytes(THRESHOLD_BYTES)} per server.`
              : ' Set LOBBYFORGE_BANDWIDTH_ALERT_BYTES on the server to enable alerts.'}
          </p>
        </div>

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </SettingsShell>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub: string;
  icon: string;
  tone?: 'default' | 'success' | 'danger';
}) {
  const valueClass =
    tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-text-primary';
  return (
    <div className="rounded-xl bg-surface border border-border-subtle p-5 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`material-symbols-outlined text-[18px] ${valueClass}`}>{icon}</span>
        <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      </div>
      <p className={`text-2xl font-semibold ${valueClass}`}>{value}</p>
      <p className="text-xs text-text-muted">{sub}</p>
    </div>
  );
}

function ServerBandwidthRow({
  total,
  onAcknowledge,
  busy,
}: {
  total: ServerTotal;
  onAcknowledge: () => void;
  busy: boolean;
}) {
  const maxHour = Math.max(1, ...total.hourly.map((h) => h.bytes));
  return (
    <div className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm text-text-primary font-medium">{total.serverName}</p>
            {total.alertTriggered ? (
              <span className="px-2 py-0.5 rounded-full bg-danger/15 text-danger text-[10px] uppercase tracking-wider font-bold">
                Alert
              </span>
            ) : null}
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            Total {formatBytes(total.totalBytes)} · Today {formatBytes(total.todayBytes)}
          </p>
        </div>
        {total.alertTriggered ? (
          <button
            type="button"
            onClick={onAcknowledge}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-border-strong text-xs text-text-secondary hover:bg-surface-raised disabled:opacity-40"
          >
            Acknowledge
          </button>
        ) : null}
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-2">Last 24 hours (UTC)</p>
        <div className="flex items-end gap-1 h-16">
          {total.hourly.length === 0 ? (
            <p className="text-xs text-text-muted italic">No data yet.</p>
          ) : (
            total.hourly.map((h) => (
              <div
                key={h.hour}
                title={`${formatHour(h.hour)} — ${formatBytes(h.bytes)}`}
                className="flex-1 rounded-sm bg-primary/40 hover:bg-primary transition-colors"
                style={{ height: `${Math.max(2, (h.bytes / maxHour) * 100)}%` }}
              />
            ))
          )}
        </div>
        <div className="flex justify-between text-[10px] text-text-muted mt-1">
          <span>{total.hourly[0] ? formatHour(total.hourly[0].hour) : ''}</span>
          <span>{total.hourly[total.hourly.length - 1] ? formatHour(total.hourly[total.hourly.length - 1].hour) : ''}</span>
        </div>
      </div>
    </div>
  );
}
