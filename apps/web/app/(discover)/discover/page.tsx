import { redirect } from 'next/navigation';
import { isOfficialDeployment } from '@/lib/deployment-mode';
import { getDb } from '@/lib/db';
import { listPublicRegistryInstances } from '@lobbyforge/db';
import DiscoveryGrid from './DiscoveryGrid';

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
  } catch {
    // Directory unavailable — render empty state.
  }

  // Client-side search filter (name / description / tags).
  const filtered = query
    ? instances.filter((i) => {
        const haystack = `${i.name} ${i.description ?? ''} ${(i.tags as string[]).join(' ')}`.toLowerCase();
        return haystack.includes(query);
      })
    : instances;

  return <DiscoveryGrid instances={filtered} region={region} query={query} />;
}
