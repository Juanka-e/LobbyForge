import type { PluginCatalogRow } from '@lobbyforge/db';

const TRUST_COLORS: Record<string, string> = {
  official: 'text-primary border-primary/30 bg-primary/5',
  'verified-community': 'text-success border-success/30 bg-success/5',
  unverified: 'text-text-muted border-border-subtle bg-surface',
};

interface MarketplaceCard {
  pluginId: string;
  name: string;
  version: string;
  type: string;
  summary: string | null;
  publisher: string;
  trustLevel: string;
  category: string | null;
  tags: string[];
  permissions: string[];
  playerConfig: Record<string, unknown> | null;
  iconUrl: string | null;
  requiresVoiceRoom: boolean;
  downloadCount: number;
}

export default function MarketplaceGrid({
  plugins,
}: {
  plugins: PluginCatalogRow[];
}) {
  if (plugins.length === 0) {
    return (
      <div className="rounded-2xl border border-border-subtle bg-surface p-12 text-center">
        <span className="material-symbols-outlined text-5xl text-text-muted mb-3 block">
          extension_off
        </span>
        <h2 className="text-base font-semibold text-text-primary">No plugins found</h2>
        <p className="mt-1 text-sm text-text-muted">
          No community plugins match your search yet. Check back soon!
        </p>
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
  const tags = (plugin.tags as string[]).slice(0, 3);
  const trustClass = TRUST_COLORS[plugin.trustLevel] ?? TRUST_COLORS.unverified;
  const playerConfig = plugin.playerConfig as { minPlayers?: number; maxPlayers?: number } | null;

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
          <p className="text-xs text-text-muted truncate">by {plugin.publisher}</p>
        </div>
      </div>

      {/* Trust badge */}
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium mb-3 ${trustClass}`}
      >
        {plugin.trustLevel === 'official' ? (
          <span className="material-symbols-outlined text-[12px]">verified</span>
        ) : null}
        {plugin.trustLevel}
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
            {playerConfig.minPlayers ?? 1}-{playerConfig.maxPlayers}
          </span>
        ) : null}
        {plugin.requiresVoiceRoom ? (
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">mic</span>
            Voice
          </span>
        ) : null}
      </div>
    </article>
  );
}
