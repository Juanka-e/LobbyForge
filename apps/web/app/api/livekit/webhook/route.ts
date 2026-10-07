import { NextResponse } from 'next/server';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { getActiveGameSessionForChannel, logAction } from '@lobbyforge/db';
import { getDb } from '@/lib/db';
import { publishActivityStateChange } from '@/lib/activity-bus';
import { getRoomServiceClient, requireLiveKitCredentials } from '@/lib/livekit';
import { parseLiveKitRoomName } from '@/lib/livekit-room';
import { withMachineApiSecurity } from '@/lib/security-headers';
import { blockVoice, claimVoiceBlockEnforcedAudit, getVoiceBlock, type VoiceBlockResult } from '@/lib/voice-block';
import {
  isTrackInfoAllowed,
  isTrackKindAllowedForSource,
  protoTrackKind,
  protoTrackSource,
} from '@/lib/voice-track-policy';

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
 * Removal alone does not keep them out: LiveKit OSS RemoveParticipant does
 * not revoke tokens. So the publisher is also blocked from voice on that
 * server for a while (lib/voice-block.ts — the token route refuses new
 * tokens), and on `participant_joined` a blocked identity is removed again
 * at once: that is a token minted before the block, still valid. Both
 * removals are audited (`voice.track_rejected`, `voice.block_enforced`) so
 * moderators see who the check caught in the audit log.
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

  if (event.event === 'participant_joined') {
    void noteVoicePresence(event, 'joined');
    return handleParticipantJoined(event);
  }
  if (event.event === 'participant_left') {
    void noteVoicePresence(event, 'left');
    return NextResponse.json({ ok: true });
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

  const scope = parseLiveKitRoomName(room);
  // Block BEFORE removing: once removed, a modified client reconnects
  // within milliseconds, and the token route must already say no. The
  // participant SID makes a redelivery of this event (after a 503 below)
  // and the connection's other bad tracks count as ONE offence.
  let block: VoiceBlockResult | null = null;
  if (scope) {
    try {
      block = await blockVoice(scope, identity, { offenceId: event.participant?.sid || event.id || undefined });
    } catch (err) {
      // Removal still goes ahead. Without Redis the token route refuses
      // every token in production anyway (fail-closed, see voice-block.ts).
      console.error('[livekit/webhook] could not record the voice block:', (err as Error).message);
    }
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
    blockedSeconds: block?.seconds,
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

  // The block covers the whole server, so a second live connection in
  // another voice channel of the same server must go too — otherwise a
  // modified client keeps talking there (LiveKit keeps refreshing that
  // connection's token). Best effort: the offending room is already handled.
  if (scope) await removeFromOtherServerRooms(scope.serverId, room, identity);

  if (scope) {
    try {
      await logAction(getDb(), {
        serverId: scope.serverId,
        actorUserId: null,
        action: 'voice.track_rejected',
        targetType: 'user',
        targetId: identity,
        metadata: {
          channelId: scope.channelId,
          room,
          source,
          type,
          // Only when the declared type and source agree and the MEDIA was
          // the problem (a "video" camera track carrying audio/opus): the
          // audit log then says so instead of "video published as camera".
          ...(offending.mimeType && isTrackKindAllowedForSource(type, source) ? { mimeType: offending.mimeType } : {}),
          ...(block ? { blockedSeconds: block.seconds } : {}),
        },
      });
    } catch (err) {
      console.error('[audit] voice track rejection failed:', (err as Error).message);
    }
  }

  return NextResponse.json({ ok: true, removed: true });
}

/**
 * `participant_joined` while blocked: the identity is connecting with a
 * token minted before the block (the token route refuses new ones). Remove
 * it at once, and write a lightweight `voice.block_enforced` audit row —
 * at most one per user, per server, per minute (a Redis `SET NX EX` claim),
 * so a reconnect loop cannot flood the log. No row when Redis cannot take
 * the claim: the removal matters, the row does not.
 */
async function handleParticipantJoined(event: WebhookEvent): Promise<NextResponse> {
  const room = event.room?.name ?? '';
  const identity = event.participant?.identity ?? '';
  const scope = room ? parseLiveKitRoomName(room) : null;
  if (!scope || !identity) {
    return NextResponse.json({ ok: true });
  }

  let block: { retryAfterSeconds: number } | null;
  try {
    block = await getVoiceBlock(scope, identity);
  } catch (err) {
    // Fail OPEN here, and answer 200 rather than asking for a retry:
    // LiveKit queues a room's webhooks one after another (keyed by room
    // name), so retrying every join while Redis is down would hold back
    // that room's track_published events, the ones that matter. The token
    // route is the primary gate and fails closed in production.
    console.error('[livekit/webhook] voice block check failed:', (err as Error).message);
    return NextResponse.json({ ok: true });
  }
  if (!block) {
    return NextResponse.json({ ok: true });
  }

  console.warn('[livekit/webhook] removing a participant who joined while blocked from voice', { room, identity });
  try {
    await getRoomServiceClient().removeParticipant(room, identity);
  } catch (err) {
    if (!isNotFound(err)) {
      console.error('[livekit/webhook] removeParticipant failed:', (err as Error).message);
      return NextResponse.json({ error: 'Failed to remove participant' }, { status: 503 });
    }
  }
  await auditBlockEnforced(scope, room, identity, block.retryAfterSeconds);
  return NextResponse.json({ ok: true, removed: true });
}

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ParticipantInfo.Kind.STANDARD (protojson omits the zero value). */
const STANDARD_KINDS = new Set<unknown>([undefined, 0, 'STANDARD']);

/**
 * Activity host presence (lib/activity-voice.ts, lib/activity-host.ts):
 * record WHEN someone left a voice room and forget it when they come back,
 * so a host who left is handed over after exactly the grace period. If the
 * person is an open activity's host in that channel, tell its panels to
 * re-read the session (they learn the host is away, or back).
 *
 * Fire-and-forget, after the answer: this must never hold back the room's
 * webhook queue (LiveKit delivers a room's events one after another), and a
 * failure only costs precision — the lazy reader starts the clock itself.
 */
async function noteVoicePresence(event: WebhookEvent, kind: 'joined' | 'left'): Promise<void> {
  const room = event.room?.name ?? '';
  const identity = event.participant?.identity ?? '';
  const scope = room ? parseLiveKitRoomName(room) : null;
  if (!scope || !USER_ID_RE.test(identity)) return;
  if (!STANDARD_KINDS.has(event.participant?.kind as unknown)) return;
  try {
    const { forgetVoiceRoomSnapshot, recordVoiceJoined, recordVoiceLeft } = await import('@/lib/activity-voice');
    forgetVoiceRoomSnapshot(room);
    if (kind === 'joined') {
      await recordVoiceJoined(room, identity);
    } else {
      // A second connection with the same identity (another tab, or the
      // new connection LiveKit kept when it replaced a duplicate) means
      // they never left.
      if (await stillInRoom(room, identity)) return;
      await recordVoiceLeft(room, identity, Date.now());
    }
    const active = await getActiveGameSessionForChannel(getDb(), scope.channelId);
    if (active && active.serverId === scope.serverId && active.createdBy === identity) {
      // No identities on the bus: panels re-read the session (host included).
      publishActivityStateChange({
        serverId: scope.serverId,
        sessionId: active.id,
        status: active.status,
        publicSummary: { rosterChanged: true },
      });
    }
  } catch (err) {
    console.warn('[livekit/webhook] voice presence not recorded:', (err as Error).message);
  }
}

async function stillInRoom(room: string, identity: string): Promise<boolean> {
  try {
    await getRoomServiceClient().getParticipant(room, identity);
    return true;
  } catch {
    // 404 (gone) — or the room service failed: record the departure.
    return false;
  }
}

/** The deduplicated `voice.block_enforced` row; never throws. */
async function auditBlockEnforced(
  scope: { serverId: string; channelId: string },
  room: string,
  identity: string,
  retryAfterSeconds: number
): Promise<void> {
  let claimed: boolean;
  try {
    claimed = await claimVoiceBlockEnforcedAudit(scope.serverId, identity);
  } catch {
    return; // Redis unavailable: skip the row silently.
  }
  if (!claimed) return;
  try {
    await logAction(getDb(), {
      serverId: scope.serverId,
      actorUserId: null,
      action: 'voice.block_enforced',
      targetType: 'user',
      targetId: identity,
      metadata: { channelId: scope.channelId, room, retryAfterSeconds },
    });
  } catch (err) {
    console.error('[audit] voice block enforcement failed:', (err as Error).message);
  }
}

/**
 * Remove `identity` from every OTHER live room of the server. Room names
 * are `s_<serverHex>_c_<channelHex>` (`liveKitRoomName`), so the server's
 * rooms share a prefix. Errors are logged, never thrown: the offending
 * room was already handled, and `participant_joined` catches any
 * connection this misses when it reconnects.
 */
async function removeFromOtherServerRooms(serverId: string, handledRoom: string, identity: string): Promise<void> {
  const prefix = `s_${serverId.replaceAll('-', '').toLowerCase()}_c_`;
  const lk = getRoomServiceClient();
  let rooms: Array<{ name: string }>;
  try {
    rooms = await lk.listRooms();
  } catch (err) {
    console.error('[livekit/webhook] listRooms failed:', (err as Error).message);
    return;
  }
  for (const { name } of rooms) {
    if (name === handledRoom || !name.toLowerCase().startsWith(prefix)) continue;
    try {
      await lk.removeParticipant(name, identity);
    } catch (err) {
      if (!isNotFound(err)) console.error('[livekit/webhook] removeParticipant failed:', (err as Error).message);
    }
  }
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
