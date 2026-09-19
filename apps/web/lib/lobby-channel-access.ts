/**
 * /lobby server-component authorization (beta-review S3).
 *
 * The lobby page loaded `listChannelsForServer` (EVERY channel, incl.
 * role-gated ones), picked `textChannels[0]` and loaded its last 50
 * messages without any access check — all of it serialized into the
 * HTML (gated channel NAMES were live-confirmed in the page source).
 * The page now applies the SAME rules as the REST API:
 *
 *   channel list → GET /api/servers/{id}/channels: owner / MANAGE_CHANNELS
 *                  see everything, everyone else `listVisibleChannelsForMember`;
 *   messages     → GET .../messages: `authorizeChannelMessageAccess('read')`
 *                  (visibility + READ_MESSAGE_HISTORY);
 *   membership   → ban-aware `isServerMember` (the owner always passes).
 */
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getUserPermissions,
  isServerMember,
  listVisibleChannelsForMember,
  type ChannelRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { authorizeChannelMessageAccess } from '@/lib/message-authorization';

type Db = ReturnType<typeof getDb>;

export type LobbyChannelView =
  | { allowed: false }
  | {
      allowed: true;
      /** The viewer's server permissions (owner → implicit administrator). */
      permissions: string[];
      /** The input channels the viewer may see, input order preserved. */
      channels: ChannelRow[];
    };

/**
 * Filter `channels` (already position-ordered) down to what the viewer
 * may see. `allowed: false` when the viewer is neither the owner nor a
 * current (non-banned) member — the caller must then render nothing.
 */
export async function resolveLobbyChannelView(
  db: Db,
  input: {
    serverId: string;
    userId: string;
    ownerUserId: string | null;
    channels: ChannelRow[];
  }
): Promise<LobbyChannelView> {
  const { serverId, userId, ownerUserId, channels } = input;
  const isOwner = ownerUserId !== null && ownerUserId === userId;
  if (!isOwner && !(await isServerMember(db, userId, serverId))) {
    return { allowed: false };
  }
  const permissions = await getUserPermissions(db, userId, serverId);
  if (isOwner || hasPermission(permissions, CorePermission.MANAGE_CHANNELS)) {
    return { allowed: true, permissions, channels };
  }
  const visibleIds = new Set(
    (await listVisibleChannelsForMember(db, serverId, userId)).map((c) => c.id)
  );
  return {
    allowed: true,
    permissions,
    channels: channels.filter((c) => visibleIds.has(c.id)),
  };
}

/**
 * May the viewer read `channelId`'s message history? Delegates to the
 * canonical policy the messages API uses, so the lobby's first paint can
 * never show more than GET .../messages would.
 */
export async function canReadLobbyChannelMessages(input: {
  userId: string;
  serverId: string;
  channelId: string;
}): Promise<boolean> {
  const access = await authorizeChannelMessageAccess({ ...input, operation: 'read' });
  return access.ok;
}
