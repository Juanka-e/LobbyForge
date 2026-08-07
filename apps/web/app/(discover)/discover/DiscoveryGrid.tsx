import Link from 'next/link';
import type { RegistryInstanceRow } from '@lobbyforge/db';

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

const REGIONS = ['Europe', 'North America', 'Asia', 'South America', 'Oceania', 'Africa'];

export default function DiscoveryGrid({
  instances,
  region,
  query,
}: {
  instances: DirectoryCard[];
  region: string | null;
  query: string;
}) {
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
            <h1 className="text-lg font-semibold text-text-primary">Discover Communities</h1>
          </div>
          <Link
            href="/lobby"
            className="text-sm text-primary hover:underline"
          >
            Back to lobby
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
                placeholder="Search communities..."
                className="w-full rounded-lg bg-surface-raised border border-border-subtle pl-10 pr-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-primary"
              />
            </div>
            {region ? <input type="hidden" name="region" value={region} /> : null}
          </form>
          {/* Region filter */}
          <details className="relative">
            <summary className="cursor-pointer rounded-lg bg-surface-raised border border-border-subtle px-4 py-2.5 text-sm text-text-secondary hover:bg-surface-container list-none flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">public</span>
              {region ?? 'All regions'}
            </summary>
            <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border-subtle bg-surface-raised shadow-xl py-1 z-20">
              <Link
                href="/discover"
                className="block px-4 py-2 text-sm text-text-secondary hover:bg-surface-container hover:text-text-primary"
              >
                All regions
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
          {instances.length} {instances.length === 1 ? 'community' : 'communities'} found
        </p>

        {/* Grid */}
        {instances.length === 0 ? (
          <div className="rounded-2xl border border-border-subtle bg-surface p-12 text-center">
            <span className="material-symbols-outlined text-5xl text-text-muted mb-3 block">explore_off</span>
            <h2 className="text-base font-semibold text-text-primary">No communities found</h2>
            <p className="mt-1 text-sm text-text-muted">
              {query
                ? `No results for "${query}". Try a different search.`
                : 'No communities are listed yet. Check back soon!'}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {instances.map((inst) => (
              <DirectoryCard key={inst.instanceId} instance={inst} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function DirectoryCard({ instance }: { instance: DirectoryCard }) {
  const tags = (instance.tags as string[]).slice(0, 4);
  return (
    <a
      href={`/discover/go?id=${encodeURIComponent(instance.instanceId)}`}
      className="group rounded-2xl border border-border-subtle bg-surface p-5 hover:border-primary/40 hover:bg-surface-raised transition-all"
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
            ) : null}
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
          {instance.onlineUsers} online
        </span>
        {instance.publicRoomsCount > 0 ? (
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">forum</span>
            {instance.publicRoomsCount} rooms
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
  );
}
