import { cookies } from 'next/headers';
import { sql } from 'drizzle-orm';
import {
  attachments,
  getInstanceSetupStatus,
  listServersForUser,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Storage - Community Settings',
};

interface StorageBreakdownRow {
  bucket: string;
  bytes: number;
  count: number;
}

interface StorageSummary {
  totalBytes: number;
  totalCount: number;
  byBucket: StorageBreakdownRow[];
  reclaimableBytes: number;
}

/**
 * Aggregate storage usage across the instance's attachment table.
 *
 * Voice recordings aren't tracked yet (M22+ scope) — we only count
 * `attachments.sizeBytes`. Bucketed by `mimeType` prefix so admins can
 * see how much of their budget is going to images vs videos vs
 * generic files. "Reclaimable" is a soft estimate based on attachments
 * older than 90 days; the retention policy is a future setting, this
 * is purely informational.
 */
async function loadStorageSummary(): Promise<StorageSummary> {
  const db = getDb();
  // Bucket by mime prefix (image / video / audio / application / other).
  // We use a CASE WHEN to map to a small enum so the UI can group rows
  // without parsing strings in JavaScript.
  const bucketExpr = sql<string>`
    CASE
      WHEN ${attachments.mimeType} LIKE 'image/%' THEN 'image'
      WHEN ${attachments.mimeType} LIKE 'video/%' THEN 'video'
      WHEN ${attachments.mimeType} LIKE 'audio/%' THEN 'audio'
      WHEN ${attachments.mimeType} LIKE 'application/%' THEN 'file'
      ELSE 'other'
    END
  `;
  const rows = await db
    .select({
      bucket: bucketExpr.as('bucket'),
      bytes: sql<number>`COALESCE(SUM(${attachments.sizeBytes}), 0)::bigint`.as('bytes'),
      count: sql<number>`COUNT(*)::int`.as('count'),
    })
    .from(attachments)
    .groupBy(bucketExpr);
  const total = rows.reduce((acc, r) => acc + Number(r.bytes ?? 0), 0);
  const totalCount = rows.reduce((acc, r) => acc + Number(r.count ?? 0), 0);

  // Reclaimable = attachments older than 90 days. Cheap single SUM.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const reclaim = await db
    .select({
      bytes: sql<number>`COALESCE(SUM(${attachments.sizeBytes}), 0)::bigint`.as('bytes'),
    })
    .from(attachments)
    .where(sql`${attachments.createdAt} < ${ninetyDaysAgo.toISOString()}`);

  return {
    totalBytes: total,
    totalCount,
    byBucket: rows.map((r) => ({
      bucket: String(r.bucket),
      bytes: Number(r.bytes ?? 0),
      count: Number(r.count ?? 0),
    })),
    reclaimableBytes: Number(reclaim[0]?.bytes ?? 0),
  };
}

/**
 * Community Settings → Storage.
 *
 * Read-only summary of attachment storage. Pulls the per-bucket
 * breakdown (image / video / audio / file / other) and an estimate of
 * how much could be reclaimed by purging attachments older than 90
 * days. The actual retention policy is a future setting; for now this
 * page is informational only.
 */
export default async function StorageSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Storage</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  // Owner / server lookup is unused for the storage read itself but
  // keeps the page consistent with the other settings pages that
  // resolve a first server. We don't want to silently load data for
  // the wrong tenant if the admin context changes later.
  await getInstanceSetupStatus(getDb());
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  if (session?.uid) {
    await listServersForUser(getDb(), session.uid, { limit: 1 });
  }

  let summary: StorageSummary | null = null;
  let loadError: string | null = null;
  try {
    summary = await loadStorageSummary();
  } catch (err) {
    loadError = (err as Error).message;
  }

  return (
    <SettingsShell scope="community">
      <StorageBody summary={summary} loadError={loadError} />
    </SettingsShell>
  );
}

