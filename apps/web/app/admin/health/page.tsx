import type { AlertLevel, DoctorCategory, DoctorReport } from '@lobbyforge/core';
import { cookies } from 'next/headers';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { collectDoctorReport } from '@/lib/doctor';
import { getDb } from '@/lib/db';
import { getInstanceSetupStatus, listServersForUser } from '@lobbyforge/db';
import { getServerBandwidthTotals } from '@/lib/redis';
import SettingsShell from '@/app/SettingsShell';
import HealthActions from './HealthActions';

// Server component — re-fetch on each request so admins see live data.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Doctor & Health — Community Settings',
};

/**
 * Community Settings → Doctor & Health.
 *
 * Renders the live Doctor report with the refined design: a System
 * Status list grouped by category, a Recommended Attention card for
 * non-ok checks, and a sticky Health Summary sidebar with totals and
 * the "Run Full Check" button. The report itself is re-fetched on
 * every request via `collectDoctorReport()`.
 */
export default async function HealthPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Doctor & Health</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }
  const { report } = await collectDoctorReport();

  // Fetch bandwidth totals for the sidebar summary. Non-fatal — if Redis
  // is down, the health page still renders without the bandwidth card.
  let bandwidth: { totalBytes: number; todayBytes: number; alertTriggered: boolean } | null = null;
  try {
    const setup = await getInstanceSetupStatus(getDb());
    if (setup.ownerUserId) {
      const servers = await listServersForUser(getDb(), setup.ownerUserId, { limit: 1 });
      if (servers[0]?.id) {
        const snap = await getServerBandwidthTotals(servers[0].id, { hours: 1 });
        bandwidth = {
          totalBytes: snap.totalBytes,
          todayBytes: snap.todayBytes,
          alertTriggered: snap.alertTriggered,
        };
      }
    }
  } catch {
    // Redis/DB hiccup — health page still useful without bandwidth.
  }

  return (
    <SettingsShell scope="community">
      <DoctorBody report={report} bandwidth={bandwidth} />
    </SettingsShell>
  );
}

const CATEGORY_LABELS: Record<DoctorCategory, string> = {
  system: 'System',
  network: 'Network',
  services: 'Services',
  media: 'Media',
};

const CATEGORY_ORDER: DoctorCategory[] = ['system', 'network', 'services', 'media'];

