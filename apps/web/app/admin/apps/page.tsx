import type { Metadata } from 'next';
import { listPluginInstallsForServer } from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import { getTranslator } from '@/lib/i18n/server';
import { listPluginSummaries } from '@/lib/plugin-registry';
import SettingsShell from '@/app/SettingsShell';
import AppsClient, { type AppView } from './AppsClient';
import { pluginName, pluginSummary } from '@/lib/plugin-catalog-text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('apps', 'admin.apps.metaTitle');
}

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
  const access = await requireAdminSection('apps');
  const t = await getTranslator();
  const db = getDb();

  let serverId: string | null = null;
  let apps: AppView[] = [];
  let loadError: string | null = null;

  if (access.userId) {
    try {
      const firstServer = access.server;
      if (firstServer) {
        serverId = firstServer.id;
        const installs = await listPluginInstallsForServer(db, firstServer.id);
        const installById = new Map(installs.map((install) => [install.pluginId, install]));
        apps = listPluginSummaries().map((plugin) => {
          const install = installById.get(plugin.id);
          return {
            id: plugin.id,
            name: pluginName(plugin.id, t.locale, plugin.name),
            version: plugin.version,
            type: plugin.type,
            summary: pluginSummary(plugin.id, t.locale, plugin.catalog?.summary ?? null),
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
    <SettingsShell scope="community" sections={access.sections}>
      <AppsClient serverId={serverId} initialApps={apps} loadError={loadError} />
    </SettingsShell>
  );
}
