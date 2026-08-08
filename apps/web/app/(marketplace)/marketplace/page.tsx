import Link from 'next/link';
import { listApprovedPlugins } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import MarketplaceGrid from './MarketplaceGrid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Plugin Marketplace — LobbyForge',
};

const CATEGORIES = [
  { id: 'game', label: 'Games', icon: 'sports_esports' },
  { id: 'bot', label: 'Bots', icon: 'smart_toy' },
  { id: 'integration', label: 'Integrations', icon: 'extension' },
  { id: 'utility', label: 'Utilities', icon: 'build' },
];

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const params = await searchParams;
  const category = params.category || null;
  const query = params.q?.toLowerCase().trim() || '';

  let plugins: Awaited<ReturnType<typeof listApprovedPlugins>> = [];
  try {
    plugins = await listApprovedPlugins(getDb(), {
      category,
      search: query || null,
      limit: 100,
    });
  } catch (err) {
    console.error('[marketplace] catalog load failed:', (err as Error).message);
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border-subtle bg-surface/80 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/lobby"
              className="rounded-md p-1.5 text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </Link>
            <h1 className="text-lg font-semibold text-text-primary">Plugin Marketplace</h1>
          </div>
          <Link href="/lobby" className="text-sm text-primary hover:underline">
            Back to lobby
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* Search + category pills */}
        <div className="flex flex-col gap-4 mb-8">
          <form method="get" action="/marketplace" className="flex gap-3">
            <div className="relative flex-1">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">
                search
              </span>
              <input
                type="text"
                name="q"
                defaultValue={query}
                placeholder="Search plugins..."
                className="w-full rounded-lg bg-surface-raised border border-border-subtle pl-10 pr-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-primary"
              />
            </div>
            {category ? <input type="hidden" name="category" value={category} /> : null}
          </form>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/marketplace"
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                !category
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-raised text-text-secondary border border-border-subtle hover:bg-surface-container'
              }`}
            >
              All
            </Link>
            {CATEGORIES.map((c) => (
              <Link
                key={c.id}
                href={`/marketplace?category=${c.id}`}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors flex items-center gap-1.5 ${
                  category === c.id
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-raised text-text-secondary border border-border-subtle hover:bg-surface-container'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">{c.icon}</span>
                {c.label}
              </Link>
            ))}
          </div>
        </div>

        <p className="text-sm text-text-muted mb-4">
          {plugins.length} {plugins.length === 1 ? 'plugin' : 'plugins'} available
        </p>

        <MarketplaceGrid plugins={plugins} />
      </main>
    </div>
  );
}
