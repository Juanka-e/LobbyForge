import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logAction } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeModerationTarget } from '@/lib/member-authorization';
import { getRoomServiceClient } from '@/lib/livekit';
import {
  CorePermission,
  requireVisibleChannelInServer,
  requireMaterializedSession,
  requireServerMember,
  requireServerPermission,
} from '@/lib/api-auth';
import { liveKitRoomName } from '@/lib/livekit-room';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MuteRequestSchema = z.object({
  muted: z.boolean(),
}).strict();

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
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const channel = await requireVisibleChannelInServer(session.uid, channelId, serverId);
    if (!channel.ok) return channel.response;
    if (channel.channel.type !== 'voice' && channel.channel.type !== 'stage') {
      return NextResponse.json({ error: 'Channel is not a voice room' }, { status: 400 });
    }
    // 10th-audit: voice mutes join the SAME hierarchy model as
    // kick/ban/timeout/roles — MUTE_MEMBERS plus the actor strictly
    // outranking the target (a rank-30 moderator could previously
    // mute a rank-80 admin).
    const gate = await authorizeModerationTarget({
      operation: 'voice_mute',
      serverId,
      actorUserId: session.uid,
      targetUserId,
    });
    if (!gate.ok) return gate.response;

    // 2. Validate body
    let body: z.infer<typeof MuteRequestSchema>;
    try {
      const raw = await req.json();
      body = MuteRequestSchema.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const identity = targetUserId;
    const room = liveKitRoomName(serverId, channelId);

    const lk = getRoomServiceClient();
    
    // RoomServiceClient.mutePublishedTrack requires trackSid.
    // We can list participants to find the microphone track.
    const participants = await lk.listParticipants(room);
    const participant = participants.find((p) => p.identity === identity);
    
    if (!participant) {
      return NextResponse.json({ error: 'Participant not found in the room' }, { status: 404 });
    }

    const audioTrack = participant.tracks.find(
      (t) => t.type === 0 || t.source === 1 // AUDIO = 0, MICROPHONE = 1 in livekit protos
    );

    if (!audioTrack) {
      return NextResponse.json({ error: 'Participant has no active audio track' }, { status: 400 });
    }

    await lk.mutePublishedTrack(room, identity, audioTrack.sid, body.muted);

    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: body.muted ? 'voice.mute' : 'voice.unmute',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { channelId, room },
    }).catch((err) => console.error('[audit] voice mute failed:', (err as Error).message));

    return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to mute participant' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'voice-mute', config: { windowMs: 60_000, maxRequests: 20 } },
});
