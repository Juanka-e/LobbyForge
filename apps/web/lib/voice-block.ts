/**
 * Voice block list — security-review AUTHZ-006 follow-up.
 *
 * The LiveKit webhook (app/api/livekit/webhook) removes a participant who
 * publishes a track whose kind does not match its source
 * (lib/voice-track-policy.ts). LiveKit OSS `RemoveParticipant` does not
 * revoke tokens, so on its own a modified client could reconnect with the
 * token it still holds — or fetch a fresh one — and leak a moment of audio
 * to raw clients on every attempt. A removal therefore also BLOCKS the
 * member from voice for a while, enforced in two places:
 *
 *  - `/api/livekit/token` refuses a token (403 `voice_blocked` with
 *    `retryAfter` seconds);
 *  - the webhook removes a blocked identity on `participant_joined`, which
 *    covers a token minted before the block that is still valid.
 *
 * Scope is SERVER + user, not the channel: a removed abuser must not just
 * hop to another voice channel of the same server.
 *
 * Duration ladder: 10 min for a first offence, 30 min for the second,
 * 120 min (the cap) for every one after. The strike counter lives for the
 * block plus one hour, so an offence within an hour after the previous
 * block ENDS escalates, and an hour of good behaviour starts over at
 * 10 min. One LiveKit connection (participant SID, passed as `offenceId`)
 * counts once: a webhook redelivery, or several bad tracks published on
 * the same connection, must not escalate by themselves.
 *
 * Keys (no channel id — see the scope above):
 *   lf:{env}:voice-block:{serverId}:{userId}                    strike number, EX = block
 *   lf:{env}:voice-block-strikes:{serverId}:{userId}            INCR counter, EX = block + 1 h
 *   lf:{env}:voice-block-offence:{serverId}:{userId}:{offence}  '1' (SET NX), EX = 1 h
 *
 * Failure policy: every function here THROWS when Redis does; the caller
 * picks the direction. The token route fails CLOSED in production (a
 * retryable 503), exactly like session revocation — with Redis down,
 * `withApiSecurity` already answers 503 for every signed-in API call, so
 * this adds no new outage — and open in dev/test. The webhook fails OPEN
 * on its `participant_joined` check (the token route is the primary gate;
 * see the route for why it does not ask LiveKit to retry).
 */
import { parseLiveKitRoomName } from '@/lib/livekit-room';
import { redis } from '@/lib/redis';

/** Block length by strike: 10 min, 30 min, then 120 min for every later strike. */
export const VOICE_BLOCK_LADDER_SECONDS: readonly number[] = [10 * 60, 30 * 60, 120 * 60];

/** How long after a block ends a new offence still counts as a repeat. */
export const VOICE_BLOCK_STRIKE_WINDOW_SECONDS = 60 * 60;

/** A LiveKit room name the app minted, or the server (+ channel) it belongs to. */
export type VoiceBlockScope = string | { serverId: string; channelId?: string };

export interface VoiceBlockResult {
  serverId: string;
  /** Strike number this block counts as (1 = first offence in the window). */
  strike: number;
  /** Seconds until the block ends (never shorter than a block already in place). */
  seconds: number;
}

function envPrefix(): string {
  return `lf:${process.env.NODE_ENV || 'dev'}`;
}

/** The server a scope belongs to; null for a room name this app did not mint. */
export function voiceBlockServerId(scope: VoiceBlockScope): string | null {
  if (typeof scope === 'string') return parseLiveKitRoomName(scope)?.serverId ?? null;
  return scope.serverId || null;
}

export function voiceBlockKey(serverId: string, userId: string): string {
  return `${envPrefix()}:voice-block:${serverId}:${userId}`;
}

function strikesKey(serverId: string, userId: string): string {
  return `${envPrefix()}:voice-block-strikes:${serverId}:${userId}`;
}

function offenceKey(serverId: string, userId: string, offenceId: string): string {
  return `${envPrefix()}:voice-block-offence:${serverId}:${userId}:${offenceId}`;
}

/** Block length for the n-th strike (1-based); the last rung repeats. */
export function voiceBlockSecondsForStrike(strike: number): number {
  const index = Math.min(Math.max(Math.floor(strike), 1), VOICE_BLOCK_LADDER_SECONDS.length) - 1;
  return VOICE_BLOCK_LADDER_SECONDS[index]!;
}

/**
 * Block `userId` from voice on the scope's server. The length follows the
 * ladder unless `seconds` is given. `offenceId` (the LiveKit participant
 * SID) makes repeats of the same offence idempotent. Returns null — and
 * does nothing — for a room name this app did not mint.
 */
export async function blockVoice(
  scope: VoiceBlockScope,
  userId: string,
  options: { seconds?: number; offenceId?: string } = {}
): Promise<VoiceBlockResult | null> {
  const serverId = voiceBlockServerId(scope);
  if (!serverId || !userId) return null;

  const counted = options.offenceId
    ? (await redis.set(
        offenceKey(serverId, userId, options.offenceId),
        '1',
        'EX',
        VOICE_BLOCK_STRIKE_WINDOW_SECONDS,
        'NX'
      )) === 'OK'
    : true;
  const strike = counted
    ? await redis.incr(strikesKey(serverId, userId))
    : Math.max(1, Number(await redis.get(strikesKey(serverId, userId))) || 1);

  const requested = options.seconds !== undefined ? Math.max(1, Math.ceil(options.seconds)) : voiceBlockSecondsForStrike(strike);
  if (counted) {
    // Refreshed on every new offence, so the counter always ends one
    // window after the block it belongs to (and a counter left without a
    // TTL by a crash between the two commands gets one on the next offence).
    await redis.expire(strikesKey(serverId, userId), requested + VOICE_BLOCK_STRIKE_WINDOW_SECONDS);
  }

  const key = voiceBlockKey(serverId, userId);
  const remainingMs = await redis.pttl(key); // -2 missing, -1 no expiry
  if (remainingMs === -1) return { serverId, strike, seconds: requested }; // set by hand, never expires
  // A repeat of an offence already counted keeps the block it got (a
  // redelivery must not push the end back); a new offence or an explicit
  // length may only LENGTHEN a block, never shorten it.
  if (remainingMs > 0 && (!counted || remainingMs >= requested * 1000)) {
    return { serverId, strike, seconds: Math.ceil(remainingMs / 1000) };
  }
  await redis.set(key, String(strike), 'EX', requested);
  return { serverId, strike, seconds: requested };
}

/**
 * The block in force for `userId` on the scope's server, as seconds left
 * (rounded up), or null when there is none (or the room name is not one
 * this app minted).
 */
export async function getVoiceBlock(
  scope: VoiceBlockScope,
  userId: string
): Promise<{ retryAfterSeconds: number } | null> {
  const serverId = voiceBlockServerId(scope);
  if (!serverId || !userId) return null;
  const remainingMs = await redis.pttl(voiceBlockKey(serverId, userId));
  if (remainingMs === -2) return null;
  // -1 = a key without expiry (set by hand): blocked; report the first rung.
  if (remainingMs < 0) return { retryAfterSeconds: VOICE_BLOCK_LADDER_SECONDS[0]! };
  return { retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
}

/** Whether `userId` is blocked from voice on the scope's server right now. */
export async function isVoiceBlocked(scope: VoiceBlockScope, userId: string): Promise<boolean> {
  return (await getVoiceBlock(scope, userId)) !== null;
}
