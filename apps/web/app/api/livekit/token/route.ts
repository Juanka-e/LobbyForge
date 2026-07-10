import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  issueLiveKitToken,
  LIVEKIT_TOKEN_TTL_SECONDS,
  requireLiveKitCredentials,
  type LiveKitGrants,
} from '@/lib/livekit';
import { getEffectiveServerVoiceSettings } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import {
  CorePermission,
  requireChannelInServer,
  requireMaterializedSession,
  requireServerMember,
  requireServerPermission,
} from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { liveKitRoomName } from '@/lib/livekit-room';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TokenRequestSchema = z.object({
  serverId: z.string().uuid(),
  channelId: z.string().uuid(),
  // Optional display name override for the LiveKit participant list.
  // The server still uses the cookie's gid as the immutable identity.
  displayName: z.string().min(1).max(64).optional(),
  // Optional narrowing of publish / subscribe capabilities.
  canPublishSources: z
    .array(z.enum(['camera', 'microphone', 'screen-share', 'screen-share-audio']))
    .optional(),
  hidden: z.boolean().optional(),
  metadata: z.string().max(1024).optional(),
});

async function handler(req: Request): Promise<NextResponse> {
  const sessionResult = requireMaterializedSession(req);
  if (!sessionResult.ok) return sessionResult.response;
  const { session } = sessionResult;

  let body: z.infer<typeof TokenRequestSchema>;
  try {
    const raw = await req.json();
    body = TokenRequestSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const member = await requireServerMember(session.uid, body.serverId);
  if (!member.ok) return member.response;
  const channel = await requireChannelInServer(body.channelId, body.serverId);
  if (!channel.ok) return channel.response;
  if (channel.channel.type !== 'voice' && channel.channel.type !== 'stage') {
    return NextResponse.json({ error: 'Channel is not a voice room' }, { status: 400 });
  }
  const voicePermission = await requireServerPermission(session.uid, body.serverId, CorePermission.CONNECT_VOICE);
  if (!voicePermission.ok) return voicePermission.response;
  const voiceSettings = await getEffectiveServerVoiceSettings(getDb(), body.serverId);

  let apiKey: string;
  let apiSecret: string;
  try {
    ({ apiKey, apiSecret } = requireLiveKitCredentials());
  } catch {
    // Server-side misconfiguration. Don't leak the env var names; just say
    // the service is misconfigured so the caller knows it's not their fault.
    return NextResponse.json({ error: 'LiveKit service is misconfigured' }, { status: 503 });
  }

  const room = liveKitRoomName(body.serverId, body.channelId);
  const allowedPublishSources = buildAllowedPublishSources(voiceSettings, body.canPublishSources);
  const grants: LiveKitGrants = {
    room,
    canPublishSources: allowedPublishSources,
    hidden: body.hidden,
  };

  try {
    const identity = session.uid ?? session.gid;
    const token = await issueLiveKitToken({
      apiKey,
      apiSecret,
      identity,
      name: body.displayName ?? session.name,
      grants,
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });
    return NextResponse.json(
      {
        token,
        identity,
        room,
        serverId: body.serverId,
        channelId: body.channelId,
        ttlSeconds: LIVEKIT_TOKEN_TTL_SECONDS,
        expiresAt: session.exp,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to issue token' },
      { status: 500 }
    );
  }
}

export const POST = withApiSecurity(handler, {
  allowedMethods: ['POST'],
  // Token issuance is moderately expensive (HMAC + JWT serialization).
  rateLimit: { identifier: 'livekit-token', config: { windowMs: 60_000, maxRequests: 30 } },
});

function buildAllowedPublishSources(
  settings: { allowCamera: boolean; allowScreenShare: boolean },
  requested?: Array<'camera' | 'microphone' | 'screen-share' | 'screen-share-audio'>
): Array<'camera' | 'microphone' | 'screen-share' | 'screen-share-audio'> {
  const allowed = new Set<'camera' | 'microphone' | 'screen-share' | 'screen-share-audio'>(['microphone']);
  if (settings.allowCamera) allowed.add('camera');
  if (settings.allowScreenShare) {
    allowed.add('screen-share');
    allowed.add('screen-share-audio');
  }
  if (!requested) return Array.from(allowed);
  return requested.filter((source) => allowed.has(source));
}
