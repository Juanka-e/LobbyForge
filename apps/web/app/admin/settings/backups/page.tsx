import { cookies } from 'next/headers';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import {
  loadBackupManifest,
  verifyBackupManifest,
  type BackupVerification,
} from '@/lib/backup-verifier';
import SettingsShell from '@/app/SettingsShell';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Backups - Community Settings',
};

interface BackupState {
  source: string;
  verification: BackupVerification | null;
  error: string | null;
}

export default async function BackupsSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Backups</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const state = await loadBackupState();

  return (
    <SettingsShell scope="community">
      <BackupsBody state={state} />
    </SettingsShell>
  );
}

async function loadBackupState(): Promise<BackupState> {
  const source = process.env.LOBBYFORGE_BACKUP_MANIFEST ?? 'infra/update/backup-manifest.example.json';
  try {
    const { manifest, baseDir } = await loadBackupManifest(source);
    const verification = await verifyBackupManifest(manifest, {
      baseDir,
      requireFileExists: true,
    });
    return { source, verification, error: null };
  } catch (err) {
    return {
      source,
      verification: null,
      error: sanitizeBackupError(err),
    };
  }
}

function sanitizeBackupError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Backup manifest could not be loaded.';
  if (/ENOENT|no such file|cannot find/i.test(message)) {
    return 'No backup manifest was found. Configure LOBBYFORGE_BACKUP_MANIFEST after your backup worker writes a manifest.';
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function BackupsBody({ state }: { state: BackupState }) {
  const verification = state.verification;
  const checks = verification?.checks ?? [];
  const failed = checks.filter((check) => !check.ok).length;
  const passed = checks.filter((check) => check.ok).length;
  const isReady = Boolean(verification?.ok);

  return (
    <section className="max-w-4xl mx-auto pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Backups</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Verify the latest backup manifest before updates or restore work.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6">
        <Chip label={isReady ? 'Backup verified' : 'Backup not verified'} tone={isReady ? 'success' : 'danger'} />
        <Chip label={`${passed} checks passed`} />
        <Chip label={`${failed} checks failed`} tone={failed > 0 ? 'danger' : 'muted'} />
      </div>

      {state.error ? (
        <div className="mb-6 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {state.error}
        </div>
      ) : null}

      <div className="mb-6 rounded-xl bg-surface-raised border border-border-subtle p-6">
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Status" value={isReady ? 'Verified' : 'Needs attention'} tone={isReady ? 'success' : 'danger'} />
          <Stat label="Backup id" value={verification?.backupId ?? 'none'} />
          <Stat label="Created" value={formatDate(verification?.createdAt)} />
          <Stat label="Age" value={formatAge(verification?.ageMs)} />
        </div>
      </div>

      <Section title="Verification Checks" icon="fact_check">
        {checks.length > 0 ? (
          <ul className="divide-y divide-border-subtle/50">
            {checks.map((check) => (
              <li key={check.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 p-4">
                <span className={`material-symbols-outlined text-[18px] ${check.ok ? 'text-success' : 'text-danger'}`}>
                  {check.ok ? 'check_circle' : 'error'}
                </span>
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{check.message}</p>
                  <p className="mt-0.5 text-xs text-text-muted">{check.id}</p>
                </div>
                <span className={check.ok ? 'text-xs font-medium text-success' : 'text-xs font-medium text-danger'}>
                  {check.ok ? 'Pass' : 'Fail'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-5 text-sm text-text-muted">
            No verification checks are available until a backup manifest is configured.
          </p>
        )}
      </Section>

      <Section title="Required Production Contract" icon="security">
        <ul className="divide-y divide-border-subtle/50">
          <ContractRow label="Backup worker" value="Must write a manifest after every completed backup." />
          <ContractRow label="Manifest path" value={state.source} />
          <ContractRow label="Artifact check" value="Database dump and listed files must exist on disk." />
          <ContractRow label="Update gate" value="Apply/rollback stays blocked unless backup verification passes." />
        </ul>
      </Section>

      <div className="mt-6 rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
        <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">info</span>
        <p className="text-xs text-text-muted leading-relaxed">
          This page does not create or restore backups yet. It only verifies the manifest produced by
          the self-host backup worker so admins do not rely on unverified restore points.
        </p>
      </div>
    </section>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-3 text-text-muted">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
        <h2 className="text-xs uppercase tracking-wider font-semibold">{title}</h2>
        <div className="h-px bg-border-subtle flex-1 ml-4" />
      </div>
      <div className="bg-surface-raised border border-border-subtle rounded-xl overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function ContractRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="grid gap-1 p-4 md:grid-cols-[180px_1fr] md:gap-4">
      <span className="text-sm font-medium text-text-primary">{label}</span>
      <span className="break-words text-sm text-text-secondary">{value}</span>
    </li>
  );
}

function Stat({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'success' | 'danger';
}) {
  const valueClass =
    tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-primary';
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`text-sm font-medium ${valueClass}`}>{value}</p>
    </div>
  );
}

function Chip({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'success' | 'danger' }) {
  const className =
    tone === 'success'
      ? 'px-3 py-1.5 rounded-full bg-surface border border-border-subtle text-success text-xs font-medium'
      : tone === 'danger'
        ? 'px-3 py-1.5 rounded-full bg-surface border border-danger/40 text-danger text-xs font-medium'
        : 'px-3 py-1.5 rounded-full bg-surface border border-border-subtle text-text-secondary text-xs font-medium';
  return <span className={className}>{label}</span>;
}

function formatDate(value: string | undefined): string {
  if (!value) return 'none';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'invalid date';
  return date.toLocaleString();
}

function formatAge(ageMs: number | undefined): string {
  if (ageMs === undefined || ageMs < 0) return 'unknown';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
