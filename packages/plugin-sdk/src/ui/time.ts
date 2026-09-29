import { useEffect, useState } from 'react';

/**
 * The current time, re-read every `intervalMs` — drives countdowns.
 * Timers in shared state should be DEADLINES (an ISO string or epoch ms the
 * server wrote), never "seconds left": every client then counts down to the
 * same moment, however late its last update arrived.
 */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Whole seconds from `now` until `deadline` (never negative), or null without one. */
export function secondsUntil(deadline: string | number | null | undefined, now: number): number | null {
  if (deadline == null) return null;
  const at = typeof deadline === 'number' ? deadline : Date.parse(deadline);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** `secondsUntil(deadline, now)` that ticks by itself. */
export function useSecondsLeft(deadline: string | number | null | undefined): number | null {
  const now = useNow(deadline == null ? 60_000 : 250);
  return secondsUntil(deadline, now);
}
