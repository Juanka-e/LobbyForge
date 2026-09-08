'use client';

import Link from 'next/link';
import { useState } from 'react';

interface DirectoryCard {
  instanceId: string;
  name: string;
  domain: string;
  description: string | null;
  region: string | null;
  languages: string[];
  tags: string[];
  features: string[];
  isVerified: boolean;
  nsfw: boolean;
  onlineUsers: number;
  publicRoomsCount: number;
  version: string | null;
  doctorScore: number | null;
  lastHeartbeatAt: Date | null;
}

/** Pre-translated strings from the server (RSC props). */
type Labels = Record<string, string>;

const REGIONS = ['Europe', 'North America', 'Asia', 'South America', 'Oceania', 'Africa'];
const REPORT_REASONS = ['spam', 'nsfw', 'abuse', 'malware', 'other'] as const;

export default function DiscoveryGrid({
  instances,
  region,
  query,
  labels,
}: {
  instances: DirectoryCard[];
  region: string | null;
  query: string;
  labels: Labels;
}) {
  const [reporting, setReporting] = useState<DirectoryCard | null>(null);

  return (
    <div className="min-h-dvh bg-background">
      {/* Header */}
      <header className="border-b border-border-subtle bg-surface/80 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/lobby"
              className="rounded-md p-1.5 text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-text-primary">{labels.title}</h1>
              <p className="text-xs text-text-muted">{labels.subtitle}</p>
            </div>
          </div>
          <Link href="/lobby" className="text-sm text-primary hover:underline">
            {labels.backToLobby}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-3 mb-8">
          <form className="flex-1 min-w-[240px]" method="get" action="/discover">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">
                search
              </span>
              <input
                type="text"
                name="q"
                defaultValue={query}
                placeholder={labels.search}
                className="w-full rounded-lg bg-surface-raised border border-border-subtle pl-10 pr-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-primary"
              />
            </div>
            {region ? <input type="hidden" name="region" value={region} /> : null}
          </form>
          {/* Region filter */}
          <details className="relative">
            <summary className="cursor-pointer rounded-lg bg-surface-raised border border-border-subtle px-4 py-2.5 text-sm text-text-secondary hover:bg-surface-container list-none flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">public</span>
              {region ?? labels.allRegions}
            </summary>
            <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border-subtle bg-surface-raised shadow-xl py-1 z-20">
              <Link
                href="/discover"
                className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
              >
                {labels.allRegions}
              </Link>
              {REGIONS.map((r) => (
                <Link
                  key={r}
                  href={`/discover?region=${encodeURIComponent(r)}`}
                  className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
                >
                  {r}
                </Link>
              ))}
            </div>
          </details>
        </div>

        {/* Results count */}
        <p className="text-sm text-text-muted mb-4">
          {instances.length === 1
            ? labels.communityFound
            : (labels.communitiesFound ?? '').replace('{{count}}', String(instances.length))}
        </p>

        {/* Grid */}
        {instances.length === 0 ? (
          <div className="rounded-2xl border border-border-subtle bg-surface p-12 text-center">
            <span className="material-symbols-outlined text-5xl text-text-muted mb-3 block">explore_off</span>
            <h2 className="text-base font-semibold text-text-primary">{labels.noResults}</h2>
            <p className="mt-1 text-sm text-text-muted">
              {query
                ? (labels.noResultsQuery ?? '').replace('{{query}}', query)
                : labels.noListedYet}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {instances.map((inst) => (
              <DirectoryCard
                key={inst.instanceId}
                instance={inst}
                labels={labels}
                onReport={() => setReporting(inst)}
              />
            ))}
          </div>
        )}
      </main>

      {reporting ? (
        <ReportDialog instance={reporting} labels={labels} onClose={() => setReporting(null)} />
      ) : null}
    </div>
  );
}

