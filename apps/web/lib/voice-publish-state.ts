/**
 * What a voice participant may still publish, read from their LiveKit
 * grant. Client-safe (no database, no livekit-server-sdk): the lobby voice
 * provider uses it for the local footer AND for everyone's roster, and the
 * token route uses `publishBlockedReason` to tell the client why.
 *
 * security-review AUTHZ-006 changed the grant shape: a timed-out member
 * (and a server-muted member on a server with camera and screen share
 * off) is sent `canPublish: false` with an EMPTY source list, because
 * LiveKit reads an empty `canPublishSources` as "every source". The old
 * client only looked for a non-empty list without the microphone, so it
 * treated that member as a normal speaker: it tried to open the mic (a
 * device error instead of the moderation notice), left the mic button
 * enabled, and other rosters did not show them muted. Every check now
 * starts from `canPublish`.
 */

/** Why the server withheld publishing (sent with the voice token). */
export type PublishBlockedReason = 'server_mute' | 'timeout';

/**
 * What the grant blocks:
 *  - `none`       — a normal member (the mic can be turned on);
 *  - `microphone` — sources exist but the mic is not one of them (server
 *                   mute, or a role without SPEAK);
 *  - `all`        — `canPublish: false`: nothing at all (timeout, or a
 *                   server mute with no camera / screen share to keep).
 */
export type PublishBlock = 'none' | 'microphone' | 'all';

/** livekit-client exposes permissions as protobuf enums: TrackSource.MICROPHONE. */
export const PROTO_SOURCE_MICROPHONE = 2;

/** The part of livekit-client's `ParticipantPermission` this module reads. */
export interface PublishPermissionsView {
  canPublish?: boolean;
  canPublishSources?: readonly number[];
}

export function publishBlockFromPermissions(
  permissions: PublishPermissionsView | null | undefined
): PublishBlock {
  if (!permissions) return 'none';
  if (permissions.canPublish === false) return 'all';
  const sources = permissions.canPublishSources;
  // An empty list next to canPublish:true is LiveKit's "no restriction".
  if (sources && sources.length > 0 && !sources.includes(PROTO_SOURCE_MICROPHONE)) {
    return 'microphone';
  }
  return 'none';
}

/** True when this participant cannot turn a microphone on (roster "muted"). */
export function isMicrophoneBlocked(permissions: PublishPermissionsView | null | undefined): boolean {
  return publishBlockFromPermissions(permissions) !== 'none';
}

/**
 * Server side: the reason the token route reports. A timeout wins over a
 * server mute because it blocks more (camera and screen share as well).
 */
export function publishBlockedReason(state: {
  timedOut: boolean;
  voiceMuted: boolean;
}): PublishBlockedReason | null {
  if (state.timedOut) return 'timeout';
  if (state.voiceMuted) return 'server_mute';
  return null;
}

/**
 * The block to apply right after joining: the live grant, raised to what
 * the token response said, so a grant that is not reported yet can never
 * send the client to `setMicrophoneEnabled(true)` for a blocked member.
 */
export function publishBlockAtJoin(
  tokenReason: PublishBlockedReason | null,
  permissions: PublishPermissionsView | null | undefined
): PublishBlock {
  const live = publishBlockFromPermissions(permissions);
  if (tokenReason === 'timeout') return 'all';
  if (tokenReason === 'server_mute' && live === 'none') return 'microphone';
  return live;
}

/**
 * Which copy to show for a block. Only the token says "timeout" for sure;
 * a grant that drops to `canPublish: false` mid-call cannot tell a timeout
 * from a server mute on a server with camera and screen share off, so
 * without that hint it falls back to the server-mute wording (true either
 * way: a moderator took the voice away) rather than promise a timeout
 * that "ends". A rejoin gets the exact reason from the token again.
 */
export function resolvePublishBlockReason(
  block: PublishBlock,
  joinReason: PublishBlockedReason | null
): PublishBlockedReason | null {
  if (block === 'none') return null;
  if (block === 'all' && joinReason === 'timeout') return 'timeout';
  return 'server_mute';
}
