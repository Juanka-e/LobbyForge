import { cookies } from 'next/headers';
import { getEffectiveInstanceMaintenance, listSystemUpdateRuns, type SystemUpdateRunRow } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import type { Translator } from '@/lib/i18n/core';
import { getTranslator } from '@/lib/i18n/server';
import { buildUpdatePlan, loadReleaseManifest } from '@/lib/update-planner';
import SettingsShell from '@/app/SettingsShell';
import UpdateControls from './UpdateControls';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/*
 * Words for the enum values this page shows. Version strings, channel
 * names, commands and server-sent failures stay as sent; a value with no
 * label here (a status added later) also shows as-is.
 */
const RUN_STATUS_LABEL_KEYS: Record<string, string> = {
  planned: 'admin.updates.status.planned',
  locked: 'admin.updates.status.locked',
  running: 'admin.updates.status.running',
  succeeded: 'admin.updates.status.succeeded',
  failed: 'admin.updates.status.failed',
  rolled_back: 'admin.updates.status.rolled_back',
  blocked: 'admin.updates.status.blocked',
};

const RUN_ACTION_LABEL_KEYS: Record<string, string> = {
  'dry-run': 'admin.updates.action.dryRun',
  apply: 'admin.updates.action.apply',
  rollback: 'admin.updates.action.rollback',
};

const SIGNATURE_LABEL_KEYS: Record<string, string> = {
  valid: 'admin.updates.signature.valid',
  invalid: 'admin.updates.signature.invalid',
  missing: 'admin.updates.signature.missing',
  not_configured: 'admin.updates.signature.not_configured',
};

/** Plan step titles by step id (`lib/update-planner.ts`); unknown ids keep the planner's title. */
const STEP_TITLE_KEYS: Record<string, string> = {
  'preflight-doctor': 'admin.updates.step.preflight-doctor',
  backup: 'admin.updates.step.backup',
  'pull-images': 'admin.updates.step.pull-images',
  'migration-dry-run': 'admin.updates.step.migration-dry-run',
  'apply-migrations': 'admin.updates.step.apply-migrations',
  'recreate-services': 'admin.updates.step.recreate-services',
  'health-check': 'admin.updates.step.health-check',
};

/** A label for an enum value, or the value itself when it has none. */
function labelFor(t: Translator, keys: Record<string, string>, value: string): string {
  const key = keys[value];
  return key ? t(key) : value;
}

