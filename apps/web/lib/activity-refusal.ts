/**
 * Activity refusals, in the reader's language (client-safe).
 *
 * The activity routes answer a refusal with `{ error, code, ...extra }`
 * (`lib/activity-errors.ts` builds them on the server): `error` is the
 * server's English sentence, `code` the machine reason. The UI shows a
 * sentence picked by `code` and never the English `error` — the same rule
 * the slash command composer follows (`invokeErrorKey` in
 * `lib/bots/client-api.ts`).
 *
 * Codes shared with the slash command routes:
 *   session_ended    the activity is over
 *   not_host         only the host may do that
 *   voice_required   join the voice channel first
 *   activity_exists  one is already running in this channel (`sessionId`)
 *   rate_limited     too many requests; wait a moment
 *   bot_offline      the bot behind it is offline
 * Activity-only codes: wrong_phase, not_player, and the start route's
 * app allow-list codes. Anything else falls back to a translated generic
 * sentence chosen by HTTP status.
 */

export const SHARED_REFUSAL_CODES = [
  'session_ended',
  'not_host',
  'voice_required',
  'activity_exists',
  'rate_limited',
  'bot_offline',
] as const;

export type SharedRefusalCode = (typeof SHARED_REFUSAL_CODES)[number];

export interface ActivityRefusal {
  /** HTTP status; 0 when the request never reached the server. */
  status: number;
  code: string | null;
  /** For `activity_exists`: the session already running in the channel. */
  sessionId: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Read a refusal body defensively. `sessionId` is taken from the body, or
 * from the legacy `{ activity: { id } }` conflict shape.
 */
export function parseActivityRefusal(status: number, body: unknown): ActivityRefusal {
  const data = record(body);
  return {
    status,
    code: str(data.code),
    sessionId: str(data.sessionId) ?? str(record(data.activity).id),
  };
}

/** Message keys per shared code; the slash composer reuses them. */
export const SHARED_REFUSAL_KEYS: Record<SharedRefusalCode, string> = {
  session_ended: 'room.activity.error.sessionEnded',
  not_host: 'room.activity.error.notHost',
  voice_required: 'room.activity.error.voiceRequired',
  activity_exists: 'room.activity.error.activityExists',
  rate_limited: 'room.activity.error.rateLimited',
  bot_offline: 'room.activity.error.botOffline',
};

const ACTIVITY_ONLY_KEYS: Record<string, string> = {
  wrong_phase: 'room.activity.error.wrongPhase',
  not_player: 'room.activity.error.notPlayer',
  app_channel_not_allowed: 'lobbyMain.activities.channelNotAllowed',
  app_role_not_allowed: 'lobbyMain.activities.roleNotAllowed',
  network: 'room.activity.error.network',
};

export function isSharedRefusalCode(code: string | null | undefined): code is SharedRefusalCode {
  return typeof code === 'string' && (SHARED_REFUSAL_CODES as readonly string[]).includes(code);
}

export interface RefusalMessage {
  key: string;
  params?: Record<string, string | number>;
}

/**
 * The sentence that explains `refusal`, as a catalogue key (resolve it
 * with `t(key, params)`). `during` is what was attempted: a 404 from the
 * start route is not an ended session.
 */
export function activityRefusalMessage(
  refusal: Pick<ActivityRefusal, 'status' | 'code'>,
  during: 'start' | 'session' = 'session'
): RefusalMessage {
  if (isSharedRefusalCode(refusal.code)) return { key: SHARED_REFUSAL_KEYS[refusal.code] };
  const known = refusal.code ? ACTIVITY_ONLY_KEYS[refusal.code] : undefined;
  if (known) return { key: known };
  if (refusal.status === 0) return { key: 'room.activity.error.network' };
  if (refusal.status === 401) return { key: 'room.activity.error.signIn' };
  if (refusal.status === 403) return { key: 'room.activity.error.forbidden' };
  if (refusal.status === 404 && during === 'session') return { key: 'room.activity.error.sessionEnded' };
  if (refusal.status === 429) return { key: 'room.activity.error.rateLimited' };
  return { key: 'room.activity.error.generic', params: { status: refusal.status } };
}
