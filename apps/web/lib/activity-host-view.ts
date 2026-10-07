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

/**
 * When to re-read the session next, or null for "nothing is due".
 *
 * The candidates are `transferAt` and, until the session is abandoned,
 * `abandonAt`. A due time already in the past gets one immediate re-read —
 * unless `firedFor` says a timer already re-read for exactly that time
 * (the server could not act on it yet: the next touch will), which is what
 * keeps a stuck transfer from turning into a loop.
 */
export function nextHostCheck(
  host: ActivityHostState | null | undefined,
  now: number,
  firedFor: number | null = null
): { at: number; delay: number } | null {
  if (!host || host.inVoice) return null;
  const times: number[] = [];
  const transferAt = host.transferAt ? Date.parse(host.transferAt) : Number.NaN;
  if (Number.isFinite(transferAt)) times.push(transferAt);
  const abandonAt = host.abandonAt ? Date.parse(host.abandonAt) : Number.NaN;
  if (!host.abandoned && Number.isFinite(abandonAt)) times.push(abandonAt);
  const due = times.filter((at) => at > now || at !== firedFor).sort((a, b) => a - b)[0];
  if (due === undefined) return null;
  return { at: due, delay: Math.max(0, due - now) + HOST_CHECK_MARGIN_MS };
}
