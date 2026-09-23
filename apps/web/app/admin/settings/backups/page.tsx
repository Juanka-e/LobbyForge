import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import {
  loadBackupManifest,
  verifyBackupManifest,
  type BackupVerification,
} from '@/lib/backup-verifier';
import type { Translator } from '@/lib/i18n/core';
import { getTranslator } from '@/lib/i18n/server';
import SettingsShell from '@/app/SettingsShell';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('adminSettings.backups.metaTitle') };
}

interface BackupState {
  source: string;
  verification: BackupVerification | null;
  error: string | null;
}

export default async function BackupsSettingsPage() {
  const t = await getTranslator();
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.backups.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }

  const state = await loadBackupState(t);

  return (
    <SettingsShell scope="community">
      <BackupsBody t={t} state={state} />
    </SettingsShell>
  );
}

async function loadBackupState(t: Translator): Promise<BackupState> {
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
      error: sanitizeBackupError(t, err),
    };
  }
}

function sanitizeBackupError(t: Translator, err: unknown): string {
  const message = err instanceof Error ? err.message : t('adminSettings.backups.loadFailed');
  if (/ENOENT|no such file|cannot find/i.test(message)) {
    return t('adminSettings.backups.noManifest', { env: 'LOBBYFORGE_BACKUP_MANIFEST' });
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function BackupsBody({ t, state }: { t: Translator; state: BackupState }) {
  const verification = state.verification;
  const checks = verification?.checks ?? [];
  const failed = checks.filter((check) => !check.ok).length;
  const passed = checks.filter((check) => check.ok).length;
  const isReady = Boolean(verification?.ok);

  return (
    <section className="max-w-4xl mx-auto pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.backups.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.backups.subtitle')}</p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6">
        <Chip
          label={isReady ? t('adminSettings.backups.verified') : t('adminSettings.backups.notVerified')}
          tone={isReady ? 'success' : 'danger'}
        />
        <Chip label={t('adminSettings.backups.passedCount', { count: passed })} />
        <Chip
          label={t('adminSettings.backups.failedCount', { count: failed })}
          tone={failed > 0 ? 'danger' : 'muted'}
        />
      </div>

      {state.error ? (
        <div className="mb-6 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {state.error}
        </div>
      ) : null}

      <div className="mb-6 rounded-xl bg-surface-raised border border-border-subtle p-6">
        <div className="grid gap-4 md:grid-cols-4">
          <Stat
            label={t('adminSettings.backups.stat.status')}
            value={isReady ? t('adminSettings.backups.stat.statusReady') : t('adminSettings.backups.stat.statusAttention')}
            tone={isReady ? 'success' : 'danger'}
          />
          <Stat
            label={t('adminSettings.backups.stat.backupId')}
            value={verification?.backupId ?? t('adminSettings.backups.none')}
          />
          <Stat label={t('adminSettings.backups.stat.created')} value={formatDate(t, verification?.createdAt)} />
          <Stat label={t('adminSettings.backups.stat.age')} value={formatAge(t, verification?.ageMs)} />
        </div>
      </div>

      <Section title={t('adminSettings.backups.checks.title')} icon="fact_check">
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
                  {check.ok ? t('adminSettings.backups.checks.pass') : t('adminSettings.backups.checks.fail')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-5 text-sm text-text-muted">{t('adminSettings.backups.checks.empty')}</p>
        )}
      </Section>

      <Section title={t('adminSettings.backups.contract.title')} icon="security">
        <ul className="divide-y divide-border-subtle/50">
          <ContractRow
            label={t('adminSettings.backups.contract.workerLabel')}
            value={t('adminSettings.backups.contract.workerValue')}
          />
          <ContractRow label={t('adminSettings.backups.contract.manifestPath')} value={state.source} />
          <ContractRow
            label={t('adminSettings.backups.contract.artifactLabel')}
            value={t('adminSettings.backups.contract.artifactValue')}
          />
          <ContractRow
            label={t('adminSettings.backups.contract.gateLabel')}
            value={t('adminSettings.backups.contract.gateValue')}
          />
        </ul>
      </Section>

      <div className="mt-6 rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
        <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">info</span>
        <p className="text-xs text-text-muted leading-relaxed">{t('adminSettings.backups.footer')}</p>
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

function formatDate(t: Translator, value: string | undefined): string {
  if (!value) return t('adminSettings.backups.none');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('adminSettings.backups.invalidDate');
  return date.toLocaleString(t.locale);
}

function formatAge(t: Translator, ageMs: number | undefined): string {
  if (ageMs === undefined || ageMs < 0) return t('adminSettings.backups.age.unknown');
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return t('adminSettings.backups.age.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t('adminSettings.backups.age.hours', { count: hours });
  return t('adminSettings.backups.age.days', { count: Math.floor(hours / 24) });
}
