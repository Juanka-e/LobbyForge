/**
 * Who is in an activity's voice room, and since when someone has been out
 * of it.
 *
 * PRESENCE comes from LiveKit (`RoomServiceClient.listParticipants`), the
 * authority on who is connected: the Redis presence keys are written by
 * the browser's heartbeat (any visible channel id, a 90 s TTL), so they lag
 * a departure by up to a minute and a half and say whatever the client
 * claims. A LiveKit identity is the user id (`/api/livekit/token`); only
 * ordinary participants count — no egress/ingress/agent/SIP connection and
 * no hidden (recorder) one.
 *
 * ABSENCE ("out of the room since …") is a small Redis ledger keyed by
 * (room, user): the LiveKit webhook writes the time of a `participant_left`
 * and deletes it on `participant_joined`; a lazy reader that finds someone
 * absent with no entry starts the clock at that first sighting (SET NX).
 * So the clock is exact when the webhook is configured and never starts
 * early when it is not. A reader that sees the user present deletes the
 * entry.
 *
 * Failure modes, on purpose:
 *  - LiveKit unreachable or not configured → `available: false`. Callers
 *    FAIL OPEN (the voice requirement is a game rule, not a security
 *    boundary, and an outage must not freeze every game) and log it.
 *  - Redis unreachable → the absence time is unknown (null): no host
 *    transfer and no abandonment happen until it is back (fail safe).
 */
