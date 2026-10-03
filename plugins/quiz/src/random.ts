/**
 * Randomness for the question order and each question's option order.
 *
 * `Math.random` is a fast PRNG whose internal state can be recovered from
 * a handful of outputs, after which every later shuffle is predictable —
 * with the built-in packs public in the repo, a player who watched a few
 * questions could work out where the correct answer lands next. Quiz draws
 * from the platform CSPRNG instead, like Hushle, Dice Bot and Vampire
 * Village. Tests still pass their own `random` through `QuizEnv`.
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
