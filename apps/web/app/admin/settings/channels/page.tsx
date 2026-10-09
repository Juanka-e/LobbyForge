import type { Metadata } from 'next';
import {
  getAllChannelRoleOverridesForServer,
  listChannelsForServer,
  listRolesBriefForServer,
  type ChannelRow,
} from '@lobbyforge/db';
import { adminPageMetadata, requireAdminSection } from '@/lib/admin-access';
import { getDb } from '@/lib/db';
import SettingsShell from '@/app/SettingsShell';
import ChannelsClient, { type ChannelView } from './ChannelsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata('channels', 'adminSettings.channels.metaTitle');
}

export default async function ChannelsSettingsPage() {
  const access = await requireAdminSection('channels');
  const db = getDb();

  let serverId: string | null = null;
  let channels: ChannelRow[] = [];
  let channelOverrides = new Map<string, string[]>();
  let roles: Array<{ id: string; name: string; position: number }> = [];
  let loadError: string | null = null;

  if (access.userId) {
    try {
      const firstServer = access.server;
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
    <SettingsShell scope="community" sections={access.sections}>
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
