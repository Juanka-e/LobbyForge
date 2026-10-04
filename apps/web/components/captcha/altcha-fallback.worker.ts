// The pure-JS ALTCHA solver for pages without Web Crypto (plain HTTP), off
// the main thread. Bundled by Next as a same-origin worker, like the widget's
// own (see altcha-runtime.ts). It searches its share of the counters
// (`start`, `start + step`, …) and is terminated once any worker finds one.
import { solveRange, type AltchaV2Challenge } from './altcha-fallback-solver';

type Work = { challenge: AltchaV2Challenge; start: number; step: number; timeoutMs: number };

// A dedicated worker: only the page that created it can post to it, so there
// is no origin to check (MessageEvent.origin is empty here). It only does CPU
// work on the challenge it is given and posts the result back to that page.
self.onmessage = (event: MessageEvent<Work>) => {
  const { challenge, start, step, timeoutMs } = event.data;
  try {
    const solution = solveRange(challenge, { start, step, deadline: performance.now() + timeoutMs });
    self.postMessage({ solution });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
