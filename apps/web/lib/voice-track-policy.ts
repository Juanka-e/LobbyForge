/**
 * security-review AUTHZ-006 follow-up: a voice track's KIND must match
 * its SOURCE.
 *
 * LiveKit checks the source a new track claims against the token's
 * canPublishSources — and nothing else. It never checks that a Camera
 * track is video. A server-muted member keeps camera and screen share
 * (the mute is about sound, see buildAllowedPublishSources), so a
 * modified client published its microphone as `source: camera` and the
 * whole room heard it. The same hole let a role with STREAM but no SPEAK
 * talk, and in reverse let video ride the Microphone source.
 *
 * The rule, shared by the browser (listeners never subscribe to or play
 * a mislabelled track) and the LiveKit webhook (the server removes the
 * participant that published one):
 *
 *   audio  ⇔  microphone | screen_share_audio
 *   video  ⇔  camera     | screen_share
 *
 * Anything else — an unknown kind or source, a data track, a mime type
 * that disagrees with the declared kind — is not allowed.
 *
 * Pure and dependency-free on purpose: the browser bundle imports it, so
 * it must not pull in livekit-server-sdk (or livekit-client).
 */

const AUDIO_SOURCES = new Set(['microphone', 'screen_share_audio']);
const VIDEO_SOURCES = new Set(['camera', 'screen_share']);

/** livekit-client spells sources `screen_share`; the app's grants use `screen-share`. */
function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/-/g, '_') : '';
}

/**
 * True when a track of `kind` ('audio' | 'video') may carry `source`
 * ('microphone', 'camera', 'screen_share', 'screen_share_audio'; the
 * hyphenated grant spelling and upper case are accepted too).
 */
export function isTrackKindAllowedForSource(kind: unknown, source: unknown): boolean {
  const k = normalize(kind);
  const s = normalize(source);
  if (k === 'audio') return AUDIO_SOURCES.has(s);
  if (k === 'video') return VIDEO_SOURCES.has(s);
  return false;
}

/** The parts of a livekit-client publication (and its track) the rule reads. */
export interface RemotePublicationLike {
  kind: unknown;
  source: unknown;
  mimeType?: string;
  track?: { kind: unknown } | null;
}

/**
 * Client-side check for a remote publication: its declared kind, the kind
 * of the media that actually arrived (once subscribed) and its mime type
 * must all agree with the source. Used at every remote-track entry point
 * (TrackPublished, TrackSubscribed, the initial pass over participants
 * already in the room, opting into a screen share).
 */
export function isRemotePublicationAllowed(publication: RemotePublicationLike, track?: { kind: unknown } | null): boolean {
  if (!isTrackKindAllowedForSource(publication.kind, publication.source)) return false;
  if (!mimeTypeAgrees(publication.mimeType, publication.kind)) return false;
  const media = track ?? publication.track;
  if (media && normalize(media.kind) !== normalize(publication.kind)) return false;
  return true;
}

/**
 * True when at least one of the publications is real audio (microphone or
 * screen-share audio). LiveKit's speaking indicator is computed from every
 * AUDIO track, mislabelled ones included, so a remote participant only
 * shows as speaking when they publish audio under an audio source.
 */
export function hasAllowedAudioPublication(publications: Iterable<RemotePublicationLike>): boolean {
  for (const publication of publications) {
    if (normalize(publication.kind) === 'audio' && isRemotePublicationAllowed(publication)) return true;
  }
  return false;
}

function mimeTypeAgrees(mimeType: string | undefined, kind: unknown): boolean {
  if (!mimeType) return true; // not negotiated yet — the kind check stands alone
  const prefix = mimeType.trim().toLowerCase().split('/')[0];
  if (prefix !== 'audio' && prefix !== 'video') return true; // not a media mime we can judge
  return prefix === normalize(kind);
}

// ── Server side: LiveKit protocol TrackInfo (webhook payload) ─────────────

/** livekit.TrackType (protocol enum values; stable on the wire). */
const PROTO_TRACK_TYPE: Record<number, string> = { 0: 'audio', 1: 'video', 2: 'data' };
/** livekit.TrackSource (protocol enum values; stable on the wire). */
const PROTO_TRACK_SOURCE: Record<number, string> = {
  0: 'unknown',
  1: 'camera',
  2: 'microphone',
  3: 'screen_share',
  4: 'screen_share_audio',
};

/** The TrackInfo fields the server-side rule reads (numeric enums, as decoded by livekit-server-sdk). */
export interface ProtoTrackInfoLike {
  type?: number;
  source?: number;
  mimeType?: string;
}

/** 'audio' | 'video' | 'data' | 'unknown' for a TrackInfo.type value. */
export function protoTrackKind(type: number | undefined): string {
  // protojson omits zero values: a missing type IS AUDIO (0).
  return PROTO_TRACK_TYPE[type ?? 0] ?? 'unknown';
}

/** 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio' | 'unknown'. */
export function protoTrackSource(source: number | undefined): string {
  // protojson omits zero values: a missing source IS UNKNOWN (0).
  return PROTO_TRACK_SOURCE[source ?? 0] ?? 'unknown';
}

/**
 * Server-side check for a published TrackInfo (LiveKit webhook): the
 * declared type must match the source, and a negotiated mime type must not
 * contradict the type.
 */
export function isTrackInfoAllowed(track: ProtoTrackInfoLike): boolean {
  const kind = protoTrackKind(track.type);
  return isTrackKindAllowedForSource(kind, protoTrackSource(track.source)) && mimeTypeAgrees(track.mimeType, kind);
}
