/**
 * Watch Party's stable identifier, its limits and its timings.
 *
 * They live in their own module (not in `index.ts`) for the same reason
 * Poll keeps `constants.ts` separate: the panel needs them as RUNTIME
 * values at module scope (the locale loader runs on import) while
 * `index.ts` imports the panel. Had they stayed in `index.ts`, the cycle
 * would read the id before its initializer ran (a TDZ ReferenceError the
 * first time the panel was imported).
 */

export const WATCH_PARTY_PLUGIN_ID = 'watch-party';

// ---------------------------------------------------------------------------
// Limits (enforced by the reducer; the panel mirrors them to explain a refusal)
// ---------------------------------------------------------------------------

/** Videos waiting in "Up next" at most. */
export const QUEUE_MAX = 25;
/** Videos one viewer may have waiting at a time. The host is exempt: they run the queue. */
export const QUEUE_MAX_PER_USER = 3;
/** People listed as watching — the manifest's `maxPlayers`. Beyond it you can still watch, unlisted. */
export const VIEWERS_MAX = 50;
/** The latest position accepted (12 h). Anything later is a malformed action. */
export const POSITION_MAX_SEC = 12 * 60 * 60;
/** Longest user id the reducer stores (ids are UUIDs; this only bounds junk). */
export const USER_ID_MAX_LENGTH = 128;

// ---------------------------------------------------------------------------
// Presence. Every action is rate limited, audited and broadcast by the host,
// so presence is kept with as few actions as possible: an explicit join and
// leave, readiness only when it changes, and slow heartbeats — fast for the
// host (whose absence blocks everyone), slow for everyone else.
// ---------------------------------------------------------------------------

/** A report that changes nothing, sooner than this after the last one, is ignored by the reducer. */
export const HEARTBEAT_MIN_MS = 30_000;
/** How often the HOST's open panel says it is still there. */
export const HOST_HEARTBEAT_MS = 60_000;
/** How often any other open panel says it is still there. */
export const VIEWER_HEARTBEAT_MS = 5 * 60_000;
/** A host silent for this long counts as away: anyone watching may take over. */
export const HOST_AWAY_MS = 150_000;
/** A viewer silent for this long counts as away: dimmed, and left out of the sync summary. */
export const VIEWER_AWAY_MS = 12 * 60_000;

// ---------------------------------------------------------------------------
// Sync (client side)
// ---------------------------------------------------------------------------

/** How far a player may drift from the shared timeline before it is seeked back. */
export const DRIFT_TOLERANCE_SEC = 1.5;
/** A new readiness status must hold this long before it is reported (buffering blips are not news)… */
export const STATUS_DEBOUNCE_MS = 2_500;
/** …and two readiness reports from one viewer are at least this far apart. */
export const STATUS_MIN_INTERVAL_MS = 8_000;
