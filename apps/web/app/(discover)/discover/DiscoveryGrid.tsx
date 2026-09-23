'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { rich } from '@/lib/i18n/rich';

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

/**
 * Directory regions. The English name is the value stored by the
 * registry and sent in the URL; `label` is its message key.
 */
const REGIONS = [
  { value: 'Europe', label: 'discovery.region.europe' },
  { value: 'North America', label: 'discovery.region.northAmerica' },
  { value: 'Asia', label: 'discovery.region.asia' },
  { value: 'South America', label: 'discovery.region.southAmerica' },
  { value: 'Oceania', label: 'discovery.region.oceania' },
  { value: 'Africa', label: 'discovery.region.africa' },
];
const REPORT_REASONS = ['spam', 'nsfw', 'abuse', 'malware', 'other'] as const;

/** A region as the reader says it; unknown regions are shown as listed. */
function regionLabel(region: string, t: Translator): string {
  const known = REGIONS.find((r) => r.value === region);
  return known ? t(known.label) : region;
}

export default function DiscoveryGrid({
  instances,
  region,
  query,
}: {
  instances: DirectoryCard[];
  region: string | null;
  query: string;
}) {
  const t = useT();
  const [reporting, setReporting] = useState<DirectoryCard | null>(null);
  // Client-side quick filters (the server already handles search + region).
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [language, setLanguage] = useState('');

  const languages = useMemo(
    () => Array.from(new Set(instances.flatMap((i) => i.languages ?? []))).sort(),
    [instances]
  );

  const visible = useMemo(
    () =>
      instances.filter(
        (i) =>
          (!verifiedOnly || i.isVerified) &&
          (!onlineOnly || i.onlineUsers > 0) &&
          (!language || (i.languages ?? []).includes(language))
      ),
    [instances, verifiedOnly, onlineOnly, language]
  );

  return (
    <div className="min-h-dvh bg-background">
      {/* Header */}
      <header className="border-b border-border-subtle bg-surface/80 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/discover"
              className="rounded-md p-1.5 text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
              aria-label={t('discovery.backToDirectory')}
            >
              <span className="material-symbols-outlined text-[20px]" aria-hidden>
                arrow_back
              </span>
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-text-primary">{t('discovery.title')}</h1>
              <p className="text-xs text-text-muted">{t('discovery.subtitle')}</p>
            </div>
          </div>
          <Link href="/lobby" className="text-sm text-primary hover:underline">
            {t('discovery.backToLobby')}
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
                placeholder={t('discovery.search')}
                aria-label={t('discovery.search')}
                className="w-full rounded-lg bg-surface-raised border border-border-subtle pl-10 pr-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-primary"
              />
            </div>
            {region ? <input type="hidden" name="region" value={region} /> : null}
          </form>
          {/* Region filter */}
          <details className="relative">
            <summary className="cursor-pointer rounded-lg bg-surface-raised border border-border-subtle px-4 py-2.5 text-sm text-text-secondary hover:bg-surface-container list-none flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">public</span>
              {region ? regionLabel(region, t) : t('discovery.allRegions')}
            </summary>
            <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border-subtle bg-surface-raised shadow-xl py-1 z-20">
              <Link
                href="/discover"
                className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
              >
                {t('discovery.allRegions')}
              </Link>
              {REGIONS.map((r) => (
                <Link
                  key={r.value}
                  href={`/discover?region=${encodeURIComponent(r.value)}`}
                  className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
                >
                  {t(r.label)}
                </Link>
              ))}
            </div>
          </details>
        </div>

        {/* Quick filters (client-side) */}
        <div className="flex flex-wrap items-center gap-2 mb-8">
          <button
            type="button"
            aria-pressed={verifiedOnly}
            onClick={() => setVerifiedOnly((v) => !v)}
            className={`rounded-full border px-4 py-1.5 text-xs transition-colors ${
              verifiedOnly
                ? 'border-primary/50 bg-primary/10 text-primary'
                : 'border-border-subtle bg-surface-raised text-text-secondary hover:text-text-primary'
            }`}
          >
            <span className="material-symbols-outlined text-[13px] align-middle mr-1" aria-hidden>
              verified
            </span>
            {t('discovery.verifiedOnly')}
          </button>
          <button
            type="button"
            aria-pressed={onlineOnly}
            onClick={() => setOnlineOnly((v) => !v)}
            className={`rounded-full border px-4 py-1.5 text-xs transition-colors ${
              onlineOnly
                ? 'border-ember/50 bg-ember/10 text-ember'
                : 'border-border-subtle bg-surface-raised text-text-secondary hover:text-text-primary'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current inline-block mr-1.5" />
            {t('discovery.onlineNow')}
          </button>
          {languages.length > 1 ? (
            <label className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised px-4 py-1.5 text-xs text-text-secondary">
              <span className="material-symbols-outlined text-[13px]">translate</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="bg-transparent text-text-secondary outline-none cursor-pointer"
                aria-label={t('discovery.filterLanguage')}
              >
                <option value="">{t('discovery.allLanguages')}</option>
                {languages.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {/* Results count */}
        <p className="text-sm text-text-muted mb-4">
          {t('discovery.communitiesFound', { count: visible.length })}
        </p>

        {/* Grid */}
        {visible.length === 0 ? (
          <div className="rounded-2xl border border-border-subtle bg-surface p-12 text-center">
            <span className="material-symbols-outlined text-5xl text-text-muted mb-3 block">explore_off</span>
            <h2 className="text-base font-semibold text-text-primary">{t('discovery.noResults')}</h2>
            <p className="mt-1 text-sm text-text-muted">
              {query
                ? t('discovery.noResultsQuery', { query })
                : t('discovery.noListedYet')}
            </p>
            <p className="mt-3 text-sm text-text-muted">
              {rich(t('discovery.clearFiltersHint'), { link: <Link href="/connect" className="text-primary hover:underline underline-offset-4">
                  {t('discovery.connectByAddress')}
                </Link> })}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((inst) => (
              <DirectoryCard
                key={inst.instanceId}
                instance={inst}
                onReport={() => setReporting(inst)}
              />
            ))}
          </div>
        )}
      </main>

      {reporting ? (
        <ReportDialog instance={reporting} onClose={() => setReporting(null)} />
      ) : null}
    </div>
  );
}

function DirectoryCard({
  instance,
  onReport,
}: {
  instance: DirectoryCard;
  onReport: () => void;
}) {
  const t = useT();
  const tags = (instance.tags as string[]).slice(0, 4);
  return (
    <div className="group relative rounded-2xl border border-border-subtle bg-surface hover:border-primary/40 transition-all">
      <Link
        href={`/discover/${encodeURIComponent(instance.instanceId)}`}
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
                <span className="material-symbols-outlined text-[14px] text-primary" title={t('discovery.verified')}>
                  verified
                </span>
              ) : (
                <span className="material-symbols-outlined text-[14px] text-text-muted" title={t('discovery.notVerified')}>
                  help
                </span>
              )}
            </div>
            {instance.region ? (
              <p className="text-xs text-text-muted flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px]">location_on</span>
                {regionLabel(instance.region, t)}
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
            {instance.onlineUsers} {t('discovery.online')}
          </span>
          {instance.publicRoomsCount > 0 ? (
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px]">forum</span>
              {instance.publicRoomsCount} {t('discovery.rooms')}
            </span>
          ) : null}
          {instance.doctorScore != null ? (
            <span className="flex items-center gap-1 ml-auto">
              <span className="material-symbols-outlined text-[12px] text-success">health_and_safety</span>
              {instance.doctorScore}
            </span>
          ) : null}
        </div>
      </Link>
      {/* Faz D: report entry point on the card */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          onReport();
        }}
        title={t('discovery.report')}
        className="absolute top-3 right-3 rounded-md p-1.5 text-text-muted hover:text-warning hover:bg-warning/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <span className="material-symbols-outlined text-[16px]">flag</span>
      </button>
    </div>
  );
}

function ReportDialog({
  instance,
  onClose,
}: {
  instance: DirectoryCard;
  onClose: () => void;
}) {
  const t = useT();
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
            <p className="text-sm text-text-primary">{t('discovery.reportSubmitted')}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary"
            >
              {t('discovery.close')}
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-base font-semibold text-text-primary">{t('discovery.reportTitle')}</h2>
            <p className="mt-1 text-xs text-text-muted">
              {t('discovery.reportBody')} — <span className="font-medium">{instance.name}</span>
            </p>
            <label className="block mt-4 text-xs font-medium text-text-secondary">
              {t('discovery.reportReason')}
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value as (typeof REPORT_REASONS)[number])}
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary"
              >
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(`discovery.reportReason.${r}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block mt-3 text-xs font-medium text-text-secondary">
              {t('discovery.reportDetail')}
              <textarea
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                maxLength={1000}
                rows={3}
                className="mt-1 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary resize-none"
              />
            </label>
            {state === 'error' ? (
              <p className="mt-2 text-xs text-danger">{t('discovery.reportFailed')}</p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-secondary hover:bg-surface-container"
              >
                {t('discovery.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={state === 'sending'}
                className="rounded-lg bg-warning/90 px-4 py-2 text-sm font-semibold text-black hover:bg-warning disabled:opacity-40"
              >
                {state === 'sending' ? '…' : t('discovery.reportSubmit')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
