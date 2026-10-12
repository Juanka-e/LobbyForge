/**
 * When an open activity panel should re-read the session next (client-safe).
 *
 * Two things happen on the server LAZILY, when somebody touches the
 * session: hosting moves when the host has left the voice room long enough
 * (lib/activity-host.ts), and the plugin's timers fire when they fall due
 * (lib/activity-timers.ts). So that both happen even when nobody acts, an
 * open panel re-reads the session once at the earliest moment something is
 * due — one timer, re-armed after every read, never a polling loop.
 *
 * The session GET reports `host` (games played over voice), `timersDueAt`
 * (ISO due times of the pending plugin timers; never what they do) and
 * `now`, the server's clock: the panel counts from the server's clock, so
 * a device whose clock runs early does not re-read before the server
 * thinks anything is due.
 */
import { hostDueTimes, pickNextCheck, type ActivityHostState } from './activity-host-view';

export interface ActivityCheckInput {
  host?: ActivityHostState | null;
  /** ISO due times of the plugin's pending timers. */
  timersDueAt?: readonly string[] | null;
}

/** `activity.timersDueAt` read defensively: valid ISO strings only. */
export function parseTimersDueAt(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((at): at is string => typeof at === 'string' && !Number.isNaN(Date.parse(at))).slice(0, 16);
}

/**
 * The server's clock minus this device's, from a response's `now` (ISO)
 * read at `receivedAt` (this device's ms); 0 when the response has none.
 */
export function serverClockOffset(serverNow: unknown, receivedAt: number): number {
  if (typeof serverNow !== 'string') return 0;
  const at = Date.parse(serverNow);
  return Number.isFinite(at) ? at - receivedAt : 0;
}

/**
 * When to re-read next, or null for "nothing is due": the earliest of the
 * host's due times and the plugin's timers. `now` is the server's clock as
 * this device estimates it; `firedFor` is the due time the last re-read was
 * for (see `pickNextCheck`: a time that is still pending after its re-read
 * is left to the next touch, not retried in a loop).
 */
export function nextActivityCheck(
  input: ActivityCheckInput,
  now: number,
  firedFor: number | null = null
): { at: number; delay: number } | null {
  const timers = parseTimersDueAt(input.timersDueAt).map((at) => Date.parse(at));
  return pickNextCheck([...hostDueTimes(input.host), ...timers], now, firedFor);
}
