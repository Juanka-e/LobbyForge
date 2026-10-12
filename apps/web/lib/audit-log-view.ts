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
 *  - Each row's metadata projected for the viewer (security-review
 *    AUTHZ-010, below) — the same projection GET /api/servers/{id}/audit-logs
 *    applies, so old rows are covered as well as new ones.
 */
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getUserPermissions,
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

/**
 * What one viewer of the audit log may read beyond VIEW_AUDIT_LOG itself
 * (security-review AUTHZ-010). Rows are append-only and written for the
 * owner; everyone else with View Audit Log gets them projected:
 *
 *  - an invite's `code` (`invite.create`, `invite.redeem` — new rows log
 *    the invite id instead) only for MANAGE_SERVER: the code is a working
 *    way into the community, and the invites list shows a member only
 *    their own;
 *  - a channel row's `name`, `topic` and `visibleToRoleIds`
 *    (`channel.create` / `channel.update`) only when the viewer may see that
 *    channel;
 *  - the Moderation Bot's `detail` (the blocked word, the link host) and
 *    `excerpt` only when the viewer may see the channel the message was in.
 */
export interface AuditViewerScope {
  /** MANAGE_SERVER (the owner and administrators hold it). */
  canSeeInviteCodes: boolean;
  /** Owner / MANAGE_CHANNELS: no channel is hidden from them. */
  seesAllChannels: boolean;
  /** Lower-case id → name of every channel the viewer may see (filled when needed). */
  channelNames: Map<string, string>;
}

/** Keys a `channel` row carries about the channel itself. */
const CHANNEL_TARGET_KEYS = ['name', 'topic', 'visibleToRoleIds'] as const;
/** Keys that quote a message posted in `metadata.channelId`. */
const CHANNEL_CONTENT_KEYS = ['detail', 'excerpt'] as const;

/** The channel a row is ABOUT (`targetType: 'channel'`), lower-cased. */
function targetChannelId(row: Pick<AuditLogRow, 'targetType' | 'targetId'>): string | null {
  return row.targetType === 'channel' && typeof row.targetId === 'string' && row.targetId
    ? row.targetId.toLowerCase()
    : null;
}

function metadataChannelId(row: Pick<AuditLogRow, 'metadata'>): string | null {
  const value = row.metadata?.channelId;
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function carriesInviteCode(row: Pick<AuditLogRow, 'action' | 'metadata'>): boolean {
  return row.action.startsWith('invite.') && row.metadata != null && 'code' in row.metadata;
}

/**
 * Resolve the scope above for `viewerUserId`, with as few queries as the
 * rows need: none when no row names a channel or an invite code (and none
 * for the owner unless channel names are wanted).
 */
export async function resolveAuditViewerScope(
  db: Db,
  input: { serverId: string; ownerUserId: string | null; viewerUserId: string },
  rows: ReadonlyArray<Pick<AuditLogRow, 'action' | 'targetType' | 'targetId' | 'metadata'>>,
  options: { channelNames?: boolean } = {}
): Promise<AuditViewerScope> {
  const isOwner = input.ownerUserId !== null && input.ownerUserId === input.viewerUserId;
  const needsChannels = rows.some((row) => targetChannelId(row) !== null || metadataChannelId(row) !== null);
  const needsCodes = rows.some(carriesInviteCode);

  if (needsChannels && (!isOwner || options.channelNames)) {
    const channels = await listChannelsForServer(db, input.serverId);
    const view = await resolveLobbyChannelView(db, {
      serverId: input.serverId,
      userId: input.viewerUserId,
      ownerUserId: input.ownerUserId,
      channels,
    });
    if (!view.allowed) return { canSeeInviteCodes: false, seesAllChannels: false, channelNames: new Map() };
    const channelNames = new Map<string, string>();
    for (const channel of view.channels) channelNames.set(channel.id.toLowerCase(), channel.name);
    return {
      canSeeInviteCodes: isOwner || hasPermission(view.permissions, CorePermission.MANAGE_SERVER),
      seesAllChannels: isOwner || hasPermission(view.permissions, CorePermission.MANAGE_CHANNELS),
      channelNames,
    };
  }
  if (isOwner) return { canSeeInviteCodes: true, seesAllChannels: true, channelNames: new Map() };
  const canSeeInviteCodes = needsCodes
    ? hasPermission(await getUserPermissions(db, input.viewerUserId, input.serverId), CorePermission.MANAGE_SERVER)
    : false;
  // No row names a channel: nothing to hide or name.
  return { canSeeInviteCodes, seesAllChannels: true, channelNames: new Map() };
}

/** One row's metadata as this viewer may read it (see AuditViewerScope). The row is never mutated. */
export function projectAuditMetadata(
  row: Pick<AuditLogRow, 'action' | 'targetType' | 'targetId' | 'metadata'>,
  scope: AuditViewerScope
): Record<string, unknown> {
  const metadata = row.metadata ?? {};
  const hidden: string[] = [];
  if (!scope.canSeeInviteCodes && carriesInviteCode(row)) hidden.push('code');
  if (!scope.seesAllChannels) {
    const target = targetChannelId(row);
    if (target && !scope.channelNames.has(target)) hidden.push(...CHANNEL_TARGET_KEYS);
    const posted = metadataChannelId(row);
    if (posted && !scope.channelNames.has(posted)) hidden.push(...CHANNEL_CONTENT_KEYS);
  }
  if (!hidden.some((key) => key in metadata)) return metadata;
  const projected = { ...metadata };
  for (const key of hidden) delete projected[key];
  return projected;
}

export async function loadAuditEntries(
  db: Db,
  input: { serverId: string; ownerUserId: string | null; viewerUserId: string; limit?: number }
): Promise<AuditEntryView[]> {
  const rows: AuditLogRow[] = await listAuditLogsForServer(db, input.serverId, { limit: input.limit ?? 100 });
  if (rows.length === 0) return [];

  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.actorUserId) userIds.add(row.actorUserId);
    if (row.targetType === 'user' && row.targetId && UUID_RE.test(row.targetId)) userIds.add(row.targetId);
    for (const id of Object.values(metadataUserIds(row))) userIds.add(id);
  }

  const [names, scope] = await Promise.all([
    userIds.size > 0 ? listUserDisplayNames(db, [...userIds]) : Promise.resolve(new Map<string, string>()),
    resolveAuditViewerScope(db, input, rows, { channelNames: true }),
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
      metadata: projectAuditMetadata(row, scope),
      actorName: row.actorUserId ? names.get(row.actorUserId) ?? null : null,
      targetName: row.targetType === 'user' && row.targetId ? names.get(row.targetId) ?? null : null,
      channelName: channelId ? scope.channelNames.get(channelId) ?? null : null,
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
