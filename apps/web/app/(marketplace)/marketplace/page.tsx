import Link from 'next/link';
import type { Metadata } from 'next';
import { listApprovedPlugins } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import type { Translator } from '@/lib/i18n/core';
import { getTranslator } from '@/lib/i18n/server';
import { container, eyebrow, focusRing } from '@/app/(marketing)/_components/styles';
import MarketplaceGrid from './MarketplaceGrid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('hub.marketplace.meta.title') };
}

const CATEGORIES = [
  { id: 'game', labelKey: 'hub.marketplace.category.game', icon: 'sports_esports' },
  { id: 'bot', labelKey: 'hub.marketplace.category.bot', icon: 'smart_toy' },
  { id: 'integration', labelKey: 'hub.marketplace.category.integration', icon: 'extension' },
  { id: 'utility', labelKey: 'hub.marketplace.category.utility', icon: 'build' },
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

  const t = await getTranslator();
  const filtered = Boolean(category || query);
  const catalog = (
    <>
      <Controls t={t} category={category} query={query} />
      <p className="text-sm text-text-muted mb-4">{t('hub.marketplace.count', { count: plugins.length })}</p>
      <MarketplaceGrid plugins={plugins} filtered={filtered} />
    </>
  );

  // The official hub: a hub page inside the hub chrome (see ../layout.tsx).
  if (isOfficialDeployment()) {
    return (
      <div className={`${container} pb-20 pt-12 sm:pt-16 lg:pb-24`}>
        <header className="mb-10 flex max-w-[720px] flex-col gap-3.5">
          <p className={`${eyebrow} text-ember`}>{t('hub.marketplace.eyebrow')}</p>
          <h1 className="text-balance font-display text-[36px] font-bold leading-[1.08] tracking-[-0.02em] text-text-primary sm:text-[50px]">
            {t('hub.marketplace.title')}
          </h1>
          <p className="text-pretty text-lg leading-[1.6] text-text-secondary">{t('hub.marketplace.subtitle')}</p>
        </header>
        {catalog}
      </div>
    );
  }

  // A self-hosted instance: its own page, with the way back to the lobby.
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border-subtle bg-surface/80 backdrop-blur-md sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/lobby"
              aria-label={t('hub.marketplace.backToLobby')}
              className="rounded-md p-1.5 text-text-secondary hover:bg-surface-container hover:text-text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]" aria-hidden>
                arrow_back
              </span>
            </Link>
            <h1 className="text-lg font-semibold text-text-primary">{t('hub.marketplace.title')}</h1>
          </div>
          <Link href="/lobby" className="text-sm text-primary hover:underline">
            {t('hub.marketplace.backToLobby')}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{catalog}</main>
    </div>
  );
}

/** Search + category pills — the same on both deployments. */
function Controls({ t, category, query }: { t: Translator; category: string | null; query: string }) {
  return (
    <div className="flex flex-col gap-4 mb-8">
      <form method="get" action="/marketplace" className="flex gap-3">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]" aria-hidden>
            search
          </span>
          <input
            type="text"
            name="q"
            defaultValue={query}
            placeholder={t('hub.marketplace.search')}
            aria-label={t('hub.marketplace.search')}
            className="w-full rounded-lg bg-surface-raised border border-border-subtle pl-10 pr-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-primary"
          />
        </div>
        {category ? <input type="hidden" name="category" value={category} /> : null}
      </form>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/marketplace"
          aria-current={!category ? 'page' : undefined}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${focusRing} ${
            !category
              ? 'bg-primary text-on-primary'
              : 'bg-surface-raised text-text-secondary border border-border-subtle hover:bg-surface-container'
          }`}
        >
          {t('hub.marketplace.category.all')}
        </Link>
        {CATEGORIES.map((c) => (
          <Link
            key={c.id}
            href={`/marketplace?category=${c.id}`}
            aria-current={category === c.id ? 'page' : undefined}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors flex items-center gap-1.5 ${focusRing} ${
              category === c.id
                ? 'bg-primary text-on-primary'
                : 'bg-surface-raised text-text-secondary border border-border-subtle hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden>{c.icon}</span>
            {t(c.labelKey)}
          </Link>
        ))}
      </div>
    </div>
  );
}
