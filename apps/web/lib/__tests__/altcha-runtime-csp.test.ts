import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The ALTCHA widget runs under the app's CSP without a new directive
 * (docs/CAPTCHA.md §9): `middleware.ts` has no `worker-src`, so workers fall
 * back to `script-src 'self' 'nonce-…'`, which refuses `blob:` and WASM.
 * ALTCHA's default build starts its workers from `blob:` URLs; the
 * `external` build ships none, and we bundle Web Crypto workers that Next
 * serves from /_next/static (same origin). This pins that choice.
 */
const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

describe('ALTCHA runtime under the app CSP', () => {
  const runtime = read('components', 'captcha', 'altcha-runtime.ts');

  it('loads the external build (no inline blob: workers) with its stylesheet', () => {
    expect(runtime).toMatch(/^import 'altcha\/external';$/m);
    expect(runtime).toMatch(/^import 'altcha\/altcha\.css';$/m);
    expect(runtime).not.toMatch(/^import 'altcha';$/m);
    expect(runtime).not.toContain('createObjectURL');
  });

  it('starts its workers from bundled same-origin files', () => {
    expect(runtime).toContain("new Worker(new URL('./altcha-sha.worker.ts', import.meta.url))");
    expect(runtime).toContain("new Worker(new URL('./altcha-pbkdf2.worker.ts', import.meta.url))");
    expect(read('components', 'captcha', 'altcha-sha.worker.ts')).toContain("import 'altcha/workers/sha';");
    expect(read('components', 'captcha', 'altcha-pbkdf2.worker.ts')).toContain("import 'altcha/workers/pbkdf2';");
  });

  it('runs the plain-HTTP fallback solver from a bundled same-origin worker, with no Web Crypto or WASM', () => {
    const fallbackRunner = read('components', 'captcha', 'altcha-fallback-runner.ts');
    expect(fallbackRunner).toContain("new Worker(new URL('./altcha-fallback.worker.ts', import.meta.url))");
    expect(fallbackRunner).not.toContain('createObjectURL');
    const solver = read('components', 'captcha', 'altcha-fallback-solver.ts');
    expect(solver).not.toMatch(/subtle\.(digest|deriveBits|importKey)\(|WebAssembly\./);
  });

  it('registers no WebAssembly algorithm, and does register the one the server challenges with', () => {
    const registered = /ALTCHA_ALGORITHMS = \[([^\]]+)\]/.exec(runtime)?.[1] ?? '';
    const names = [...registered.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(names).toEqual(['SHA-256', 'SHA-384', 'SHA-512', 'PBKDF2/SHA-256', 'PBKDF2/SHA-384', 'PBKDF2/SHA-512']);
    const server = read('lib', 'captcha', 'altcha.ts');
    const algorithm = /ALTCHA_ALGORITHM\s*=\s*'([^']+)'/.exec(server)?.[1];
    expect(algorithm, 'lib/captcha/altcha.ts should name its ALTCHA_ALGORITHM').toBeTruthy();
    expect(names).toContain(algorithm);
  });
});