function DoctorBody({
  report,
  bandwidth,
}: {
  report: DoctorReport;
  bandwidth: { totalBytes: number; todayBytes: number; alertTriggered: boolean } | null;
}) {
  // Group checks by category so the System Status panel can render
  // each category as its own sub-section. Order is fixed by
  // CATEGORY_ORDER so the layout is stable across refreshes.
  const byCategory = new Map<DoctorCategory, typeof report.checks>();
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, []);
  for (const check of report.checks) {
    const list = byCategory.get(check.category);
    if (list) list.push(check);
  }

  const attention = report.checks.filter((c) => !c.ok && c.level !== 'info');

  return (
    <section className="grid gap-8 lg:grid-cols-12 pb-32">
      <div className="lg:col-span-8 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">Doctor & Health</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Generated {new Date(report.generatedAt).toLocaleString()} · uptime{' '}
            {report.uptimeSeconds}s
          </p>
        </header>

        <DoctorSummary summary={report.summary} ok={report.ok} />

        <CapacityCard capacity={report.capacity} />

        <section>
          <h3 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2 border-b border-border-subtle pb-2">
            <span className="material-symbols-outlined text-primary text-[20px]">health_and_safety</span>
            System Status
          </h3>
          <div className="rounded-xl border border-border-subtle bg-surface overflow-hidden divide-y divide-border-subtle">
            {CATEGORY_ORDER.flatMap((cat) => {
              const list = byCategory.get(cat) ?? [];
              return list.map((c) => <StatusRow key={`${cat}:${c.id}`} check={c} categoryLabel={CATEGORY_LABELS[cat]} />);
            })}
            {report.checks.length === 0 ? (
              <p className="p-4 text-sm text-text-muted">No checks have been registered.</p>
            ) : null}
          </div>
        </section>

        <section>
          <h3 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2 border-b border-border-subtle pb-2">
            <span className="material-symbols-outlined text-tertiary text-[20px]">priority_high</span>
            Recommended Attention
          </h3>
          {attention.length === 0 ? (
            <div className="rounded-xl border border-border-subtle bg-surface p-6 flex items-center gap-3">
              <span className="material-symbols-outlined text-success text-[20px]">check_circle</span>
              <p className="text-sm text-text-primary">All checks passed — nothing needs attention.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {attention.map((c) => (
                <article
                  key={c.id}
                  className="rounded-xl border border-border-subtle bg-surface/80 backdrop-blur-md p-5 relative overflow-hidden"
                >
                  <div className="absolute top-0 left-0 w-1 h-full bg-tertiary" />
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <h4 className="text-sm font-medium text-text-primary">{c.id}</h4>
                        <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider bg-surface-variant text-text-muted border border-border-subtle">
                          {CATEGORY_LABELS[c.category]}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border ${levelClasses(c.level).badge}`}
                        >
                          {c.level}
                        </span>
                      </div>
                      <p className="text-sm text-text-secondary mb-3 max-w-xl">{c.message}</p>
                    </div>
                    <span className="material-symbols-outlined text-tertiary/20 text-[48px] shrink-0">
                      {iconForCategory(c.category)}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2 border-b border-border-subtle pb-2">
            <span className="material-symbols-outlined text-primary text-[20px]">fact_check</span>
            All checks
          </h3>
          <ul className="list-none p-0 space-y-1">
            {report.checks.map((c) => (
              <li
                key={c.id}
                className="flex min-w-0 gap-3 border-b border-border-subtle py-3"
              >
                <span
                  aria-hidden
                  className={`material-symbols-outlined mt-0.5 w-6 flex-shrink-0 text-lg ${glyphColor(c.ok, c.level)}`}
                >
                  {glyph(c.ok, c.level)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                    <strong className="break-words text-sm text-text-primary">{c.id}</strong>
                    <span className="text-xs text-text-muted">{CATEGORY_LABELS[c.category]}</span>
                  </div>
                  <p className="mt-1 break-words text-pretty text-sm text-text-secondary">{c.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <aside className="lg:col-span-4">
        <div className="bg-surface/80 backdrop-blur-md rounded-xl border border-border-subtle p-6 sticky top-8 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium text-text-primary">Health Summary</h3>
            <span className="material-symbols-outlined text-text-muted">monitor_heart</span>
          </div>
          <div className="space-y-3">
            <SummaryRow label="Total Checks" value={report.checks.length} />
            <SummaryRow label="Passed" value={report.summary.ok} tone="success" />
            <SummaryRow label="Warnings" value={report.summary.warning} tone="tertiary" />
            <SummaryRow label="Critical" value={report.summary.critical} tone="danger" />
            <SummaryRow label="Fatal" value={report.summary.fatal} tone="danger" />
          </div>
          <div className="space-y-2">
            <HealthActions report={report} />
          </div>
          <p className="text-xs text-text-muted flex items-start gap-2 pt-4 border-t border-border-subtle">
            <span className="material-symbols-outlined text-[14px] shrink-0">info</span>
            Doctor & Health shows safe diagnostics only. Running checks will not affect active
            voice sessions.
          </p>

          {/* Bandwidth summary — links to /admin/bandwidth for detail */}
          {bandwidth ? (
            <div className="pt-4 border-t border-border-subtle space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-text-primary">Bandwidth</h4>
                <a
                  href="/admin/bandwidth"
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  Details
                  <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                </a>
              </div>
              <div className="space-y-2">
                <SummaryRow
                  label="Total"
                  value={formatBytes(bandwidth.totalBytes)}
                />
                <SummaryRow
                  label="Today"
                  value={formatBytes(bandwidth.todayBytes)}
                />
                <SummaryRow
                  label="Status"
                  value={bandwidth.alertTriggered ? 'Over budget' : 'OK'}
                  tone={bandwidth.alertTriggered ? 'danger' : 'success'}
                />
              </div>
            </div>
          ) : null}
        </div>
      </aside>
    </section>
  );
}

function DoctorSummary({ summary, ok }: Pick<DoctorReport, 'summary' | 'ok'>) {
  return (
    <div
      className={`flex gap-4 p-4 rounded-xl border ${
        ok
          ? 'bg-success/5 border-success/30'
          : 'bg-danger/5 border-danger/30'
      }`}
    >
      <Badge label="ok" value={summary.ok} tone="ok" />
      <Badge label="warnings" value={summary.warning} tone="warn" />
      <Badge label="critical" value={summary.critical} tone="bad" />
      <Badge label="fatal" value={summary.fatal} tone="bad" />
    </div>
  );
}

function CapacityCard({ capacity }: { capacity: DoctorReport['capacity'] }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-6">
      <h2 className="text-lg font-semibold text-text-primary mb-2">
        Recommended profile ({capacity.tier})
      </h2>
      <ul className="text-sm text-text-secondary grid gap-1 md:grid-cols-2">
        <li>Max voice users per room: {capacity.maxVoiceUsersPerRoom}</li>
        <li>Max camera users per room: {capacity.maxCameraUsersPerRoom}</li>
        <li>Max screen share per room: {capacity.maxScreenSharePerRoom}</li>
        <li>Video default: {capacity.videoDefault}</li>
        <li>Layout: {capacity.layout}</li>
      </ul>
      <p className="text-xs text-text-muted mt-3">{capacity.guidance}</p>
      <details className="mt-3">
        <summary className="text-xs text-text-muted cursor-pointer">Rationale</summary>
        <ul className="text-xs text-text-muted list-disc pl-5 mt-2 space-y-1">
          {capacity.rationale.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function StatusRow({
  check,
  categoryLabel,
}: {
  check: DoctorReport['checks'][number];
  categoryLabel: string;
}) {
  const tone = levelClasses(check.level);
  const borderClass = !check.ok && check.level !== 'info' ? tone.rowBorder : 'border-transparent';
  return (
    <div
      className={`flex items-center justify-between p-4 hover:bg-surface-variant/50 transition-colors border-l-2 ${borderClass}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className={`material-symbols-outlined text-[20px] ${tone.icon}`}>
          {glyph(check.ok, check.level)}
        </span>
        <div className="min-w-0">
          <p className="text-sm text-text-primary truncate">{check.id}</p>
          <p className="text-xs text-text-muted truncate">{categoryLabel}</p>
        </div>
      </div>
      <span className={`text-xs font-medium ${tone.value}`}>
        {!check.ok && check.level !== 'info' ? capitalize(check.level) : check.ok ? 'Healthy' : 'Info'}
      </span>
    </div>
  );
}

function Badge({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? '#5ad48a' : tone === 'warn' ? '#e3b341' : '#e36049';
  return (
    <div className="flex flex-col">
      <span className="text-xs text-text-muted">{label}</span>
      <strong style={{ color, fontSize: 20 }}>{value}</strong>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: number | string;
  tone?: 'primary' | 'success' | 'tertiary' | 'danger';
}) {
  const colorClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'tertiary'
        ? 'text-tertiary'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-text-secondary';
  return (
    <div className="flex justify-between items-center">
      <span className={`text-sm ${colorClass}`}>{label}</span>
      <span className="text-sm text-text-primary font-medium">{value}</span>
    </div>
  );
}

function glyph(ok: boolean, level: AlertLevel): string {
  if (ok) return 'check_circle';
  if (level === 'warning') return 'warning';
  if (level === 'critical' || level === 'fatal') return 'error';
  return 'info';
}

function glyphColor(ok: boolean, level: AlertLevel): string {
  if (ok) return 'text-success';
  if (level === 'warning') return 'text-tertiary';
  return 'text-danger';
}

function levelClasses(level: AlertLevel): {
  icon: string;
  value: string;
  badge: string;
  rowBorder: string;
} {
  if (level === 'warning')
    return {
      icon: 'text-tertiary',
      value: 'text-tertiary',
      badge: 'bg-tertiary/10 text-tertiary border-tertiary/30',
      rowBorder: 'border-tertiary',
    };
  if (level === 'critical' || level === 'fatal')
    return {
      icon: 'text-danger',
      value: 'text-danger',
      badge: 'bg-danger/10 text-danger border-danger/30',
      rowBorder: 'border-danger',
    };
  return {
    icon: 'text-text-muted',
    value: 'text-text-muted',
    badge: 'bg-surface-variant text-text-muted border-border-subtle',
    rowBorder: 'border-transparent',
  };
}

function iconForCategory(cat: DoctorCategory): string {
  switch (cat) {
    case 'system':
      return 'memory';
    case 'network':
      return 'lan';
    case 'services':
      return 'hub';
    case 'media':
      return 'movie';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
