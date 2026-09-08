/**
 * Canonical channel + message authorization (LF-SEC-002).
 *
 * The message LIST route enforced membership + role-gated channel
 * visibility + READ_MESSAGE_HISTORY, while the single-message route
 * only checked membership + row relationships — a user whose private
 * role or history permission was removed could still fetch any message
 * by known ID. Both routes now derive their decision from THIS helper,
 * so the policy cannot diverge again.
 *
 * Operation semantics:
 *   read    → visibility + READ_MESSAGE_HISTORY  (list + single GET)
 *   mutate  → visibility only; the author-or-MANAGE_MESSAGES rule is
 *             applied by the message route AFTER channel access is
 *             proven (authoring a message never restores access to a
 *             channel you can no longer see)
 *   send    → visibility + SEND_MESSAGES (list POST)
 */
import { NextResponse } from 'next/server';
import { CorePermission } from '@lobbyforge/core';
import {
  getChannelById,
  getServerById,
  isServerMember,
  type ChannelRow,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { authorizeChannelVisibility, authorizeServerPermission } from '@/lib/permissions';

export type ChannelMessageOperation = 'read' | 'send' | 'mutate';

export interface ChannelMessageContext {
  server: { id: string; ownerUserId: string };
  channel: ChannelRow;
}

export async function authorizeChannelMessageAccess(input: {
  userId: string;
  serverId: string;
  channelId: string;
  operation: ChannelMessageOperation;
}): Promise<
  | { ok: true; context: ChannelMessageContext }
  | { ok: false; response: NextResponse }
> {
  const { userId, serverId, channelId, operation } = input;
  if (!serverId || !channelId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Server id and channel id are required' }, { status: 400 }),
    };
  }

  const server = await getServerById(getDb(), serverId);
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }

  const isOwner = server.ownerUserId === userId;
  if (!isOwner && !(await isServerMember(getDb(), userId, serverId))) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const channel = await getChannelById(getDb(), channelId);
  if (!channel || channel.serverId !== serverId) {
    return { ok: false, response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }) };
  }

  // Role-gated visibility (0028) — owner/manage_channels bypass inside.
  const visibility = await authorizeChannelVisibility(
    userId,
    serverId,
    channelId,
    server.ownerUserId ?? null
  );
  if (!visibility.ok) return visibility;

  if (operation === 'read') {
    // READ_MESSAGE_HISTORY: membership alone is not enough — a role can
    // revoke history (write-only channels, announcement-style rooms).
    const historyAuth = await authorizeServerPermission(
      userId,
      serverId,
      CorePermission.READ_MESSAGE_HISTORY
    );
    if (!historyAuth.ok) return { ok: false, response: historyAuth.response };
  } else if (operation === 'send') {
    const sendAuth = await authorizeServerPermission(
      userId,
      serverId,
      CorePermission.SEND_MESSAGES
    );
    if (!sendAuth.ok) return { ok: false, response: sendAuth.response };
  }

  return { ok: true, context: { server, channel } };
}
