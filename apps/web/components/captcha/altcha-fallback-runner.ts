import { createSolver, type AltchaSolution, type AltchaV2Challenge } from './altcha-fallback-solver';

/** Same budget as the ALTCHA widget. */
export const SOLVE_TIMEOUT_MS = 90_000;

/**
 * Web Crypto — and with it ALTCHA's own widget — is only there in a secure
 * context (HTTPS or localhost). Without it, the challenge is solved by our
 * pure-JS fallback instead.
 */
export function hasWebCrypto(): boolean {
  return window.isSecureContext !== false && typeof globalThis.crypto?.subtle?.digest === 'function';
}

function workerCount(): number {
  return Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
}

/** The slow path when no worker can start: the main thread, yielding often enough to keep the page responsive. */
async function solveOnMainThread(
  challenge: AltchaV2Challenge,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<AltchaSolution | null> {
  const attempt = createSolver(challenge);
  const began = performance.now();
  let lastYield = began;
  for (let counter = 0; counter <= 0xffffffff; counter += 1) {
    if (signal?.aborted || performance.now() - began > timeoutMs) return null;
    const derivedKey = attempt(counter);
    if (derivedKey) return { counter, derivedKey, time: Math.round((performance.now() - began) * 10) / 10 };
    if (performance.now() - lastYield > 40) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  return null;
}

/**
 * Solve `challenge` with the pure-JS solver in a few workers, counters
 * interleaved between them (as the ALTCHA widget does). Null on timeout or
 * abort; rejects when the solver itself fails.
 */
export async function solveInBackground(
  challenge: AltchaV2Challenge,
  { signal, timeoutMs = SOLVE_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<AltchaSolution | null> {
  const pool: Worker[] = [];
  try {
    for (let i = 0; i < workerCount(); i += 1) {
      pool.push(new Worker(new URL('./altcha-fallback.worker.ts', import.meta.url)));
    }
  } catch {
    for (const worker of pool) worker.terminate();
    return solveOnMainThread(challenge, signal, timeoutMs);
  }

  return new Promise<AltchaSolution | null>((resolve, reject) => {
    let remaining = pool.length;
    let failures = 0;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      for (const worker of pool) worker.terminate();
      signal?.removeEventListener('abort', onAbort);
      outcome();
    };
    const onAbort = () => finish(() => resolve(null));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    const workerDone = (failed: boolean, error?: string) => {
      remaining -= 1;
      if (failed) failures += 1;
      if (remaining > 0) return;
      if (failures === pool.length) {
        // No worker could run at all (a blocked script, say): try the main thread.
        finish(() => void solveOnMainThread(challenge, signal, timeoutMs).then(resolve, reject));
      } else {
        finish(() => (error ? reject(new Error(error)) : resolve(null)));
      }
    };

    pool.forEach((worker, index) => {
      worker.onmessage = (event: MessageEvent<{ solution?: AltchaSolution | null; error?: string }>) => {
        const { solution, error } = event.data ?? {};
        if (solution) finish(() => resolve(solution));
        else workerDone(false, error);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        workerDone(true);
      };
      worker.postMessage({ challenge, start: index, step: pool.length, timeoutMs });
    });
  });
}
