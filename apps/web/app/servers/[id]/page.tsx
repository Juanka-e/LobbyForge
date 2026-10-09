import { requireServerSettings } from '@/lib/admin-access';
import ServerSettingsClient, { type Tab } from './ServerSettingsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A community's settings page. Guarded on the server before anything
 * renders: a viewer without Manage Community there — signed out, a guest,
 * a member, someone from elsewhere — gets the same 404 as an id that does
 * not exist (lib/admin-access.ts).
 */
export default async function ServerSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = await params;
  const access = await requireServerSettings(id);
  const tab = (await searchParams).tab;
  return (
    <ServerSettingsClient
      serverId={access.server.id}
      viewer={{ userId: access.userId, isOwner: access.isOwner, can: access.can }}
      initialTab={(typeof tab === 'string' ? tab : 'overview') as Tab}
    />
  );
}