function DirectoryCard({
  instance,
  labels,
  onReport,
}: {
  instance: DirectoryCard;
  labels: Labels;
  onReport: () => void;
}) {
  const tags = (instance.tags as string[]).slice(0, 4);
  return (
    <div className="group relative rounded-2xl border border-border-subtle bg-surface hover:border-primary/40 transition-all">
      <a
        href={`/discover/go?id=${encodeURIComponent(instance.instanceId)}`}
        className="block p-5 h-full"
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center text-primary font-bold text-lg flex-shrink-0">
            {instance.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold text-text-primary truncate group-hover:text-primary transition-colors">
                {instance.name}
              </h3>
              {instance.isVerified ? (
                <span className="material-symbols-outlined text-[14px] text-primary" title="Verified">
                  verified
                </span>
              ) : (
                <span className="material-symbols-outlined text-[14px] text-text-muted" title={labels.notVerified}>
                  help
                </span>
              )}
            </div>
            {instance.region ? (
              <p className="text-xs text-text-muted flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px]">location_on</span>
                {instance.region}
              </p>
            ) : null}
          </div>
        </div>
        {instance.description ? (
          <p className="text-xs text-text-secondary line-clamp-2 mb-3">{instance.description}</p>
        ) : null}
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-surface-container px-2 py-0.5 text-[10px] text-text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-4 text-xs text-text-muted pt-2 border-t border-border-subtle">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            {instance.onlineUsers} {labels.online}
          </span>
          {instance.publicRoomsCount > 0 ? (
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px]">forum</span>
              {instance.publicRoomsCount} {labels.rooms}
            </span>
          ) : null}
          {instance.doctorScore != null ? (
            <span className="flex items-center gap-1 ml-auto">
              <span className="material-symbols-outlined text-[12px] text-success">health_and_safety</span>
              {instance.doctorScore}
            </span>
          ) : null}
        </div>
      </a>
      {/* Faz D: report entry point on the card */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          onReport();
        }}
        title={labels.report}
        className="absolute top-3 right-3 rounded-md p-1.5 text-text-muted hover:text-warning hover:bg-warning/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <span className="material-symbols-outlined text-[16px]">flag</span>
      </button>
    </div>
  );
}

function ReportDialog({
  instance,
  labels,
  onClose,
}: {
  instance: DirectoryCard;
  labels: Labels;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number]>('spam');
  const [detail, setDetail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  async function submit() {
    setState('sending');
    try {
      const res = await fetch(`/api/directory/${encodeURIComponent(instance.instanceId)}/report`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, ...(detail.trim() ? { detail: detail.trim() } : {}) }),
      });
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface-raised p-6">
        {state === 'done' ? (
          <div className="text-center py-4">
            <span className="material-symbols-outlined text-success text-[32px] mb-2 block">check_circle</span>
            <p className="text-sm text-text-primary">{labels.reportSubmitted}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white"
            >
              {labels.cancel}
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-base font-semibold text-text-primary">{labels.reportTitle}</h2>
            <p className="mt-1 text-xs text-text-muted">
              {labels.reportBody} — <span className="font-medium">{instance.name}</span>
            </p>
            <label className="block mt-4 text-xs font-medium text-text-secondary">
              {labels.reportReason}
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value as (typeof REPORT_REASONS)[number])}
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary"
              >
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {labels[`reportReason.${r}`] ?? r}
                  </option>
                ))}
              </select>
            </label>
            <label className="block mt-3 text-xs font-medium text-text-secondary">
              {labels.reportDetail}
              <textarea
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                maxLength={1000}
                rows={3}
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary resize-none"
              />
            </label>
            {state === 'error' ? (
              <p className="mt-2 text-xs text-danger">{labels.reportFailed}</p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary hover:bg-surface-container"
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={state === 'sending'}
                className="rounded-lg bg-warning/90 px-4 py-2 text-sm font-semibold text-black hover:bg-warning disabled:opacity-40"
              >
                {state === 'sending' ? '…' : labels.reportSubmit}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
