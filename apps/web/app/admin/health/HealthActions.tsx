'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DoctorReport } from '@lobbyforge/core';

/**
 * Client island for the two Doctor sidebar actions:
 *   - "Run Full Check" refreshes the server component so it re-runs
 *     collectDoctorReport() and renders fresh stats.
 *   - "Copy Health Summary" copies a plain-text summary to the clipboard.
 *
 * The rest of the health page stays a server component so the report is
 * always rendered from a live server-side probe, not a client fetch.
 */
export default function HealthActions({ report }: { report: DoctorReport }) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const runCheck = () => {
    setChecking(true);
    router.refresh();
    // Re-enable the button shortly after refresh kicks off.
    setTimeout(() => setChecking(false), 1500);
  };

  const copySummary = async () => {
    const lines = [
      `LobbyForge Health Summary`,
      `Generated: ${new Date(report.generatedAt).toISOString()}`,
      `Overall: ${report.ok ? 'OK' : 'Issues detected'}`,
      `Checks: ${report.summary.ok} ok / ${report.summary.warning} warnings / ${report.summary.critical} critical / ${report.summary.fatal} fatal`,
      `Uptime: ${report.uptimeSeconds}s`,
      `Capacity tier: ${report.capacity.tier}`,
      '',
      ...report.checks.map((c) => `[${c.level.toUpperCase()}] ${c.id}: ${c.message}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context). Silently no-op.
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={runCheck}
        disabled={checking}
        className="w-full py-2.5 rounded-lg bg-primary text-on-primary font-label-sm hover:brightness-110 transition-all flex items-center justify-center gap-2 disabled:opacity-60"
      >
        <span className="material-symbols-outlined text-[18px]">{checking ? 'progress_activity' : 'play_arrow'}</span>
        {checking ? 'Checking…' : 'Run Full Check'}
      </button>
      <button
        type="button"
        onClick={copySummary}
        className="w-full py-2.5 rounded-lg bg-surface-raised border border-border-strong text-text-secondary font-label-sm hover:bg-surface-variant transition-colors flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-[18px]">{copied ? 'check' : 'content_copy'}</span>
        {copied ? 'Copied!' : 'Copy Health Summary'}
      </button>
    </div>
  );
}
