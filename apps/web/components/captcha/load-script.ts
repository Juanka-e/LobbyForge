/**
 * Lazy third-party script loading under the app's nonce CSP.
 *
 * `middleware.ts` puts a fresh `'nonce-…'` in `script-src` on every page
 * and hands it to Next through the request headers; Next stamps it on its
 * own `<script>` tags. A script we insert later has to carry the same
 * nonce or the browser refuses it, so we read it back from one of those
 * tags. Browsers hide the nonce ATTRIBUTE once the page has loaded
 * (it reads as ""), but the `nonce` PROPERTY keeps the value.
 */

/** The page's CSP nonce, or undefined when the page has none (dev tools, tests). */
export function readPageNonce(doc: Document = document): string | undefined {
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[nonce]'))) {
    const nonce = script.nonce || script.getAttribute('nonce');
    if (nonce) return nonce;
  }
  return undefined;
}

const pending = new Map<string, Promise<void>>();

export class ScriptLoadError extends Error {
  constructor(readonly src: string, readonly reason: 'error' | 'timeout') {
    super(`Could not load ${new URL(src).host} (${reason})`);
    this.name = 'ScriptLoadError';
  }
}

/**
 * Insert `<script src async nonce>` once per URL and resolve when it has
 * run. A failure is not cached: the element is removed so a retry inserts
 * a fresh one (a content blocker switched off, a flaky network).
 */
export function loadExternalScript(
  src: string,
  { nonce = readPageNonce(), timeoutMs = 15_000 }: { nonce?: string; timeoutMs?: number } = {}
): Promise<void> {
  const existing = pending.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    if (nonce) script.nonce = nonce;
    script.dataset.lfCaptcha = 'true';
    let settled = false;
    const finish = (error?: ScriptLoadError) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) {
        pending.delete(src);
        script.remove();
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = window.setTimeout(() => finish(new ScriptLoadError(src, 'timeout')), timeoutMs);
    script.addEventListener('load', () => finish());
    script.addEventListener('error', () => finish(new ScriptLoadError(src, 'error')));
    document.head.appendChild(script);
  });
  pending.set(src, promise);
  return promise;
}

/** Tests only: forget every load so each test starts clean. */
export function resetScriptLoaderForTests(): void {
  pending.clear();
}
