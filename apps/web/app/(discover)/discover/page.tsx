import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getDb } from '@/lib/db';
import { listPublicRegistryInstances } from '@lobbyforge/db';
import { t, type TranslationKey } from '@lobbyforge/i18n';
import DiscoveryGrid from './DiscoveryGrid';

/** Resolve the visitor locale for the (public) discovery page: the two
 * supported languages via Accept-Language, defaulting to English. */
async function resolveLocale(): Promise<'en' | 'tr'> {
  const accept = (await headers()).get('accept-language') ?? '';
  return accept.toLowerCase().includes('tr') ? 'tr' : 'en';
}

/** Pre-translate the labels the grid needs (RSC → props — no client
 * i18n machinery required). */
function buildLabels(locale: 'en' | 'tr'): Record<string, string> {
  const keys: TranslationKey[] = [
    'discovery.title',
    'discovery.subtitle',
    'discovery.search',
    'discovery.allRegions',
    'discovery.online',
    'discovery.rooms',
    'discovery.noResults',
    'discovery.noResultsHint',
    'discovery.noResultsQuery',
    'discovery.noListedYet',
    'discovery.communitiesFound',
    'discovery.communityFound',
    'discovery.backToLobby',
    'discovery.notVerified',
    'discovery.report',
    'discovery.reportTitle',
    'discovery.reportBody',
    'discovery.reportReason',
    'discovery.reportReason.spam',
    'discovery.reportReason.nsfw',
    'discovery.reportReason.abuse',
    'discovery.reportReason.malware',
    'discovery.reportReason.other',
    'discovery.reportDetail',
    'discovery.reportSubmit',
    'discovery.reportSubmitted',
    'discovery.reportFailed',
    'discovery.cancel',
  ];
  const labels: Record<string, string> = {};
  for (const key of keys) {
    labels[key.replace('discovery.', '')] = t(key, undefined, locale);
  }
  return labels;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Discover Communities — LobbyForge',
};

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

  const locale = await resolveLocale();
  const labels = buildLabels(locale);

  return <DiscoveryGrid instances={filtered} region={region} query={query} labels={labels} />;
}
