/**
 * Randomness for card draws, team ids and the room split.
 *
 * `Math.random` is a fast PRNG whose internal state can be recovered from
 * a handful of outputs, after which every later draw is predictable — a
 * player who can see which cards came up could work out the next ones.
 * Hushle draws from the platform CSPRNG instead, the same helper Vampire
 * Village uses (`plugins/vampire-village/src/reducer.ts`). Callers that
 * need a fixed sequence (tests) still pass their own `rng`.
 */

/** A float in [0, 1) from the platform CSPRNG, or Math.random where there is none. */
export function secureRandom(): number {
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array } }).crypto;
  if (cryptoApi?.getRandomValues) {
    const buffer = new Uint32Array(1);
    cryptoApi.getRandomValues(buffer);
    return buffer[0]! / 0x1_0000_0000;
  }
  return Math.random();
}
