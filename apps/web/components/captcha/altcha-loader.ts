import type { Strings } from 'altcha/types';

/**
 * Load the ALTCHA web component once per page (see `altcha-runtime.ts` for
 * why it is the external build with our own workers). A failed load is not
 * cached, so the challenge's "Try again" really tries again.
 */
let loading: Promise<void> | null = null;

export function loadAltcha(): Promise<void> {
  if (!loading) {
    loading = import('./altcha-runtime')
      .then((runtime) => runtime.registerAltchaWorkers())
      .catch((error: unknown) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

/** The widget's labels that a LobbyForge page can show (no code challenges here). */
export type AltchaStrings = Pick<
  Strings,
  'ariaLinkLabel' | 'error' | 'expired' | 'label' | 'loading' | 'reload' | 'verificationRequired' | 'verified' | 'verify' | 'verifying' | 'waitAlert'
>;

/**
 * Give the widget our catalogue's words for `language` (the app's locale,
 * lower-cased — the widget matches codes in lower case). Keys we do not
 * supply keep ALTCHA's English. Registering under the app's own code means
 * every language LobbyForge ships is covered, not only those ALTCHA bundles.
 */
export function registerAltchaStrings(language: string, strings: AltchaStrings): void {
  const store = globalThis.$altcha?.i18n;
  if (!store) return;
  const base = store.get('en') ?? {};
  store.set(language, { ...base, ...strings });
}

/** Tests only. */
export function resetAltchaLoaderForTests(): void {
  loading = null;
}
