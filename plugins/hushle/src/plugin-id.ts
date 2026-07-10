/**
 * Stable plugin identifier for the Hushle plugin. Kept in a
 * dedicated file so the locale loader can import it without
 * pulling in the React-heavy `renderClient.tsx` (which would be a
 * circular dep).
 */
export const HUSHLE_PLUGIN_ID = 'hushle';