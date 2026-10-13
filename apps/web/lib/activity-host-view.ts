/**
 * The activity host's presence, as the session GET reports it (client-safe).
 *
 * For a game played over voice, hosting moves when the host has been out
 * of the voice room long enough, and the session becomes "abandoned" (any
 * voice participant may end it) a little later (lib/activity-host.ts). The
 * server decides LAZILY, when somebody touches the session. So that the
 * hand-over happens without anyone acting, an open panel re-reads the
 * session once at the earliest moment something is due — one timer,
 * re-armed after every read, never a polling loop.
 */

export interface ActivityHostState {
  /** The current host (after any transfer the read made). */
  userId: string | null;
  /** The host is in the activity's voice room. */
  inVoice: boolean;
  /** ISO time the host left the room; null while present or unknown. */
  awaySince: string | null;
  /** ISO time hosting moves; null while present or nobody can take over. */
  transferAt: string | null;
  /** ISO time any voice participant may end the session; null while present. */
  abandonAt: string | null;
  /** Any voice participant may end the session now. */
  abandoned: boolean;
}

/** Added to the due time: the server's clock and the read itself take a moment. */
export const HOST_CHECK_MARGIN_MS = 1_500;
/** The first wait before re-reading again for a due time that stayed pending after its re-read. */
export const CHECK_BACKOFF_BASE_MS = 2_000;
/** The longest such wait: a stuck due time costs each open panel one read a minute at most. */
export const CHECK_BACKOFF_MAX_MS = 60_000;

/**
 * How many times the panel already re-read for each due time (epoch ms →
 * re-reads). `recordCheck` keeps it; `pickNextCheck` reads it.
 */
export type CheckHistory = ReadonlyMap<number, number>;

/** The wait before re-reading for a past due time already re-read for `attempts` times: 0, then 2 s doubling to 60 s. */
export function checkBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(CHECK_BACKOFF_MAX_MS, CHECK_BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

/**
 * The history after a re-read made at `now`: every due time in `times`
 * that had passed counts one more re-read (one read fires everything that
 * is due, so it was a re-read for all of them); times no longer pending
 * are forgotten, so the history stays as small as the list.
 */
export function recordCheck(history: CheckHistory | null, times: readonly number[], now: number): Map<number, number> {
  const next = new Map<number, number>();
  for (const at of new Set(times)) {
    const attempts = history?.get(at) ?? 0;
    next.set(at, at <= now ? attempts + 1 : attempts);
  }
  return next;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** Read `activity.host` defensively; null when the session has none (plugins that do not need voice). */
export function parseActivityHost(value: unknown): ActivityHostState | null {
  const raw = record(value);
  if (!raw) return null;
  return {
    userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : null,
    inVoice: raw.inVoice === true,
    awaySince: isoOrNull(raw.awaySince),
    transferAt: isoOrNull(raw.transferAt),
    abandonAt: isoOrNull(raw.abandonAt),
    abandoned: raw.abandoned === true,
  };
}

/** The host's due times: `transferAt` and, until the session is abandoned, `abandonAt` (ms). */
export function hostDueTimes(host: ActivityHostState | null | undefined): number[] {
  if (!host || host.inVoice) return [];
  const times: number[] = [];
  const transferAt = host.transferAt ? Date.parse(host.transferAt) : Number.NaN;
  if (Number.isFinite(transferAt)) times.push(transferAt);
  const abandonAt = host.abandonAt ? Date.parse(host.abandonAt) : Number.NaN;
  if (!host.abandoned && Number.isFinite(abandonAt)) times.push(abandonAt);
  return times;
}

/**
 * The due time to re-read for next and how long to wait, or null when
 * nothing is pending. A future time is re-read for just after it falls
 * due. A time already in the past gets one immediate re-read; if it is
 * still pending after that (the server could not act on it yet — a busy
 * lock, a catch-up that continues on the next touch, a removed app), the
 * next re-read for it backs off: 2 s, 4 s, 8 s … up to 60 s
 * (`checkBackoffMs`, counted in `history` by `recordCheck`). That is what
 * keeps stuck due times — even several, which the old single "fired for"
 * time let alternate forever — from turning into a re-read loop.
 */
export function pickNextCheck(
  times: readonly number[],
  now: number,
  history: CheckHistory | null = null
): { at: number; delay: number } | null {
  let best: { at: number; delay: number } | null = null;
  for (const at of times) {
    const wait = at > now ? at - now : checkBackoffMs(history?.get(at) ?? 0);
    const delay = wait + HOST_CHECK_MARGIN_MS;
    if (!best || delay < best.delay || (delay === best.delay && at < best.at)) best = { at, delay };
  }
  return best;
}

/**
 * When to re-read the session next for the host alone, or null for
 * "nothing is due" (`transferAt`, and `abandonAt` until abandoned). The
 * panel uses `nextActivityCheck` (lib/activity-next-check.ts), which adds
 * the plugin's timers.
 */
export function nextHostCheck(
  host: ActivityHostState | null | undefined,
  now: number,
  history: CheckHistory | null = null
): { at: number; delay: number } | null {
  return pickNextCheck(hostDueTimes(host), now, history);
}