export default async function UpdatesPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  const t = await getTranslator();
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('admin.updates.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }

  const plan = buildUpdatePlan(await loadReleaseManifest());
  const maintenance = await getEffectiveInstanceMaintenance(getDb()).catch((err: unknown) => ({
    instanceId: 'self-host',
    maintenanceMode: false,
    maintenanceMessage: t('admin.updates.maintenanceUnavailable', { error: (err as Error).message }),
    maintenanceStartedAt: null,
    maintenanceUpdatedAt: null,
  }));
  let history: SystemUpdateRunRow[] = [];
  let historyError: string | null = null;
  try {
    history = await listSystemUpdateRuns(getDb(), { limit: 8 });
  } catch (err) {
    historyError = (err as Error).message;
  }

  return (
    <SettingsShell scope="community">
      <section>
        <h1 className="text-2xl font-semibold text-text-primary">{t('admin.updates.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t('admin.updates.versionLine', {
            current: plan.currentVersion,
            latest: plan.latestVersion,
            channel: plan.channel,
          })}
        </p>

        <div
          className="grid gap-3 my-4"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
        >
          <Badge
            label={t('admin.updates.badge.update')}
            value={plan.updateAvailable ? t('admin.updates.value.available') : t('admin.updates.value.none')}
            tone={plan.updateAvailable ? 'warn' : 'ok'}
          />
          <Badge
            label={t('admin.updates.badge.major')}
            value={plan.majorUpgrade ? t('admin.updates.value.yes') : t('admin.updates.value.no')}
            tone={plan.majorUpgrade ? 'bad' : 'ok'}
          />
          <Badge
            label={t('admin.updates.badge.supported')}
            value={plan.currentSupported ? t('admin.updates.value.yes') : t('admin.updates.value.no')}
            tone={plan.currentSupported ? 'ok' : 'bad'}
          />
          <Badge
            label={t('admin.updates.badge.signature')}
            value={labelFor(t, SIGNATURE_LABEL_KEYS, plan.signature.status)}
            tone={plan.signature.verified ? 'ok' : plan.signature.status === 'not_configured' ? 'warn' : 'bad'}
          />
          <Badge
            label={t('admin.updates.badge.maintenance')}
            value={maintenance.maintenanceMode ? t('admin.updates.value.on') : t('admin.updates.value.off')}
            tone={maintenance.maintenanceMode ? 'ok' : 'warn'}
          />
          <Badge label={t('admin.updates.badge.apply')} value={t('admin.updates.value.gated')} tone="warn" />
        </div>

        <UpdateControls
          majorUpgrade={plan.majorUpgrade}
          maintenanceMode={maintenance.maintenanceMode}
          signatureVerified={plan.signature.verified}
        />

        {maintenance.maintenanceMessage ? (
          <section className="mt-4 rounded-lg border border-border-subtle p-4">
            <h2 className="text-lg font-semibold text-text-primary">{t('admin.updates.maintenanceTitle')}</h2>
            <p className={`mt-1 text-sm ${maintenance.maintenanceMode ? 'text-text-primary' : 'text-text-secondary'}`}>
              {maintenance.maintenanceMessage}
            </p>
          </section>
        ) : null}

        {plan.releaseNotes ? (
          <section className="mt-4 rounded-lg border border-border-subtle p-4">
            <h2 className="text-lg font-semibold text-text-primary">{t('admin.updates.releaseNotes')}</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">{plan.releaseNotes}</p>
          </section>
        ) : null}

        <section className="mt-4 rounded-lg border border-border-subtle p-4">
          <h2 className="text-lg font-semibold text-text-primary">{t('admin.updates.planTitle')}</h2>
          <ol className="pl-6 mt-2">
            {plan.steps.map((step) => (
              <li key={step.id} className="mb-3">
                <strong className="text-sm text-text-primary">
                  {STEP_TITLE_KEYS[step.id] ? t(STEP_TITLE_KEYS[step.id]!) : step.title}
                </strong>
                <pre className="mt-1 p-2 bg-background border border-border-subtle rounded-md overflow-x-auto text-xs text-text-secondary">
                  {step.command}
                </pre>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-amber-400">{t('admin.updates.gatesNote')}</p>
        </section>

        <section className="mt-4 rounded-lg border border-border-subtle p-4">
          <h2 className="text-lg font-semibold text-text-primary">{t('admin.updates.recentRuns')}</h2>
          {historyError ? (
            <p className="mt-1 text-sm text-amber-400">
              {t('admin.updates.historyUnavailable', { error: historyError })}
            </p>
          ) : history.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">{t('admin.updates.noRuns')}</p>
          ) : (
            <div className="mt-2 grid gap-2">
              {history.map((run) => (
                <div
                  key={run.id}
                  className="grid gap-2 border border-border-subtle rounded-md p-2 text-sm"
                  style={{ gridTemplateColumns: 'minmax(110px, 1fr) minmax(120px, 1fr) minmax(160px, 2fr) auto' }}
                >
                  <strong className={statusColor(run.status)}>
                    {labelFor(t, RUN_STATUS_LABEL_KEYS, run.status)}
                  </strong>
                  <span className="text-text-primary">{labelFor(t, RUN_ACTION_LABEL_KEYS, run.action)}</span>
                  <span className="text-text-muted">
                    {t('admin.updates.runSummary', {
                      from: run.fromVersion,
                      to: run.toVersion,
                      date: run.startedAt.toISOString(),
                    })}
                  </span>
                  <a href={`/admin/updates/${run.id}`} className="text-primary hover:underline">
                    {t('admin.updates.details')}
                  </a>
                </div>
              ))}
            </div>
          )}
        </section>
      </section>
    </SettingsShell>
  );
}

function Badge({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? '#5ad48a' : tone === 'warn' ? '#e3b341' : '#e36049';
  return (
    <div style={{ border: '1px solid #1f242c', borderRadius: 8, padding: 12 }}>
      <span style={{ color: '#9aa3ad', fontSize: 12 }}>{label}</span>
      <strong style={{ display: 'block', color, fontSize: 18 }}>{value}</strong>
    </div>
  );
}

function statusColor(status: string): string {
  if (status === 'succeeded' || status === 'rolled_back') return '#5ad48a';
  if (status === 'failed') return '#e36049';
  return '#e3b341';
}
