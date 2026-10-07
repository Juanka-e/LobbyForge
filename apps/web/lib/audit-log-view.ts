/**
 * The audit page's rows, decorated for moderators (Community Settings →
 * Audit Log). Server only.
 *
 *  - Actor AND `user`-target display names in ONE batch lookup
 *    (`listUserDisplayNames`: id + display name, never the avatar or
 *    banner data URLs — security-review FILE-001).
 *  - The name of the channel a row's `metadata.channelId` points at, but
 *    only for channels this viewer may see: the same rule as the channel
 *    list (owner / MANAGE_CHANNELS see all, everyone else the channels
 *    their roles open). A hidden or deleted channel stays unnamed.
 */
import {
  listAuditLogsForServer,
  listChannelsForServer,
  listUserDisplayNames,
  type AuditLogRow,
} from '@lobbyforge/db';
import type { AuditEntryView } from '@/lib/audit-event-summary';
import type { getDb } from '@/lib/db';
import { resolveLobbyChannelView } from '@/lib/lobby-channel-access';

type Db = ReturnType<typeof getDb>;

/** Users and channels are uuids; anything else (a `bot:` identity…) is never looked up. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadAuditEntries(
  db: Db,
  input: { serverId: string; ownerUserId: string | null; viewerUserId: string; limit?: number }
): Promise<AuditEntryView[]> {
  const rows: AuditLogRow[] = await listAuditLogsForServer(db, input.serverId, { limit: input.limit ?? 100 });
  if (rows.length === 0) return [];

  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const row of rows) {
    if (row.actorUserId) userIds.add(row.actorUserId);
    if (row.targetType === 'user' && row.targetId && UUID_RE.test(row.targetId)) userIds.add(row.targetId);
    for (const id of Object.values(metadataUserIds(row))) userIds.add(id);
    const channelId = metadataChannelId(row);
    if (channelId) channelIds.add(channelId);
  }

  const [names, channelNames] = await Promise.all([
    userIds.size > 0 ? listUserDisplayNames(db, [...userIds]) : Promise.resolve(new Map<string, string>()),
    channelIds.size > 0 ? visibleChannelNames(db, input) : Promise.resolve(new Map<string, string>()),
  ]);

  return rows.map((row) => {
    const channelId = metadataChannelId(row);
    const metadataNames: Record<string, string> = {};
    for (const [field, id] of Object.entries(metadataUserIds(row))) {
      const name = names.get(id);
      if (name) metadataNames[field] = name;
    }
    return {
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata,
      actorName: row.actorUserId ? names.get(row.actorUserId) ?? null : null,
      targetName: row.targetType === 'user' && row.targetId ? names.get(row.targetId) ?? null : null,
      channelName: channelId ? channelNames.get(channelId) ?? null : null,
      ...(Object.keys(metadataNames).length > 0 ? { metadataNames } : {}),
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * Members a row names in its metadata, by field — only for the actions
 * whose summary reads them (`activity.host_transfer`: who had hosting,
 * who got it). Display names only, like actors and targets.
 */
const METADATA_USER_FIELDS: Record<string, readonly string[]> = {
  'activity.host_transfer': ['fromUserId', 'toUserId'],
};

function metadataUserIds(row: AuditLogRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of METADATA_USER_FIELDS[row.action] ?? []) {
    const value = row.metadata?.[field];
    if (typeof value === 'string' && UUID_RE.test(value)) out[field] = value;
  }
  return out;
}

function metadataChannelId(row: AuditLogRow): string | null {
  const value = row.metadata?.channelId;
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/** id → name for every channel of the server the viewer may see. */
async function visibleChannelNames(
  db: Db,
  input: { serverId: string; ownerUserId: string | null; viewerUserId: string }
): Promise<Map<string, string>> {
  const channels = await listChannelsForServer(db, input.serverId);
  const view = await resolveLobbyChannelView(db, {
    serverId: input.serverId,
    userId: input.viewerUserId,
    ownerUserId: input.ownerUserId,
    channels,
  });
  const out = new Map<string, string>();
  if (!view.allowed) return out;
  for (const channel of view.channels) out.set(channel.id.toLowerCase(), channel.name);
  return out;
}
