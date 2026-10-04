/**
 * What a channel's own lifecycle does to bot access (docs/BOT_API_V2.md
 * §1.1). Called by the channel PATCH / DELETE route:
 *
 *   - **deleted** → its `bot_channel_access` rows cascade away. A bot in
 *     `selected` mode that loses its LAST channel reaches nothing (the mode
 *     is stored; "no rows" is not "every open channel"). The bots that had
 *     a grant are audited and told (gateway recompute +
 *     `channel_access_changed`), every bot stream in the server re-checks
 *     its channels (`channel-policy`), and the fan-out cache is dropped.
 *   - **role restriction set** (`visibleToRoleIds` non-empty) → a private
 *     channel may only be granted by someone who can manage channels, so
 *     grants on it whose granter is not the owner and does not hold
 *     MANAGE_CHANNELS at that moment are dropped — audited and announced
 *     the same way. Re-run on every restriction change, so a retried
 *     request finishes the job.
 */
import { CorePermission, hasPermission } from '@lobbyforge/core';
import {
  getUserPermissions,
  listBotChannelGrantsForChannel,
  listBotsForServer,
  revokeBotChannelGrantsForChannel,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { auditBotAction } from './admin';
import { announceChannelAccessChange, invalidateBotEventTargets } from './events';

type ChannelChangeReason = 'channel_deleted' | 'channel_restricted';

/** The bots holding a grant on this channel (read BEFORE deleting it). */
export async function listBotsGrantedChannel(channelId: string): Promise<string[]> {
  const grants = await listBotChannelGrantsForChannel(getDb(), channelId);
  return Array.from(new Set(grants.map((g) => g.botId)));
}

async function announceLostChannel(input: {
  serverId: string;
  channelId: string;
  botIds: readonly string[];
  actorUserId: string;
  reason: ChannelChangeReason;
}): Promise<void> {
  if (input.botIds.length === 0) return;
  let bots: Map<string, { id: string; name: string; type: string }>;
  try {
    bots = new Map((await listBotsForServer(getDb(), input.serverId)).map((b) => [b.id, b]));
  } catch (err) {
    console.warn('[bots] channel change: bots not loaded for the audit:', (err as Error).message);
    bots = new Map();
  }
  for (const botId of input.botIds) {
    auditBotAction({
      serverId: input.serverId,
      actorUserId: input.actorUserId,
      action: 'bot.channel_access',
      bot: bots.get(botId) ?? { id: botId, name: '', type: 'custom' },
      metadata: { mode: 'selected', added: [], removed: [input.channelId], reason: input.reason },
    });
    try {
      // Drops the fan-out cache, publishes `bot-access`, tells the endpoint.
      await announceChannelAccessChange({ id: botId, serverId: input.serverId });
    } catch (err) {
      console.warn('[bots] channel change not announced:', (err as Error).message);
    }
  }
}

let invalidationModule: Promise<typeof import('@/lib/access-invalidation')> | null = null;

function publishChannelPolicy(serverId: string, channelId: string): void {
  // Lazy: `access-invalidation` opens the shared Redis connection on import.
  invalidationModule ??= import('@/lib/access-invalidation');
  void invalidationModule
    .then(({ publishAccessInvalidation }) =>
      publishAccessInvalidation({ kind: 'channel-policy', serverId, channelId, reason: 'permissions_changed' })
    )
    .catch((err) => console.warn('[bots] channel-policy invalidation not published:', (err as Error).message));
}

/**
 * After a channel was deleted. `botIds` = `listBotsGrantedChannel` read
 * before the delete. Never throws: the channel is already gone.
 */
export async function afterChannelDeleted(input: {
  serverId: string;
  channelId: string;
  botIds: readonly string[];
  actorUserId: string;
}): Promise<void> {
  invalidateBotEventTargets(input.serverId);
  // Every live subscription on the channel — browser and bot streams of
  // `all`-mode bots alike — re-checks and lets go of it.
  publishChannelPolicy(input.serverId, input.channelId);
  try {
    await announceLostChannel({ ...input, reason: 'channel_deleted' });
  } catch (err) {
    console.warn('[bots] channel delete not announced:', (err as Error).message);
  }
}

/**
 * After a channel got (or changed) a role restriction: drop the grants on
 * it that the granter could not make on a private channel right now (not
 * the owner, no MANAGE_CHANNELS — including a granter who left, was banned
 * or deleted their account). Returns the bots that lost the channel.
 */
export async function dropGrantsAfterRestriction(input: {
  serverId: string;
  ownerUserId: string | null;
  channelId: string;
  actorUserId: string;
}): Promise<string[]> {
  const grants = await listBotChannelGrantsForChannel(getDb(), input.channelId);
  if (grants.length === 0) return [];
  const allowed = new Set<string>();
  const granters = Array.from(new Set(grants.map((g) => g.grantedBy).filter((uid): uid is string => Boolean(uid))));
  for (const uid of granters) {
    if (input.ownerUserId && uid === input.ownerUserId) {
      allowed.add(uid);
      continue;
    }
    // [] for a non-member / banned user; the owner short-circuits above.
    const permissions = await getUserPermissions(getDb(), uid, input.serverId);
    if (hasPermission(permissions, CorePermission.MANAGE_CHANNELS)) allowed.add(uid);
  }
  const doomed = grants.filter((g) => !g.grantedBy || !allowed.has(g.grantedBy)).map((g) => g.botId);
  if (doomed.length === 0) return [];
  const dropped = Array.from(new Set(await revokeBotChannelGrantsForChannel(getDb(), input.channelId, doomed)));
  if (dropped.length > 0) {
    invalidateBotEventTargets(input.serverId);
    await announceLostChannel({ ...input, botIds: dropped, reason: 'channel_restricted' });
  }
  return dropped;
}