function StorageBody({
  summary,
  loadError,
}: {
  summary: StorageSummary | null;
  loadError: string | null;
}) {
  const used = summary?.totalBytes ?? 0;
  const usedCount = summary?.totalCount ?? 0;
  const reclaimable = summary?.reclaimableBytes ?? 0;
  // No upload quota is enforced yet. Keep the usage real and label quota as
  // unavailable instead of inventing a number.
  const pct = 0;

  return (
    <section className="max-w-4xl mx-auto pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Storage</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Attachment usage, retention, and reclaimable space for this community.
        </p>
      </header>

      {loadError ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger mb-4">
          Could not load storage: {loadError}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3 mb-6">
        <SummaryCard
          label="Used"
          value={formatBytes(used)}
          sub={`${usedCount} attachments`}
        />
        <SummaryCard
          label="Quota"
          value="Not enforced"
          sub="no upload quota configured"
        />
        <SummaryCard
          label="Reclaimable"
          value={formatBytes(reclaimable)}
          sub="older than 90 days"
          tone="tertiary"
        />
      </div>

      <div className="bg-surface rounded-xl border border-border-subtle p-6 mb-6">
        <h2 className="text-sm font-medium text-text-primary mb-3">Usage</h2>
        <div className="h-2 w-full bg-surface-container rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-xs text-text-muted mt-2">
          <span>{formatBytes(used)} used</span>
          <span>No enforced quota</span>
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border-subtle overflow-hidden">
        <div className="px-6 py-3 border-b border-border-subtle bg-surface-dim/40">
          <h2 className="text-sm font-medium text-text-primary">By type</h2>
        </div>
        {summary && summary.byBucket.length > 0 ? (
          <ul className="divide-y divide-border-subtle">
            {summary.byBucket
              .slice()
              .sort((a, b) => b.bytes - a.bytes)
              .map((row) => {
                const pctRow = used > 0 ? Math.round((row.bytes / used) * 100) : 0;
                return (
                  <li
                    key={row.bucket}
                    className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-6 py-3"
                  >
                    <span className="material-symbols-outlined text-text-muted text-[20px]">
                      {iconForBucket(row.bucket)}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-text-primary font-medium">
                          {labelForBucket(row.bucket)}
                        </span>
                        <span className="text-xs text-text-muted">
                          {row.count} files - {pctRow}%
                        </span>
                      </div>
                      <div className="h-1.5 mt-2 w-full bg-surface-container rounded-full overflow-hidden">
                        <div
                          className="h-full bg-tertiary rounded-full"
                          style={{ width: `${pctRow}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-sm text-text-primary">{formatBytes(row.bytes)}</span>
                  </li>
                );
              })}
          </ul>
        ) : (
          <p className="p-6 text-sm text-text-muted text-center">
            No attachments uploaded yet.
          </p>
        )}
      </div>

      <p className="mt-6 text-xs text-text-muted">
        Storage tracking covers uploaded attachments only. Voice recordings, avatars, and backups
        are tracked separately and are not in scope for this view.
      </p>
    </section>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  tone = 'primary',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'primary' | 'tertiary';
}) {
  const valueColor = tone === 'primary' ? 'text-primary-container' : 'text-tertiary';
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-5">
      <p className="text-xs uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`mt-2 text-3xl font-semibold ${valueColor}`}>{value}</p>
      <p className="text-xs text-text-muted mt-1">{sub}</p>
    </div>
  );
}

function iconForBucket(bucket: string): string {
  switch (bucket) {
    case 'image':
      return 'image';
    case 'video':
      return 'movie';
    case 'audio':
      return 'volume_up';
    case 'file':
      return 'description';
    default:
      return 'attach_file';
  }
}

function labelForBucket(bucket: string): string {
  switch (bucket) {
    case 'image':
      return 'Images';
    case 'video':
      return 'Videos';
    case 'audio':
      return 'Audio';
    case 'file':
      return 'Files';
    default:
      return 'Other';
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  const decimals = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

