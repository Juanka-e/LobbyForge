/**
 * Per-topic authorization for the WS gateway.
 *
 * Every `subscribe` call is checked against the user's server membership
 * before we forward it to the Redis subscriber. A user can only listen
 * to topics whose `serverId` matches a server they belong to (or own).
 *
 * This is the same membership rule the SSE route enforces on its
 * snapshot fetch — the WS gateway just runs it per subscribe because
 * the client can multiplex across topics.
 */
import { getServerById, isServerMember, isDmChannelParticipant } from '@lobbyforge/db';
import { parseTopic } from './protocol.js';

export type AuthorizeResult =
  | { ok: true; kind: 'activity-state' | 'chat' | 'presence' | 'dm'; serverId: string; resourceId: string }
  | { ok: false; reason: 'unknown_topic' | 'server_not_found' | 'forbidden' };

export async function authorizeTopicSubscribe(
  db: unknown,
  userId: string,
  topic: string
): Promise<AuthorizeResult> {
  const parsed = parseTopic(topic);
  if (!parsed) return { ok: false, reason: 'unknown_topic' };

  // DM topics: check channel participation instead of server membership.
  if (parsed.kind === 'dm') {
    const isParticipant = await isDmChannelParticipant(
      db as Parameters<typeof isDmChannelParticipant>[0],
      parsed.resourceId,
      userId
    );
    if (!isParticipant) return { ok: false, reason: 'forbidden' };
    return { ok: true, kind: 'dm', serverId: parsed.serverId, resourceId: parsed.resourceId };
  }

  const server = await getServerById(db as Parameters<typeof getServerById>[0], parsed.serverId);
  if (!server) return { ok: false, reason: 'server_not_found' };

  if (server.ownerUserId !== userId) {
    const member = await isServerMember(
      db as Parameters<typeof isServerMember>[0],
      userId,
      parsed.serverId
    );
    if (!member) return { ok: false, reason: 'forbidden' };
  }

  return { ok: true, kind: parsed.kind, serverId: parsed.serverId, resourceId: parsed.resourceId };
}