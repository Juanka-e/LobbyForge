import { cookies } from 'next/headers';
import {
  getAllChannelRoleOverridesForServer,
  getInstanceSetupStatus,
  listChannelsForServer,
  listRolesBriefForServer,
  listServersForUser,
  type ChannelRow,
} from '@lobbyforge/db';
import { ADMIN_TOKEN_COOKIE, isInstanceAdminAllowed } from '@/lib/admin-auth';
import { getSessionSecret } from '@/lib/api-auth';
import { getDb } from '@/lib/db';
import { readGuestSession } from '@/lib/guest-session';
import SettingsShell from '@/app/SettingsShell';
import ChannelsClient, { type ChannelView } from './ChannelsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata = {
  title: 'Channels - Community Settings',
};

export default async function ChannelsSettingsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_TOKEN_COOKIE)?.value ?? null;
  if (!(await isInstanceAdminAllowed(cookieStore.toString(), token))) {
    return (
      <SettingsShell scope="community">
        <section>
          <h1 className="text-2xl font-semibold text-text-primary">Channels</h1>
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
  let channels: ChannelRow[] = [];
  let channelOverrides = new Map<string, string[]>();
  let roles: Array<{ id: string; name: string; position: number }> = [];
  let loadError: string | null = null;

  if (userId) {
    try {
      const servers = await listServersForUser(db, userId, { limit: 1 });
      const firstServer = servers[0];
      if (firstServer) {
        serverId = firstServer.id;
        channels = await listChannelsForServer(db, firstServer.id, { limit: 200 });
        roles = await listRolesBriefForServer(db, firstServer.id);
        // Seed the editor with each channel's current override set.
        const overrideRows = await getAllChannelRoleOverridesForServer(db, firstServer.id);
        const byChannel = new Map<string, string[]>();
        for (const row of overrideRows) {
          const list = byChannel.get(row.channelId) ?? [];
          list.push(row.roleId);
          byChannel.set(row.channelId, list);
        }
        channelOverrides = byChannel;
      }
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  return (
    <SettingsShell scope="community">
      <ChannelsClient
        serverId={serverId}
        initialChannels={channels.map((c) => ({
          ...toChannelView(c),
          visibleToRoleIds: channelOverrides.get(c.id) ?? [],
        }))}
        roles={roles}
        loadError={loadError}
      />
    </SettingsShell>
  );
}

function toChannelView(channel: ChannelRow): ChannelView {
  return {
    id: channel.id,
    serverId: channel.serverId,
    name: channel.name,
    type: channel.type,
    position: channel.position,
    pluginId: channel.pluginId,
    topic: channel.topic,
    createdAt: channel.createdAt.toISOString(),
  };
}
