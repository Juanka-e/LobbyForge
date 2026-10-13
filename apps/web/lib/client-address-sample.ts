/**
 * security-review INFRA-V-01: the last client addresses the app resolved
 * from its trusted proxy header, kept so Doctor can tell whether they are
 * real visitors or one Docker bridge gateway.
 *
 * Behind Docker's userland proxy (the default, with no IPv6 on the bridge)
 * nginx sees every IPv6 client — or every client — as the bridge gateway,
 * so they all share one per-address rate-limit bucket. The app cannot see
 * that from one request; a small sample of recent addresses shows it.
 *
 * A fixed ring of the last {@link SAMPLE_SIZE} resolutions in this process
 * (on `globalThis`, so every route chunk shares it). In memory only, never
 * persisted or logged; Doctor reads a summary of it.
 */

export const SAMPLE_SIZE = 256;

interface Sample {
  addresses: string[];
  next: number;
}

const SAMPLE_KEY = '__lobbyforgeClientAddressSample__';

function sample(): Sample {
  const g = globalThis as unknown as Record<string, Sample | undefined>;
  let current = g[SAMPLE_KEY];
  if (!current) {
    current = { addresses: [], next: 0 };
    g[SAMPLE_KEY] = current;
  }
  return current;
}

/** Record one resolved client address (never 'unknown'). */
export function noteClientAddress(address: string): void {
  if (!address || address === 'unknown') return;
  const current = sample();
  current.addresses[current.next] = address;
  current.next = (current.next + 1) % SAMPLE_SIZE;
}

/** The sampled addresses, oldest first. */
export function recentClientAddresses(): string[] {
  const { addresses, next } = sample();
  if (addresses.length < SAMPLE_SIZE) return [...addresses];
  return [...addresses.slice(next), ...addresses.slice(0, next)];
}

/** Test-only. */
export function __resetClientAddressSample(): void {
  const current = sample();
  current.addresses = [];
  current.next = 0;
}
