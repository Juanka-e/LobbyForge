import { cookies } from 'next/headers';
import { getEffectiveInstanceMaintenance, listSystemUpdateRuns, type SystemUpdateRunRow } from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getDb } from '@/lib/db';
import { buildUpdatePlan, loadReleaseManifest } from '@/lib/update-planner';
import SettingsShell from '@/app/SettingsShell';
import UpdateControls from './UpdateControls';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function UpdatesPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">System Updates</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const plan = buildUpdatePlan(await loadReleaseManifest());
  const maintenance = await getEffectiveInstanceMaintenance(getDb()).catch((err: unknown) => ({
    instanceId: 'self-host',
    maintenanceMode: false,
    maintenanceMessage: `Unavailable: ${(err as Error).message}`,
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
        <h1 className="text-2xl font-semibold text-text-primary">System Updates</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Current {plan.currentVersion} · latest {plan.latestVersion} · channel {plan.channel}
        </p>

        <div
          className="grid gap-3 my-4"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
        >
          <Badge label="update" value={plan.updateAvailable ? 'available' : 'none'} tone={plan.updateAvailable ? 'warn' : 'ok'} />
          <Badge label="major" value={plan.majorUpgrade ? 'yes' : 'no'} tone={plan.majorUpgrade ? 'bad' : 'ok'} />
          <Badge label="supported" value={plan.currentSupported ? 'yes' : 'no'} tone={plan.currentSupported ? 'ok' : 'bad'} />
          <Badge
            label="signature"
            value={plan.signature.status}
            tone={plan.signature.verified ? 'ok' : plan.signature.status === 'not_configured' ? 'warn' : 'bad'}
          />
          <Badge label="maintenance" value={maintenance.maintenanceMode ? 'on' : 'off'} tone={maintenance.maintenanceMode ? 'ok' : 'warn'} />
          <Badge label="apply" value="gated" tone="warn" />
        </div>

        <UpdateControls
          majorUpgrade={plan.majorUpgrade}
          maintenanceMode={maintenance.maintenanceMode}
          signatureVerified={plan.signature.verified}
        />

        {maintenance.maintenanceMessage ? (
          <section className="mt-4 rounded-lg border border-border-subtle p-4">
            <h2 className="text-lg font-semibold text-text-primary">Maintenance</h2>
            <p className={`mt-1 text-sm ${maintenance.maintenanceMode ? 'text-text-primary' : 'text-text-secondary'}`}>
              {maintenance.maintenanceMessage}
            </p>
          </section>
        ) : null}

        {plan.releaseNotes ? (
          <section className="mt-4 rounded-lg border border-border-subtle p-4">
            <h2 className="text-lg font-semibold text-text-primary">Release Notes</h2>
            <p className="mt-1 whitespace-pre-wrap text-sm text-text-primary">{plan.releaseNotes}</p>
          </section>
        ) : null}

        <section className="mt-4 rounded-lg border border-border-subtle p-4">
          <h2 className="text-lg font-semibold text-text-primary">Update Plan</h2>
          <ol className="pl-6 mt-2">
            {plan.steps.map((step) => (
              <li key={step.id} className="mb-3">
                <strong className="text-sm text-text-primary">{step.title}</strong>
                <pre className="mt-1 p-2 bg-background border border-border-subtle rounded-md overflow-x-auto text-xs text-text-secondary">
                  {step.command}
                </pre>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-amber-400">
            Apply and rollback require maintenance mode, verified signature, verified backup, admin confirmation,
            worker execution env flags, and an explicit execute request.
          </p>
        </section>

        <section className="mt-4 rounded-lg border border-border-subtle p-4">
          <h2 className="text-lg font-semibold text-text-primary">Recent Runs</h2>
          {historyError ? (
            <p className="mt-1 text-sm text-amber-400">History unavailable: {historyError}</p>
          ) : history.length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">No update runs recorded yet.</p>
          ) : (
            <div className="mt-2 grid gap-2">
              {history.map((run) => (
                <div
                  key={run.id}
                  className="grid gap-2 border border-border-subtle rounded-md p-2 text-sm"
                  style={{ gridTemplateColumns: 'minmax(110px, 1fr) minmax(120px, 1fr) minmax(160px, 2fr) auto' }}
                >
                  <strong className={statusColor(run.status)}>{run.status}</strong>
                  <span className="text-text-primary">{run.action}</span>
                  <span className="text-text-muted">
                    {run.fromVersion} to {run.toVersion} - {run.startedAt.toISOString()}
                  </span>
                  <a href={`/admin/updates/${run.id}`} className="text-primary hover:underline">
                    Details
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
