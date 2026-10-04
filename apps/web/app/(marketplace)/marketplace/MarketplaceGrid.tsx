'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PluginCatalogRow } from '@lobbyforge/db';
import { useT } from '@/lib/i18n/client';

const TRUST_COLORS: Record<string, string> = {
  official: 'text-primary border-primary/30 bg-primary/5',
  'verified-community': 'text-success border-success/30 bg-success/5',
  unverified: 'text-text-muted border-border-subtle bg-surface',
};

/** Trust levels are catalogue codes; these are the words players see. */
const TRUST_LABEL_KEYS: Record<string, string> = {
  official: 'hub.trust.official',
  'verified-community': 'hub.trust.verified',
  unverified: 'hub.trust.unverified',
};

type InstallResult = { kind: 'installed' } | { kind: 'failed'; message: string };

const emptyAction =
  'mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-on-primary transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

export default function MarketplaceGrid({
  plugins,
  filtered = false,
}: {
  plugins: PluginCatalogRow[];
  /** A search or category is narrowing the list — the way out is to clear it. */
  filtered?: boolean;
}) {
  const t = useT();
  if (plugins.length === 0) {
    // Every empty state ends in something to do next.
    return (
      <div className="rounded-2xl border border-border-subtle bg-surface px-6 py-12 text-center">
        <span className="material-symbols-outlined text-5xl text-text-muted mb-3 block" aria-hidden>
          {filtered ? 'search_off' : 'extension'}
        </span>
        {filtered ? (
          <>
            <h2 className="text-base font-semibold text-text-primary">{t('hub.marketplace.empty.filteredTitle')}</h2>
            <p className="mx-auto mt-1 max-w-md text-pretty text-sm text-text-secondary">
              {t('hub.marketplace.empty.filteredBody')}
            </p>
            <Link href="/marketplace" className={emptyAction}>
              {t('hub.marketplace.empty.clearFilters')}
            </Link>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-text-primary">{t('hub.marketplace.empty.title')}</h2>
            <p className="mx-auto mt-1 max-w-md text-pretty text-sm text-text-secondary">{t('hub.marketplace.empty.body')}</p>
            <Link href="/developers/publishing" className={emptyAction}>
              {t('hub.marketplace.empty.publish')}
            </Link>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {plugins.map((p) => (
        <PluginCard key={p.pluginId} plugin={p} />
      ))}
    </div>
  );
}

function PluginCard({ plugin }: { plugin: PluginCatalogRow }) {
  const t = useT();
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);
  const tags = (plugin.tags as string[]).slice(0, 3);
  const trustClass = TRUST_COLORS[plugin.trustLevel] ?? TRUST_COLORS.unverified;
  const playerConfig = plugin.playerConfig as { minPlayers?: number; maxPlayers?: number } | null;
  const trustKey = TRUST_LABEL_KEYS[plugin.trustLevel];
  const installed = installResult?.kind === 'installed';

  return (
    <article className="rounded-2xl border border-border-subtle bg-surface p-5 hover:border-primary/30 transition-all">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-12 h-12 rounded-xl bg-secondary-container flex items-center justify-center text-text-primary font-bold text-xl flex-shrink-0">
          {plugin.iconUrl ? (
            <img src={plugin.iconUrl} alt="" className="w-full h-full rounded-xl object-cover" />
          ) : (
            plugin.name.charAt(0).toUpperCase()
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-text-primary truncate">{plugin.name}</h3>
            <span className="text-xs text-text-muted">v{plugin.version}</span>
          </div>
          <p className="text-xs text-text-muted truncate">
            {t('hub.marketplace.by', { publisher: plugin.publisher })}
          </p>
        </div>
      </div>

      {/* Trust badge */}
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium mb-3 ${trustClass}`}
      >
        {plugin.trustLevel === 'official' ? (
          <span className="material-symbols-outlined text-[12px]">verified</span>
        ) : null}
        {trustKey ? t(trustKey) : plugin.trustLevel}
      </span>

      {/* Summary */}
      {plugin.summary ? (
        <p className="text-xs text-text-secondary line-clamp-2 mb-3">{plugin.summary}</p>
      ) : null}

      {/* Tags */}
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

      {/* Footer: stats */}
      <div className="flex items-center gap-3 text-xs text-text-muted pt-2 border-t border-border-subtle">
        <span className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[12px]">download</span>
          {plugin.downloadCount}
        </span>
        {playerConfig?.maxPlayers ? (
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">groups</span>
            {t('hub.marketplace.playerRange', {
              min: playerConfig.minPlayers ?? 1,
              max: playerConfig.maxPlayers,
            })}
          </span>
        ) : null}
        {plugin.requiresVoiceRoom ? (
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">mic</span>
            {t('hub.marketplace.voice')}
          </span>
        ) : null}
      </div>

      {/* Install button (admin-only — the API checks requireAdminHealthToken) */}
      <button
        onClick={async () => {
          setInstalling(true);
          setInstallResult(null);
          try {
            const res = await fetch('/api/marketplace/install', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pluginId: plugin.pluginId }),
            });
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            if (res.ok) {
              setInstallResult({ kind: 'installed' });
            } else {
              setInstallResult({
                kind: 'failed',
                message: data.error ?? t('hub.marketplace.install.failed'),
              });
            }
          } catch {
            setInstallResult({ kind: 'failed', message: t('hub.marketplace.install.networkError') });
          } finally {
            setInstalling(false);
          }
        }}
        disabled={installing}
        className={`mt-3 w-full rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
          installed
            ? 'bg-success/20 text-success border border-success/30'
            : installing
              ? 'bg-surface-container text-text-muted cursor-wait'
              : 'bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20'
        }`}
      >
        {installing
          ? t('hub.marketplace.install.installing')
          : installed
            ? t('hub.marketplace.install.installed')
            : installResult?.kind === 'failed'
              ? installResult.message
              : t('hub.marketplace.install.install')}
      </button>
    </article>
  );
}
