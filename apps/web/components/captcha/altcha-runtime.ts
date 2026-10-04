/**
 * The ALTCHA widget, loaded on demand (`import('./altcha-runtime')` from
 * `altcha-loader.ts`), never statically — pages without a challenge never
 * download it.
 *
 * CSP: this is ALTCHA's `external` build. The default build inlines its
 * proof-of-work workers and starts them from `blob:` URLs, which the app's
 * policy refuses (no `worker-src`, so workers fall back to
 * `script-src 'self' 'nonce-…'`). The external build ships no workers; we
 * register our own, bundled by Next from the two `*.worker.ts` entries
 * below and served from `/_next/static/…`, i.e. `'self'`. Both are
 * Web Crypto (`crypto.subtle`), so no WebAssembly and no
 * `'wasm-unsafe-eval'` either. Argon2id and scrypt (WASM) are deliberately
 * NOT registered: a challenge that asked for them would fail loudly.
 *
 * The stylesheet is the external build's own, imported here so it arrives
 * with the widget.
 */
import 'altcha/external';
import 'altcha/altcha.css';

const shaWorker = () => new Worker(new URL('./altcha-sha.worker.ts', import.meta.url));
const pbkdf2Worker = () => new Worker(new URL('./altcha-pbkdf2.worker.ts', import.meta.url));

/** The algorithms the widget can solve, each with a same-origin worker. */
export const ALTCHA_ALGORITHMS = ['SHA-256', 'SHA-384', 'SHA-512', 'PBKDF2/SHA-256', 'PBKDF2/SHA-384', 'PBKDF2/SHA-512'] as const;

export function registerAltchaWorkers(): void {
  const { algorithms } = globalThis.$altcha;
  for (const algorithm of ALTCHA_ALGORITHMS) {
    algorithms.set(algorithm, algorithm.startsWith('PBKDF2/') ? pbkdf2Worker : shaWorker);
  }
}
