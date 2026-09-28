/**
 * "Last activity" bookkeeping for bots, cheap enough for every request.
 *
 * `touchBotLastUsed` is already throttled in SQL (it only writes when the
 * stored value is a minute old), but it still costs a statement. This
 * in-process gate skips the statement entirely when this process touched
 * the same bot less than a minute ago, so a busy bot costs about one
 * UPDATE per minute per web worker instead of one per request.
 */
import { touchBotLastUsed } from '@lobbyforge/db';
import { getDb } from '@/lib/db';

const MIN_INTERVAL_MS = 60_000;
const MAX_TRACKED = 5_000;
const lastTouched = new Map<string, number>();

export function noteBotActivity(botId: string, now: number = Date.now()): void {
  const previous = lastTouched.get(botId);
  if (previous !== undefined && now - previous < MIN_INTERVAL_MS) return;
  if (previous === undefined && lastTouched.size >= MAX_TRACKED) {
    const oldest = lastTouched.keys().next().value;
    if (oldest !== undefined) lastTouched.delete(oldest);
  }
  lastTouched.set(botId, now);
  void touchBotLastUsed(getDb(), botId, new Date(now), MIN_INTERVAL_MS).catch(() => undefined);
}

/** Test-only. */
export function __resetBotActivity(): void {
  lastTouched.clear();
}
