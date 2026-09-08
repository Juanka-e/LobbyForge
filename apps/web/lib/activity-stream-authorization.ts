/**
 * LF-SEC-003 (9th-audit): canonical activity-stream authorization.
 *
 * The SSE keepalive previously re-ran ONLY channel visibility — which
 * does not check server membership, and whose underlying
 * canMemberAccessChannel returns true for members-of-nothing on
 * public (no-override) channels. A kicked user's open stream kept
 * flowing. This helper is the ONE decision both stream-open and the
 * periodic revalidation use:
 *
 *   server exists → owner-or-member → session belongs to the server →
 *   channel visibility policy
 */
import { NextResponse } from 'next/server';
import { getServerById, isServerMember, type ChannelRow } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { authorizeChannelVisibility } from '@/lib/permissions';

export interface ActivityStreamScope {
  serverId: string;
  channelId: string | null;
  /** The game session row (needs .channelId and .serverId). */
  session: { id: string; serverId: string; channelId: string | null };
}

/** Full gate — returns null when authorized, else a response to send. */
export async function denyActivityStreamAccess(
  userId: string,
  scope: ActivityStreamScope
): Promise<NextResponse | null> {
  const server = await getServerById(getDb(), scope.serverId);
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 });
  }

  const isOwner = server.ownerUserId === userId;
  if (!isOwner && !(await isServerMember(getDb(), userId, scope.serverId))) {
    // Kicked / left / banned — membership is re-checked on EVERY call.
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (scope.session.serverId !== scope.serverId) {
    return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
  }

  if (scope.session.channelId) {
    const visibility = await authorizeChannelVisibility(
      userId,
      scope.serverId,
      scope.session.channelId,
      server.ownerUserId ?? null
    );
    if (!visibility.ok) return visibility.response;
  }

  return null;
}
