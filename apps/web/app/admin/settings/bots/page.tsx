import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import {
  getInstanceSetupStatus,
  listBotAccessibleChannels,
  listBotsForServer,
  listServersForUser,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { getActiveSession } from '@/lib/active-session';
import { getTranslator } from '@/lib/i18n/server';
import { toBotJson, type BotJson } from '@/lib/bots/admin';
import SettingsShell from '@/app/SettingsShell';
import BotsClient from './BotsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t('bots.metaTitle') };
}

/**
 * Community Settings → Bots: the built-in Welcome and Moderation bots and
 * the server's custom (Bot API) bots. Same shape as the other settings
 * pages: the owner's first community, loaded server-side; every change
 * goes through the guarded `/api/servers/{id}/bots` routes.
 */
export default async function BotsSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    const t = await getTranslator();
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">{t('bots.title')}</h1>
          <p className="mt-2 text-sm text-danger">{t('common.adminRequired')}</p>
        </section>
      </SettingsShell>
    );
  }

  const db = getDb();
  const setup = await getInstanceSetupStatus(db);
  const session = await getActiveSession(cookieStore.toString(), getSessionSecret());
  const userId = session?.uid ?? setup.ownerUserId ?? null;

  let server: { id: string; name: string } | null = null;
  let bots: BotJson[] = [];
  let channels: Array<{ id: string; name: string }> = [];
  let loadError: string | null = null;

  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const first = servers[0];
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
    <SettingsShell scope="community">
      <BotsClient
        serverId={server?.id ?? null}
        serverName={server?.name ?? ''}
        initialBots={bots}
        channels={channels}
        loadError={loadError}
        canMutate={Boolean(session?.uid && server)}
      />
    </SettingsShell>
  );
}
