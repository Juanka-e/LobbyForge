/**
 * Machine codes on activity refusals (server side).
 *
 * Every refusal of the activity routes keeps its English `error` (older
 * clients show it) and carries a `code` the lobby translates:
 * `{ "error": "<english>", "code": "<code>", ...extra }`. The status codes
 * are unchanged; the code says which of several refusals sharing a status
 * this one is. The client side (sentences per code) is
 * `lib/activity-refusal.ts`.
 *
 *   session_ended    an action on an ended activity (the row is ended, or
 *                    the game is over and the action is not a restart)
 *   not_host         a host-only action, or ending the activity, by someone
 *                    who is not its host
 *   voice_required   a player/member action from someone not in the
 *                    activity's voice room (plugins with requiresVoiceRoom)
 *   activity_exists  another activity is already open in the channel
 *                    (with `sessionId`)
 *   rate_limited     too many requests (lib/security-headers.ts adds it to
 *                    every 429)
 *   wrong_phase      the action does not fit the game's current phase
 *   not_player       a `player` action from someone not on the roster
 */
import { NextResponse } from 'next/server';

export type ActivityErrorCode =
  | 'session_ended'
  | 'not_host'
  | 'voice_required'
  | 'activity_exists'
  | 'rate_limited'
  | 'wrong_phase'
  | 'not_player';

export function activityError(
  status: number,
  code: ActivityErrorCode,
  error: string,
  extra: Record<string, unknown> = {}
): NextResponse {
  return NextResponse.json({ error, code, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
}
