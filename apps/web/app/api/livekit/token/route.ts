import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TrackSource } from 'livekit-server-sdk';
import {
  getRoomServiceClient,
  issueLiveKitToken,
  LIVEKIT_TOKEN_TTL_SECONDS,
  requireLiveKitCredentials,
  type LiveKitGrants,
} from '@/lib/livekit';
import {
  getActiveMemberTimeout,
  getEffectiveServerVoiceSettings,
  getServerMember,
  getUserById,
  getUserPermissions,
  isMemberVoiceMuted,
} from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import {
  CorePermission,
  requireVisibleChannelInServer,
  requireMaterializedSession,
  requireServerMember,
  requireServerPermission,
} from '@/lib/api-auth';
import { withApiSecurity } from '@/lib/security-headers';
import { liveKitRoomName } from '@/lib/livekit-room';
import { getEphemeralTurnIceServers } from '@/lib/turn-credentials';
import { buildAllowedPublishSources } from '@/lib/voice-moderation';
import { getRuntimeLiveKitUrl } from '@/lib/public-endpoints';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TokenRequestSchema = z.object({
  serverId: z.string().uuid(),
  channelId: z.string().uuid(),
  // beta-review: accepted for backward compatibility but IGNORED — the
  // participant name is resolved server-side (nickname → profile name) so
  // a member cannot appear under someone else's name in voice.
  displayName: z.string().min(1).max(64).optional(),
  // Optional narrowing of publish / subscribe capabilities (client-initiated).
  // The server intersects these with the server voice settings policy.
  canPublishSources: z
    .array(z.enum(['camera', 'microphone', 'screen-share', 'screen-share-audio']))
    .optional(),
  // hidden and metadata are NOT accepted from the client — they are
  // server-generated only. A regular user must not be able to become
  // a hidden participant or inject arbitrary metadata.
}).strict();

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
  const channel = await requireVisibleChannelInServer(session.uid, body.channelId, body.serverId);
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

  // Enforce per-room limits (defaultUserLimit, maxCameraUsersPerRoom,
  // maxScreenShareUsersPerRoom). These require a LiveKit participant list,
  // so only fetch it when at least one limit is configured.
  // VOICE-003: the defaultUserLimit is a HARD capacity cap — if we
  // cannot count the room we cannot honor it, and fail-open would let
  // every requester in during an API blip. Fail CLOSED (503, retryable)
  // for the room-cap check; camera/screen-share caps degrade to OFF
  // (safer: fewer publishers, never more).
  let effectiveAllowCamera = voiceSettings.allowCamera;
  let effectiveAllowScreenShare = voiceSettings.allowScreenShare;
  const hasLimitConfig =
    voiceSettings.defaultUserLimit != null ||
    voiceSettings.maxCameraUsersPerRoom != null ||
    voiceSettings.maxScreenShareUsersPerRoom != null;
  if (hasLimitConfig) {
    try {
      const participants = await getRoomServiceClient().listParticipants(room);
      if (
        voiceSettings.defaultUserLimit != null &&
        participants.length >= voiceSettings.defaultUserLimit
      ) {
        return NextResponse.json({ error: 'Voice room is full' }, { status: 409 });
      }
      if (voiceSettings.maxCameraUsersPerRoom != null && effectiveAllowCamera) {
        const cameraPublishers = participants.filter((p) =>
          p.tracks.some((t) => t.source === TrackSource.CAMERA)
        ).length;
        if (cameraPublishers >= voiceSettings.maxCameraUsersPerRoom) {
          effectiveAllowCamera = false;
        }
      }
      if (voiceSettings.maxScreenShareUsersPerRoom != null && effectiveAllowScreenShare) {
        const screenSharePublishers = participants.filter((p) =>
          p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE)
        ).length;
        if (screenSharePublishers >= voiceSettings.maxScreenShareUsersPerRoom) {
          effectiveAllowScreenShare = false;
        }
      }
    } catch (err) {
      // VOICE-003: the ROOM CAP is a hard limit — fail closed when we
      // cannot count. Camera/screen-share caps degrade to denied (a
      // safer default than allowing unbounded publishers).
      console.error('[livekit/token] participant count failed:', (err as Error).message);
      if (voiceSettings.defaultUserLimit != null) {
        return NextResponse.json(
          { error: 'Voice room capacity cannot be verified — retry shortly.', retryable: true },
          { status: 503 }
        );
      }
      if (voiceSettings.maxCameraUsersPerRoom != null) effectiveAllowCamera = false;
      if (voiceSettings.maxScreenShareUsersPerRoom != null) effectiveAllowScreenShare = false;
    }
  }

  const memberPermissions = await getUserPermissions(getDb(), session.uid, body.serverId);
  const activeTimeout = await getActiveMemberTimeout(getDb(), body.serverId, session.uid);
  // beta-review: a moderator server mute is persisted and enforced in the
  // GRANT — rejoining cannot bring the microphone back.
  const serverMuted = await isMemberVoiceMuted(getDb(), body.serverId, session.uid);
  const allowedPublishSources = buildAllowedPublishSources(
    {
      allowCamera: effectiveAllowCamera,
      allowScreenShare: effectiveAllowScreenShare,
      memberPermissions,
      timedOut: activeTimeout !== null,
      voiceMuted: serverMuted,
    },
    body.canPublishSources
  );
  const grants: LiveKitGrants = {
    room,
    canPublishSources: allowedPublishSources,
    hidden: false, // Regular users are never hidden — admin bots use a separate endpoint.
  };

  try {
    const identity = session.uid ?? session.gid;
    // Server-generated metadata — the client cannot inject arbitrary metadata.
    const metadata = JSON.stringify({ uid: identity, kind: 'user' });
    const token = await issueLiveKitToken({
      apiKey,
      apiSecret,
      identity,
      name: await resolveVoiceDisplayName(body.serverId, session.uid, session.name),
      grants,
      metadata,
    });
    // VOICE-001: per-user, time-limited TURN credentials ride with the
    // token (coturn REST auth) — clients apply them via rtcConfig. Null
    // when TURN is not deployed (dev stacks); livekit.yaml no longer
    // advertises a static turn_servers credential at all.
    const turnIceServers = getEphemeralTurnIceServers(identity);
    return NextResponse.json(
      {
        token,
        identity,
        room,
        serverId: body.serverId,
        channelId: body.channelId,
        // beta-review: resolved at REQUEST time (NEXT_PUBLIC_* is frozen at
        // build time; a published image must not carry localhost). null →
        // the browser uses the same-origin /livekit reverse-proxy path.
        livekitUrl: getRuntimeLiveKitUrl(),
        ttlSeconds: LIVEKIT_TOKEN_TTL_SECONDS,
        expiresAt: session.exp,
        ...(turnIceServers ? { iceServers: [turnIceServers] } : {}),
        // Client-side voice policy (honor-system). The client uses these to
        // force push-to-talk mode and/or start muted, overriding the user's
        // own preferences. Hard limits (user/camera/screen-share caps) are
        // enforced above at token-mint time.
        serverVoiceSettings: {
          serverMuted,
          requirePushToTalk: voiceSettings.requirePushToTalk,
          startMuted: voiceSettings.startMuted,
          maxScreenShareHeight: voiceSettings.maxScreenShareHeight,
          maxScreenShareFps: voiceSettings.maxScreenShareFps,
        },
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

/**
 * Per-MEMBER publish sources = server-wide toggles ∩ the member's ROLE
 * permissions ∩ their moderation state:
 *  - SPEAK gates the microphone (no SPEAK → listen-only participant).
 *  - STREAM gates camera AND screen-share (a moderator/role can restrict
 *    exactly who may turn on a camera or share a screen — role-level,
 *    not just the owner's server-wide switch).
 *  - An active MODERATE_MEMBERS timeout strips the microphone (the
 *    timed-out member can still listen).
 */
async function resolveVoiceDisplayName(serverId: string, userId: string, fallback: string): Promise<string> {
  try {
    const member = await getServerMember(getDb(), serverId, userId);
    if (member?.nickname) return member.nickname.slice(0, 64);
    const user = await getUserById(getDb(), userId);
    if (user?.displayName) return user.displayName.slice(0, 64);
  } catch {
    // Fall back to the signed session name.
  }
  return fallback;
}
