import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logAction, setMemberVoiceMuted } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { withApiSecurity } from '@/lib/security-headers';
import { authorizeModerationTarget } from '@/lib/member-authorization';
import { syncMemberVoiceAccess } from '@/lib/voice-moderation';
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

    // beta-review: a server mute used to be a one-shot mutePublishedTrack
    // — the target could simply unmute (or rejoin), a user without a mic
    // track could not be muted at all (400), and `source === 1` matched
    // the CAMERA (TrackSource.MICROPHONE is 2). Now the mute is persisted
    // on the membership, the token route withholds the microphone grant
    // while it is set, and a connected participant's canPublishSources is
    // updated live. Lifting the mute only RE-ALLOWS the mic — it never
    // turns anyone's microphone on remotely.
    const updated = await setMemberVoiceMuted(getDb(), serverId, targetUserId, body.muted);
    if (!updated) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    await syncMemberVoiceAccess(serverId, targetUserId);
    const room = liveKitRoomName(serverId, channelId);

    void logAction(getDb(), {
      serverId,
      actorUserId: session.uid,
      action: body.muted ? 'voice.mute' : 'voice.unmute',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { channelId, room },
    }).catch((err) => console.error('[audit] voice mute failed:', (err as Error).message));

    return NextResponse.json({ success: true, muted: body.muted }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to mute participant' }, { status: 500 });
  }
}

export const POST = withApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  rateLimit: { identifier: 'voice-mute', config: { windowMs: 60_000, maxRequests: 20 } },
});
