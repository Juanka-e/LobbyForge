/**
 * Stable plugin identifier. Kept in its own module so the panel (which
 * registers the locale tables at module scope) can import it WITHOUT
 * importing `./index` — index imports the panel, and the cycle would
 * leave this `const` in its temporal dead zone. Hushle and Dice Bot
 * split their ids out for the same reason.
 */
export const QUIZ_PLUGIN_ID = 'quiz';
