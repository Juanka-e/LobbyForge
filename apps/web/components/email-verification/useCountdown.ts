'use client';

import { useEffect, useState } from 'react';
import { secondsUntil } from './email-status';

/**
 * Seconds left until `iso`, ticking once a second while it is in the
 * future. The first render (on the server and during hydration) answers
 * `null` — the clock differs between the two, and a countdown that
 * disagreed with the server's HTML would be a hydration mismatch.
 */
export function useCountdown(iso: string | null): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (!iso || secondsUntil(iso) <= 0) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (secondsUntil(iso, current) <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [iso]);

  return now === null ? null : secondsUntil(iso, now);
}
