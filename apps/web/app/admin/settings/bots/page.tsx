import type { Metadata } from 'next';
import { listBotAccessibleChannels, listBotsForServer } from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import { toBotJson, type BotJson } from '@/lib/bots/admin';
import SettingsShell from '@/app/SettingsShell';
import BotsClient from './BotsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('bots', 'bots.metaTitle');
}

/**
 * Community Settings → Bots: the built-in Welcome and Moderation bots and
 * the server's custom (Bot API) bots. Same shape as the other settings
 * pages: the viewer's first community, loaded server-side; every change
 * goes through the guarded `/api/servers/{id}/bots` routes, which need
 * Manage Community — so does this page.
 */
export default async function BotsSettingsPage() {
  const access = await requireAdminSection('bots');
  const db = getDb();

  let server: { id: string; name: string } | null = null;
  let bots: BotJson[] = [];
  let channels: Array<{ id: string; name: string }> = [];
  let loadError: string | null = null;

  if (access.userId) {
    try {
      const first = access.server;
      if (first) {
        server = { id: first.id, name: first.name };
        const [rows, open] = await Promise.all([
          listBotsForServer(db, first.id),
          listBotAccessibleChannels(db, first.id),
        ]);
        bots = rows.map((row) => toBotJson(row, { includeSettings: true }));
        channels = open.map((channel) => ({ id: channel.id, name: channel.name }));
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community" sections={access.sections}>
      <BotsClient
        serverId={server?.id ?? null}
        serverName={server?.name ?? ''}
        initialBots={bots}
        channels={channels}
        loadError={loadError}
        canMutate={Boolean(access.sessionUserId && server)}
      />
    </SettingsShell>
  );
}
