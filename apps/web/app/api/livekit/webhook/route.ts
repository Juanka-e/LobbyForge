import { NextResponse } from 'next/server';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { logAction } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { getRoomServiceClient, requireLiveKitCredentials } from '@/lib/livekit';
import { parseLiveKitRoomName } from '@/lib/livekit-room';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { isTrackInfoAllowed, protoTrackKind, protoTrackSource } from '@/lib/voice-track-policy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * LiveKit webhook receiver — security-review AUTHZ-006 follow-up.
 *
 * LiveKit checks the SOURCE a new track claims against the token's
 * canPublishSources, never its KIND: a server-muted member (who keeps
 * camera + screen share) could publish their microphone as `camera` and
 * be heard by everyone. Listeners in the app already refuse such tracks
 * (lib/voice-track-policy.ts); this endpoint makes the SERVER enforce it:
 * on `track_published`, a track whose type does not match its source gets
 * its publisher removed from the room.
 *
 * Called only by LiveKit over the compose network
 * (http://web:3000/api/livekit/webhook — `webhook:` in livekit.yaml, or
 * LIVEKIT_CONFIG in the dev stack). nginx answers 404 for this path at
 * the public edge. Every request must carry LiveKit's signed JWT
 * (Authorization header, issued with LIVEKIT_API_KEY/SECRET, embedding
 * the body's sha256); anything else is a 401.
 */
async function handlePost(req: Request): Promise<NextResponse> {
  let apiKey: string;
  let apiSecret: string;
  try {
    ({ apiKey, apiSecret } = requireLiveKitCredentials());
  } catch {
    return NextResponse.json({ error: 'LiveKit service is misconfigured' }, { status: 503 });
  }

  const body = await req.text();
  // LiveKit sends the bare JWT; tolerate a "Bearer " prefix as well.
  const authorization = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!authorization) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let event: WebhookEvent;
  try {
    // Verifies the JWT (issuer = our API key, HMAC with our secret, not
    // expired) AND that its sha256 claim matches this exact body.
    event = await new WebhookReceiver(apiKey, apiSecret).receive(body, authorization);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (event.event !== 'track_published') {
    return NextResponse.json({ ok: true });
  }

  const room = event.room?.name ?? '';
  const identity = event.participant?.identity ?? '';
  if (!room || !identity || !event.track) {
    return NextResponse.json({ ok: true });
  }
  // The new track first; the participant's other tracks too, in case an
  // earlier event never arrived (LiveKit gives up after its retries).
  const offending = [event.track, ...(event.participant?.tracks ?? [])].find(
    (track) => !isTrackInfoAllowed(track)
  );
  if (!offending) {
    return NextResponse.json({ ok: true });
  }

  const source = protoTrackSource(offending.source);
  const type = protoTrackKind(offending.type);
  console.warn('[livekit/webhook] removing a participant who published a track whose type does not match its source', {
    room,
    identity,
    trackSid: offending.sid,
    source,
    type,
    mimeType: offending.mimeType || undefined,
  });

  try {
    await getRoomServiceClient().removeParticipant(room, identity);
  } catch (err) {
    if (!isNotFound(err)) {
      // 5xx → LiveKit's notifier retries the delivery (removal is idempotent).
      console.error('[livekit/webhook] removeParticipant failed:', (err as Error).message);
      return NextResponse.json({ error: 'Failed to remove participant' }, { status: 503 });
    }
    // Already gone (left, or removed by an earlier delivery) — nothing to do.
  }

  const scope = parseLiveKitRoomName(room);
  if (scope) {
    try {
      await logAction(getDb(), {
        serverId: scope.serverId,
        actorUserId: null,
        action: 'voice.track_rejected',
        targetType: 'user',
        targetId: identity,
        metadata: { channelId: scope.channelId, room, source, type },
      });
    } catch (err) {
      console.error('[audit] voice track rejection failed:', (err as Error).message);
    }
  }

  return NextResponse.json({ ok: true, removed: true });
}

/** RoomService answers 404 / `not_found` for a participant no longer in the room. */
function isNotFound(err: unknown): boolean {
  const { status, code } = (err ?? {}) as { status?: number; code?: string };
  return status === 404 || code === 'not_found';
}

// MACHINE endpoint — LiveKit sends no browser Origin; the signed JWT above
// is the authentication. Maintenance mode must not switch enforcement off.
// The body is the whole event (room + participant with ALL its tracks):
// the limit leaves room so a participant cannot pile up tracks until their
// own events stop being checked. LiveKit has no forwarded client address,
// so every delivery shares one bucket — hence the generous limit.
export const POST = withMachineApiSecurity(handlePost, {
  allowedMethods: ['POST'],
  maintenanceMode: 'bypass',
  maxBodyBytes: 512 * 1024,
  rateLimit: { identifier: 'livekit-webhook', config: { windowMs: 60_000, maxRequests: 6_000 } },
});
