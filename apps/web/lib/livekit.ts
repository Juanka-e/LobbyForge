/**
 * LiveKit access token issuance for the web app.
 *
 * A LiveKit token is a JWT signed with the LiveKit API secret (HS256). The
 * payload includes a `video` claim that lists the room-specific grants. We
 * use `jose` for the signing — the full `livekit-server-sdk` package would
 * pull in protobufjs and other things we don't need for the read path.
 *
 * The token format follows the LiveKit spec: https://docs.livekit.io/home/get-started/authentication/
 */
import { SignJWT } from 'jose';
import { RoomServiceClient } from 'livekit-server-sdk';

export const LIVEKIT_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

type LiveKitPublishSource = 'camera' | 'microphone' | 'screen-share' | 'screen-share-audio';
type LiveKitWirePublishSource = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio';

function toWirePublishSource(source: LiveKitPublishSource): LiveKitWirePublishSource {
  if (source === 'screen-share') return 'screen_share';
  if (source === 'screen-share-audio') return 'screen_share_audio';
  return source;
}

export interface LiveKitGrants {
  /** Room the user is joining. Required for room-scoped tokens. */
  room: string;
  /** Allow joining the room. Default true. */
  roomJoin?: boolean;
  /** Allow publishing tracks (mic, cam, screen). Default true. */
  canPublish?: boolean;
  /** Allow subscribing to other participants' tracks. Default true. */
  canSubscribe?: boolean;
  /** Allow publishing data messages (chat, reactions). Default true. */
  canPublishData?: boolean;
  /** Restrict publishing to a specific set of tracks. */
  canPublishSources?: LiveKitPublishSource[];
  /** Allow muting other participants. Requires server-side permission too. */
  canUpdateOwnMetadata?: boolean;
  /** Restrict subscription to a specific set of tracks. */
  canSubscribeSources?: LiveKitPublishSource[];
  /** Hidden from the room's participant list. */
  hidden?: boolean;
  /** Recorder role (used for egress bots). */
  recorder?: boolean;
}

export interface IssueLiveKitTokenInput {
  apiKey: string;
  apiSecret: string;
  /** Stable per-user identity — matches the cookie's gid for guests. */
  identity: string;
  /** Display name shown in the LiveKit participant list. */
  name: string;
  grants: LiveKitGrants;
  ttlSeconds?: number;
  /** Optional metadata blob surfaced to other participants. */
  metadata?: string;
  /** Override `now` for testability. */
  now?: number;
}

/**
 * Issue a signed LiveKit access token. Throws on missing credentials.
 *
 * The `identity` MUST be unique per user (we use the guest session's `gid`).
 * Reusing an identity across multiple browser tabs is fine; LiveKit treats
 * them as a single participant.
 */
export async function issueLiveKitToken(input: IssueLiveKitTokenInput): Promise<string> {
  if (!input.apiKey) throw new Error('issueLiveKitToken: apiKey is required');
  if (!input.apiSecret) throw new Error('issueLiveKitToken: apiSecret is required');
  if (!input.identity) throw new Error('issueLiveKitToken: identity is required');
  if (!input.grants.room) throw new Error('issueLiveKitToken: grants.room is required');

  const ttl = input.ttlSeconds ?? LIVEKIT_TOKEN_TTL_SECONDS;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const exp = now + ttl;
  const secretBytes = new TextEncoder().encode(input.apiSecret);

  const grants: Record<string, unknown> = {
    room: input.grants.room,
    roomJoin: input.grants.roomJoin ?? true,
    canPublish: input.grants.canPublish ?? true,
    canSubscribe: input.grants.canSubscribe ?? true,
    canPublishData: input.grants.canPublishData ?? true,
  };
  if (input.grants.canPublishSources) {
    grants.canPublishSources = input.grants.canPublishSources.map(toWirePublishSource);
  }
  if (input.grants.canSubscribeSources) {
    grants.canSubscribeSources = input.grants.canSubscribeSources.map(toWirePublishSource);
  }
  if (input.grants.hidden) grants.hidden = true;
  if (input.grants.recorder) grants.recorder = true;

  const jwt = await new SignJWT({ video: grants, ...(input.metadata ? { metadata: input.metadata } : {}) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(input.apiKey)
    .setSubject(input.identity)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretBytes);
  return jwt;
}

/**
 * Parse the LiveKit API credentials out of the environment, with a
 * descriptive error if either is missing. The web app refuses to serve
 * tokens when these are not set — it's a server-side config problem, not
 * a user-facing one.
 */
export function requireLiveKitCredentials(env: Record<string, string | undefined> = process.env): {
  apiKey: string;
  apiSecret: string;
} {
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('requireLiveKitCredentials: LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
  }
  return { apiKey, apiSecret };
}

/**
 * Get a singleton RoomServiceClient instance for server-side management.
 */
export function getRoomServiceClient(): RoomServiceClient {
  const { apiKey, apiSecret } = requireLiveKitCredentials();
  const host = process.env.LIVEKIT_URL || 'http://localhost:7880';
  // Standard singleton pattern using globalThis
  const global = globalThis as typeof globalThis & {
    __livekit_room_service_client__?: RoomServiceClient;
  };
  if (!global.__livekit_room_service_client__) {
    global.__livekit_room_service_client__ = new RoomServiceClient(host, apiKey, apiSecret);
  }
  return global.__livekit_room_service_client__;
}
