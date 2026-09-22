import { cookies } from 'next/headers';
import {
  getInstanceSetupStatus,
  listPluginInstallsForServer,
  listServersForUser,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import { listPluginSummaries } from '@/lib/plugin-registry';
import SettingsShell from '@/app/SettingsShell';
import AppsClient, { type AppView } from './AppsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Apps & Activities - Community Settings',
};

/**
 * Install / enable the apps a community can start in voice channels.
 *
 * beta-review: this screen did not exist. The only way to install an app
 * was `POST /api/servers/{id}/apps` (or the barely-linked `/servers/{id}`
 * page), so a fresh instance had zero enabled apps and the activity
 * picker said "No enabled apps for this server" with nowhere to go —
 * which is why an owner could not start an activity at all.
 */
export default async function AppsSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Apps &amp; Activities</h1>
          <p className="mt-2 text-sm text-danger">Admin token required.</p>
        </section>
      </SettingsShell>
    );
  }

  const db = getDb();
  const setup = await getInstanceSetupStatus(db);
  const session = readGuestSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? setup.ownerUserId ?? null;

  let serverId: string | null = null;
  let apps: AppView[] = [];
  let loadError: string | null = null;

  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const firstServer = servers[0];
      if (firstServer) {
        serverId = firstServer.id;
        const installs = await listPluginInstallsForServer(db, firstServer.id);
        const installById = new Map(installs.map((install) => [install.pluginId, install]));
        apps = listPluginSummaries().map((plugin) => {
          const install = installById.get(plugin.id);
          return {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            type: plugin.type,
            summary: plugin.catalog?.summary ?? null,
            trustLevel: plugin.catalog?.trustLevel ?? null,
            minPlayers: plugin.catalog?.playerConfig?.minPlayers ?? null,
            maxPlayers: plugin.catalog?.playerConfig?.maxPlayers ?? null,
            installed: Boolean(install),
            enabled: install?.enabled ?? false,
          } satisfies AppView;
        });
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community">
      <AppsClient serverId={serverId} initialApps={apps} loadError={loadError} />
    </SettingsShell>
  );
}
