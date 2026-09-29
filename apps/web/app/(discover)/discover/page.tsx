import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getDb } from '@/lib/db';
import { listPublicRegistryInstances } from '@lobbyforge/db';
import { getTranslator } from '@/lib/i18n/server';
import { container, eyebrow } from '@/app/(marketing)/_components/styles';
import DiscoveryGrid from './DiscoveryGrid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata() {
  const t = await getTranslator();
  return { title: `${t('discovery.title')} — LobbyForge` };
}

/**
 * /discover — the official instance's community discovery directory.
 *
 * Only renders on the official deployment (self-host instances have no
 * directory — they are single-server by design). Lists registered, listed,
 * non-blocked community instances sorted by active users.
 */
export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string; q?: string }>;
}) {
  if (!isOfficialDeployment()) redirect('/lobby');

  const params = await searchParams;
  const region = params.region || null;
  const query = params.q?.toLowerCase().trim() || '';

  let instances: Awaited<ReturnType<typeof listPublicRegistryInstances>> = [];
  try {
    instances = await listPublicRegistryInstances(getDb(), { limit: 100, region });
  } catch (err) {
    console.error('[discover] directory load failed:', (err as Error).message);
  }

  // Client-side search filter (name / description / tags).
  const filtered = query
    ? instances.filter((i) => {
        const haystack = `${i.name} ${i.description ?? ''} ${(i.tags as string[]).join(' ')}`.toLowerCase();
        return haystack.includes(query);
      })
    : instances;

  const t = await getTranslator();
  return (
    <div className={`${container} pb-20 pt-12 sm:pt-16 lg:pb-24`}>
      <header className="mb-10 flex max-w-[720px] flex-col gap-3.5">
        <p className={`${eyebrow} text-primary`}>{t('pages.discoverInstance.directory')}</p>
        <h1 className="text-balance font-display text-[36px] font-bold leading-[1.08] tracking-[-0.02em] text-text-primary sm:text-[50px]">
          {t('discovery.title')}
        </h1>
        <p className="text-pretty text-lg leading-[1.6] text-text-secondary">{t('discovery.subtitle')}</p>
      </header>
      <DiscoveryGrid instances={filtered} region={region} query={query} />
    </div>
  );
}
