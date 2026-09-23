/**
 * Dice Bot constants — kept in their own module so the React panel can
 * import them WITHOUT importing `./index`.
 *
 * `index.ts` imports `./renderClient`, and `renderClient.tsx` calls
 * `loadPluginLocale(DICE_PLUGIN_ID, …)` at module scope. If that id
 * lived in `index.ts` the two modules would form an ESM cycle and the
 * `const` would still be in its temporal dead zone when the locale
 * loader ran — a ReferenceError the moment the plugin is imported.
 * Hushle splits `plugin-id.ts` out for exactly the same reason.
 *
 * `index.ts` re-exports every name here, so the public API of
 * `@lobbyforge/dice-bot` is unchanged.
 */

export const DICE_PLUGIN_ID = 'dice-bot';
export const DICE_MIN_SIDES = 2;
export const DICE_MAX_SIDES = 100;
export const DICE_HISTORY_LIMIT = 20;
