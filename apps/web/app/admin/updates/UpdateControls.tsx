'use client';

import { useMemo, useState } from 'react';

type UpdateAction = 'dry-run' | 'apply' | 'rollback';

interface UpdateControlsProps {
  majorUpgrade: boolean;
  maintenanceMode: boolean;
  signatureVerified: boolean;
}

interface UpdateResponse {
  error?: string;
  detail?: string;
  policy?: { mode: string; allowed: boolean; failures: string[] };
  execution?: { status: string; failures: string[] };
  updateRun?: { id: string; status: string };
  run?: { failures: string[]; gates: Record<string, boolean> };
  worker?: { status: string; failures: string[] };
}

/**
 * Simplified one-click update controls. The underlying API gates are
 * preserved (maintenance mode + signature + backup + confirmation), but
 * the UI collapses the multi-step checkbox flow into clear action buttons
 * with inline guidance when a gate is missing.
 */
export default function UpdateControls({ majorUpgrade, maintenanceMode, signatureVerified }: UpdateControlsProps) {
  const [loading, setLoading] = useState<UpdateAction | null>(null);
  const [result, setResult] = useState<UpdateResponse | null>(null);
  const [confirmAction, setConfirmAction] = useState<UpdateAction | null>(null);

  // Gates that must be satisfied before a real execute.
  const gatesMissing = useMemo(() => {
    const missing: string[] = [];
    if (!maintenanceMode) missing.push('Maintenance mode is OFF — enable it first');
    if (!signatureVerified) missing.push('Release signature not verified');
    return missing;
  }, [maintenanceMode, signatureVerified]);

  async function runAction(act: UpdateAction, execute: boolean) {
    setLoading(act);
    setResult(null);
    try {
      const res = await fetch('/api/admin/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: act,
          adminConfirmed: true,
          majorConfirmed: !majorUpgrade || confirmAction === 'apply',
          execute,
        }),
      });
      const data = (await res.json()) as UpdateResponse;
      setResult(data);
    } catch (err) {
      setResult({ error: 'Request failed', detail: (err as Error).message });
    } finally {
      setLoading(null);
      setConfirmAction(null);
    }
  }

  return (
    <section className="rounded-xl border border-border-subtle bg-surface p-5 mb-4">
      <h2 className="text-lg font-semibold text-text-primary mb-4">Update Controls</h2>

      {/* Quick action buttons */}
      <div className="grid gap-3 sm:grid-cols-3">
        {/* Check for updates (dry-run) */}
        <button
          onClick={() => runAction('dry-run', false)}
          disabled={loading !== null}
          className="rounded-lg border border-border-subtle bg-surface-raised px-4 py-3 text-sm font-medium text-text-primary hover:bg-surface-container transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-[18px]">{loading === 'dry-run' ? 'progress_activity' : 'search'}</span>
          Check for Updates
        </button>

        {/* Upgrade */}
        <button
          onClick={() => {
            if (gatesMissing.length > 0) return;
            if (confirmAction === 'apply') runAction('apply', true);
            else setConfirmAction('apply');
          }}
          disabled={loading !== null || gatesMissing.length > 0}
          className={`rounded-lg px-4 py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
            confirmAction === 'apply'
              ? 'bg-warning text-on-warning ring-2 ring-warning/40'
              : gatesMissing.length > 0
                ? 'border border-border-subtle bg-surface-raised text-text-muted cursor-not-allowed opacity-50'
                : 'border border-success/40 bg-success/10 text-success hover:bg-success/20'
          }`}
        >
          <span className="material-symbols-outlined text-[18px]">{loading === 'apply' ? 'progress_activity' : 'upgrade'}</span>
          {confirmAction === 'apply' ? 'Click again to confirm' : `Upgrade${majorUpgrade ? ' (major)' : ''}`}
        </button>

        {/* Rollback */}
        <button
          onClick={() => {
            if (gatesMissing.length > 0) return;
            if (confirmAction === 'rollback') runAction('rollback', true);
            else setConfirmAction('rollback');
          }}
          disabled={loading !== null || gatesMissing.length > 0}
          className={`rounded-lg px-4 py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
            confirmAction === 'rollback'
              ? 'bg-danger text-on-danger ring-2 ring-danger/40'
              : gatesMissing.length > 0
                ? 'border border-border-subtle bg-surface-raised text-text-muted cursor-not-allowed opacity-50'
                : 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20'
          }`}
        >
          <span className="material-symbols-outlined text-[18px]">{loading === 'rollback' ? 'progress_activity' : 'restore'}</span>
          {confirmAction === 'rollback' ? 'Click again to confirm' : 'Rollback'}
        </button>
      </div>

      {/* Gate warnings */}
      {gatesMissing.length > 0 ? (
        <div className="mt-3 rounded-lg border border-tertiary/30 bg-tertiary/5 p-3">
          <p className="text-xs font-medium text-tertiary mb-1">Before upgrading or rolling back:</p>
          <ul className="space-y-1">
            {gatesMissing.map((g) => (
              <li key={g} className="text-xs text-text-secondary flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[12px]">error</span>
                {g}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-xs text-success flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[14px]">check_circle</span>
          All gates satisfied — upgrade/rollback ready.
        </p>
      )}

      {/* Result */}
      {result ? <ResultPanel result={result} /> : null}
    </section>
  );
}

function ResultPanel({ result }: { result: UpdateResponse }) {
  return (
    <div className="mt-4 pt-4 border-t border-border-subtle">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Result</h3>
      {result.error ? (
        <p className="text-sm text-danger">{result.error}{result.detail ? `: ${result.detail}` : ''}</p>
      ) : null}
      {result.policy ? (
        <p className={`text-sm ${result.policy.allowed ? 'text-success' : 'text-tertiary'}`}>
          Policy: {result.policy.mode} — {result.policy.allowed ? 'allowed' : 'locked'}
          {result.policy.failures.length > 0 ? ` (${result.policy.failures.join(', ')})` : ''}
        </p>
      ) : null}
      {result.execution ? (
        <p className={`text-sm ${result.execution.status === 'succeeded' ? 'text-success' : 'text-danger'}`}>
          Execution: {result.execution.status}
          {result.execution.failures.length > 0 ? ` — ${result.execution.failures.join(', ')}` : ''}
        </p>
      ) : null}
      {result.updateRun ? (
        <a href={`/admin/updates/${result.updateRun.id}`} className="text-sm text-primary hover:underline mt-2 inline-block">
          View run details →
        </a>
      ) : null}
    </div>
  );
}
