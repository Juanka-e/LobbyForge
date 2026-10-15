import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False while the server renders and during hydration, true afterwards.
 * For text that depends on the browser — its time zone, its locale data —
 * and would otherwise differ from the server's (a hydration mismatch, or an
 * attribute React never corrects): render it only once this is true.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}