import type { RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { liveKitRoomName } from './livekit-room';

export interface VoiceRoomParticipant {
  userId: string;
  /** When this connection joined the room (ms since epoch). */
  joinedAtMs: number;
}

export type VoiceRoomSnapshot =
  | { available: true; room: string; participants: VoiceRoomParticipant[] }
  | { available: false; room: string };

/** Does this plugin make its players be in the activity's voice room? */
export function pluginRequiresVoice(plugin: Pick<RegisteredGamePlugin, 'manifest'> | null | undefined): boolean {
  return plugin?.manifest.catalog?.requiresVoiceRoom === true;
}

export function isInVoice(snapshot: VoiceRoomSnapshot | null | undefined, userId: string | null | undefined): boolean {
  if (!snapshot || !snapshot.available || !userId) return false;
  return snapshot.participants.some((p) => p.userId === userId);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ParticipantInfo.Kind.STANDARD — a person, not egress/ingress/SIP/agent. */
const KIND_STANDARD = 0;
/** ParticipantInfo.State.DISCONNECTED. */
const STATE_DISCONNECTED = 3;

/** A burst of actions (8 players rolling at once) asks LiveKit once. */
const SNAPSHOT_TTL_MS = 2_000;
const SNAPSHOT_CACHE_MAX = 500;
const snapshots = new Map<string, { expiresAt: number; value: Promise<VoiceRoomSnapshot> }>();

let warnedUnavailable = 0;

function isNotFound(err: unknown): boolean {
  const { status, code } = (err ?? {}) as { status?: number; code?: string };
  return status === 404 || code === 'not_found';
}

function toMs(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

interface RawParticipant {
  identity?: string;
  kind?: number;
  state?: number;
  joinedAt?: bigint | number;
  joinedAtMs?: bigint | number;
  permission?: { hidden?: boolean } | null;
}

/** The people in a LiveKit room, oldest connection first. Exported for tests. */
export function participantsFromLiveKit(raw: readonly RawParticipant[]): VoiceRoomParticipant[] {
  const byUser = new Map<string, number>();
  for (const p of raw) {
    const userId = p.identity ?? '';
    if (!UUID_RE.test(userId)) continue; // a guest without an account, or a service identity
    if ((p.kind ?? KIND_STANDARD) !== KIND_STANDARD) continue;
    if (p.state === STATE_DISCONNECTED) continue;
    if (p.permission?.hidden) continue;
    const joinedAtMs = toMs(p.joinedAtMs) || toMs(p.joinedAt) * 1000;
    const seen = byUser.get(userId);
    if (seen === undefined || joinedAtMs < seen) byUser.set(userId, joinedAtMs);
  }
  return [...byUser.entries()]
    .map(([userId, joinedAtMs]) => ({ userId, joinedAtMs }))
    .sort((a, b) => a.joinedAtMs - b.joinedAtMs || a.userId.localeCompare(b.userId));
}

async function loadSnapshot(room: string): Promise<VoiceRoomSnapshot> {
  try {
    const { getRoomServiceClient } = await import('./livekit');
    const raw = (await getRoomServiceClient().listParticipants(room)) as unknown as RawParticipant[];
    return { available: true, room, participants: participantsFromLiveKit(raw) };
  } catch (err) {
    // No such room yet: nobody has joined it.
    if (isNotFound(err)) return { available: true, room, participants: [] };
    const now = Date.now();
    if (now - warnedUnavailable > 60_000) {
      warnedUnavailable = now;
      console.warn('[activity-voice] LiveKit room service unavailable — voice checks skipped:', (err as Error)?.message);
    }
    return { available: false, room };
  }
}

/** Who is in the activity's voice room right now (cached for 2 s per process). */
export function getVoiceRoomSnapshot(serverId: string, channelId: string): Promise<VoiceRoomSnapshot> {
  const room = liveKitRoomName(serverId, channelId);
  const now = Date.now();
  const hit = snapshots.get(room);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) snapshots.delete(room);
  while (snapshots.size >= SNAPSHOT_CACHE_MAX) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  const value = loadSnapshot(room);
  snapshots.set(room, { expiresAt: now + SNAPSHOT_TTL_MS, value });
  return value;
}

/** Drop the cached snapshot of a room (the webhook calls it on join/leave). */
export function forgetVoiceRoomSnapshot(room: string): void {
  snapshots.delete(room);
}

// ── the absence ledger ─────────────────────────────────────────────────

/** Long enough for any grace period; an absence older than this restarts at the next sighting. */
const AWAY_TTL_SECONDS = 6 * 60 * 60;

function envPrefix(): string {
  return process.env.NODE_ENV || 'dev';
}

export function voiceAwayKey(room: string, userId: string): string {
  return `lf:${envPrefix()}:voice-away:${room}:${userId}`;
}

let redisModule: Promise<typeof import('./redis')> | null = null;
async function redisClient() {
  redisModule ??= import('./redis');
  return (await redisModule).redis;
}

/** LiveKit said `participant_left` at `at` (and the user has no other connection in the room). */
export async function recordVoiceLeft(room: string, userId: string, at: number = Date.now()): Promise<void> {
  const redis = await redisClient();
  await redis.set(voiceAwayKey(room, userId), String(at), 'EX', AWAY_TTL_SECONDS);
}

/** LiveKit said `participant_joined`: the user is back. */
export async function recordVoiceJoined(room: string, userId: string): Promise<void> {
  const redis = await redisClient();
  await redis.del(voiceAwayKey(room, userId));
}

/**
 * Since when (ms) `userId` has been out of `room`, as seen now: null when
 * they are present (the entry is cleared) or when Redis cannot answer;
 * otherwise the webhook's leave time, or `now` on a first sighting.
 */
export async function observeVoiceAbsence(
  room: string,
  userId: string,
  present: boolean,
  now: number = Date.now()
): Promise<number | null> {
  try {
    const redis = await redisClient();
    const key = voiceAwayKey(room, userId);
    if (present) {
      await redis.del(key);
      return null;
    }
    const results = await redis.pipeline().set(key, String(now), 'EX', AWAY_TTL_SECONDS, 'NX').get(key).exec();
    const [err, value] = results?.[1] ?? [new Error('no reply'), null];
    if (err) throw err;
    const since = Number(value);
    return Number.isFinite(since) && since > 0 ? Math.min(since, now) : now;
  } catch (err) {
    console.warn('[activity-voice] absence ledger unavailable:', (err as Error)?.message);
    return null;
  }
}

/** Test-only. */
export function __resetActivityVoice(): void {
  snapshots.clear();
  warnedUnavailable = 0;
}
