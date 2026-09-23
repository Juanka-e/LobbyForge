/**
 * Poll's stable identifier and its input limits.
 *
 * These live in their own module (and not in `index.ts`) for the same
 * reason Hushle keeps `plugin-id.ts` separate: `renderClient.tsx`
 * needs them as RUNTIME values at module scope (the locale loader
 * runs on import), while `index.ts` imports `renderClient.tsx`. Had
 * the constants stayed in `index.ts` the cycle would evaluate
 * `POLL_PLUGIN_ID` before its initializer ran and throw a TDZ
 * ReferenceError the first time the panel was imported.
 *
 * `index.ts` re-exports every name below, so the package's public
 * API is unchanged.
 */

export const POLL_PLUGIN_ID = 'poll';
export const POLL_MAX_OPTIONS = 6;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_QUESTION_LENGTH = 200;
export const POLL_MAX_OPTION_LENGTH = 80;
