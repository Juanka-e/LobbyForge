import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logAction } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeModerationTarget } from '@/lib/member-authorization';
import { getRoomServiceClient } from '@/lib/livekit';
import { requireMaterializedSession, requireVisibleChannelInServer } from '@/lib/api-auth';
import { liveKitRoomName } from '@/lib/livekit-room';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The request carries nothing: the room is derived from the URL, never sent. */
const DisconnectRequestSchema = z.object({}).strict();

/**
 * Discord-style "Disconnect from voice": a moderator removes someone from
 * ONE voice room, and that is all. Unlike the anti-cheat removal in the
 * LiveKit webhook, this records no voice block and the token route keeps
 * issuing tokens — the person can rejoin at once (docs/VOICE_ROOM.md).
 *
 * Permission: MUTE_MEMBERS (there is no move-members permission), through
 * the canonical hierarchy gate — the actor must outrank the target, the
 * owner cannot be disconnected, and disconnecting yourself is refused
 * (leaving is the client's own Disconnect button).
 */
async function handlePost(
  req: Request,
  ctx: { params: Promise<{ id: string; channelId: string; userId: string }> }
): Promise<NextResponse> {
  const { id: serverId, channelId, userId: targetUserId } = await ctx.params;

  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { session } = sessionResult;

  try {
    if (!serverId || !channelId || !targetUserId) {
      return NextResponse.json({ error: 'Missing required parameters', code: 'invalid_request' }, { status: 400 });
    }

    const channel = await requireVisibleChannelInServer(session.uid, channelId, serverId);
    if (!channel.ok) return channel.response;
    if (channel.channel.type !== 'voice' && channel.channel.type !== 'stage') {
      return NextResponse.json({ error: 'Channel is not a voice room', code: 'not_voice_channel' }, { status: 400 });
    }

    const gate = await authorizeModerationTarget({
      operation: 'voice_disconnect',
      serverId,
      actorUserId: session.uid,
      targetUserId,
    });
    if (!gate.ok) return gate.response;

    // An empty body (or `{}`) only; anything else — a client-chosen room
    // name above all — is refused rather than ignored.
    try {
      const text = await req.text();
      DisconnectRequestSchema.parse(text.trim() ? JSON.parse(text) : {});
    } catch {
      return NextResponse.json({ error: 'Invalid request body', code: 'invalid_request' }, { status: 400 });
    }

    const room = liveKitRoomName(serverId, channelId);
    let roomService: ReturnType<typeof getRoomServiceClient>;
    try {
      roomService = getRoomServiceClient();
    } catch {
      return NextResponse.json({ error: 'LiveKit service is misconfigured', code: 'voice_unavailable' }, { status: 503 });
    }
    try {
      await roomService.removeParticipant(room, targetUserId);
    } catch (err) {
      if (isNotFound(err)) {
        return NextResponse.json(
          { error: 'That member is not in this voice channel', code: 'not_in_voice' },
          { status: 404 }
        );
      }
      console.error('[voice/disconnect] removeParticipant failed:', (err as Error).message);
      return NextResponse.json({ error: 'Could not reach the voice server', code: 'voice_unavailable' }, { status: 503 });
    }

    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: 'voice.disconnect',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { channelId },
    }).catch((err) => console.error('[audit] voice disconnect failed:', (err as Error).message));

    return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to disconnect participant' }, { status: 500 });
  }
}

/** RoomService answers 404 / `not_found` for a participant who is not in the room (or a room that does not exist). */
function isNotFound(err: unknown): boolean {
  const e = (err ?? {}) as { status?: number; code?: string | number; message?: string };
  return e.status === 404 || e.code === 'not_found' || /not.?found|does not exist/i.test(e.message ?? '');
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'voice-disconnect', config: { windowMs: 60_000, maxRequests: 20 } },
});
