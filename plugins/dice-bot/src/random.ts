/**
 * Randomness for rolls.
 *
 * `Math.random` is a fast PRNG whose internal state can be recovered from
 * a handful of outputs, after which every later roll is predictable — the
 * roll log hands anyone in the room those outputs. Rolls come from the
 * platform CSPRNG instead, the same helper Vampire Village uses
 * (`plugins/vampire-village/src/reducer.ts`).
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
