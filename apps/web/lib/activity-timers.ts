/**
 * Plugin timers: when a `timer.set` effect falls due (docs/PLUGIN_SDK.md
 * "Effects", docs/ACTIVITY_INTEGRITY_AND_RESILIENCE.md §3.4).
 *
 * LAZY, like the host transfer (lib/activity-host.ts): nothing runs on a
 * clock. A session's pending timers live in `game_sessions.timers`,
 * written in the same compare-and-swap as the state that set them. When
 * somebody touches the session — a state read (GET), an action, an end
 * request — every timer whose due time has passed is fired under the
 * session's write lock, earliest first (ties: the one set first), each as
 * its `role: "system"` action through the reducer with `ctx.now` = its due
 * time and no actor. Its effects apply too (a timer may set the next one,
 * and a chain that is already due keeps firing in the same touch).
 *
 * CATCH-UP IS BOUNDED (security review: an idle 1 s timer that re-arms
 * itself used to build a backlog that every touch then replayed, up to 32
 * reducer calls — 32 worker RPCs for a sandboxed plugin — under the
 * session lock):
 *  - a timer that re-arms itself (its firing sets a timer with the same
 *    id) while it is catching up skips the occurrences that were missed:
 *    the re-armed timer moves to the LATEST occurrence of its period that
 *    is due, so the backlog collapses to one more firing;
 *  - one touch runs at most MAX_TIMER_FIRINGS_PER_TOUCH reducer calls and
 *    starts none after TIMER_FIRING_BUDGET_MS of wall time; what is still
 *    due fires on the next touch (`pendingDue`). The actions route then
 *    refuses its action with a retryable 409 rather than run it ahead of a
 *    due timer.
 *
 * A timer of an app that is no longer installed or enabled in the
 * community is dropped without running (lib/activity-app-install.ts).
 *
 * Exactly once: the lock serializes touches, and a fired timer is removed
 * in the same write as the state it produced, so of two concurrent reads
 * the second finds nothing due. A timer action that throws, or whose
 * effects are refused, is dropped (logged) and the next one runs.
 *
 * So that a due timer fires even when nobody acts, the GET reports the
 * pending due times (never the actions) and an open panel re-reads the
 * session once at the earliest one (lib/activity-next-check.ts). Nobody
 * watching means nothing runs — by design.
 */
import {
  GameSessionBusyError,
  logAction,
  setGameSessionStateCAS,
  withGameSessionWriteLock,
  type DbClient,
  type GameSessionRow,
} from '@lobbyforge/db';
import {
  nextDueTimer,
  shouldAuditAction,
  type GamePluginContext,
  type PendingTimer,
  type RegisteredGamePlugin,
  type ValidEffect,
} from '@lobbyforge/plugin-sdk';
import { publishActivityStateChange } from './activity-bus';
import {
  applyPostCommitEffects,
  effectGrantFor,
  interpretReducerResult,
  loadStorageEntries,
  logRefusedEffects,
  planEffects,
  postCommitEffects,
  setCallContext,
  type EffectGrant,
} from './activity-effects';
import { buildHttpPluginContext, callHandleAction } from './plugin-context';
import { attachSandboxScope, isWorkerBackedPlugin } from './plugin-worker-client';
import { isAppEnabled } from './activity-app-install';

/** Reducer calls in one touch; what is still due continues on the next. */
export const MAX_TIMER_FIRINGS_PER_TOUCH = 8;
/** Wall time after which a touch starts no further firing (the next touch continues). */
export const TIMER_FIRING_BUDGET_MS = 500;

const TERMINAL = new Set(['ended', 'cancelled']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `game_sessions.timers` read defensively (host-written, but a column is a column). */
export function readStoredTimers(raw: unknown): PendingTimer[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingTimer[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue;
    if (!isRecord(entry.action) || typeof entry.action.type !== 'string') continue;
    out.push({ id: entry.id, at: entry.at, action: entry.action as PendingTimer['action'] });
  }
  return out;
}

/** What a viewer may know: when the pending timers fall due (ISO, earliest first) — never their actions. */
export function timersDueAtJson(timers: readonly PendingTimer[]): string[] {
  return timers
    .map((timer) => timer.at)
    .sort((a, b) => a - b)
    .map((at) => new Date(at).toISOString());
}

export function hasDueTimer(timers: readonly PendingTimer[], now: number): boolean {
  return nextDueTimer(timers, now) !== null;
}

/** The timers that are not due yet (a removed app's due timers are dropped unrun). */
export function withoutDueTimers(timers: readonly PendingTimer[], now: number): PendingTimer[] {
  return timers.filter((timer) => timer.at > now);
}

/**
 * Catch-up collapse: `fired` (due at `fired.at`) just ran and left
 * `timers`. If it re-armed itself (a timer with its id) at a time that is
 * still due by `now`, move that timer to the latest occurrence of the same
 * period that is due — the occurrences in between were missed while nobody
 * touched the session and are not replayed one by one. Returns the timers
 * and how many occurrences were skipped.
 */
export function collapseRearmedTimer(
  timers: readonly PendingTimer[],
  fired: PendingTimer,
  now: number
): { timers: PendingTimer[]; skipped: number } {
  const rearmed = timers.find((timer) => timer.id === fired.id);
  if (!rearmed || rearmed.at > now || rearmed.at <= fired.at) return { timers: [...timers], skipped: 0 };
  const period = rearmed.at - fired.at;
  const skipped = Math.floor((now - rearmed.at) / period);
  if (skipped <= 0) return { timers: [...timers], skipped: 0 };
  const at = rearmed.at + skipped * period;
  return { timers: timers.map((timer) => (timer === rearmed ? { ...timer, at } : timer)), skipped };
}

export interface FiredTimers {
  state: Record<string, unknown>;
  timers: PendingTimer[];
  /** The plugin's storage as the fired actions leave it (what a following call in the same lock reads). */
  storage: Record<string, unknown>;
  /** Their storage and chat effects, in order: applied after the commit. */
  effects: ValidEffect[];
  /** System action types fired whose policy asks for an audit row. */
  audited: string[];
  /** Timers taken off the list (run, or dropped as no longer system actions). */
  fired: number;
  /** Reducer calls made. */
  calls: number;
  /** Missed occurrences of self-re-arming timers that were skipped (collapsed). */
  skipped: number;
  /** A timer is still due: the per-touch cap stopped the catch-up; the next touch continues. */
  pendingDue: boolean;
  stateChanged: boolean;
  timersChanged: boolean;
}

/**
 * Fire the timers due at `now`, in due order, on `state` (already
 * migrated) — at most `maxFirings` reducer calls, and none started after
 * `budgetMs` of wall time (the first always runs, so every touch makes
 * progress). A self-re-arming timer's missed occurrences collapse
 * (`collapseRearmedTimer`). `ctx` is a system ctx (`actorUserId: ''`);
 * each call gets the due time as `ctx.now` and the storage as it stands.
 * Pure apart from the reducer calls: the caller writes the result.
 */
export async function runDueTimers(input: {
  plugin: RegisteredGamePlugin;
  grant?: EffectGrant;
  state: Record<string, unknown>;
  timers: readonly PendingTimer[];
  storage: Record<string, unknown>;
  now: number;
  ctx: GamePluginContext;
  maxFirings?: number;
  budgetMs?: number;
  /** Wall clock for the budget (tests inject one); not the touch's `now`. */
  clock?: () => number;
}): Promise<FiredTimers> {
  const { plugin } = input;
  const grant = input.grant ?? effectGrantFor(plugin);
  const max = Math.max(1, input.maxFirings ?? MAX_TIMER_FIRINGS_PER_TOUCH);
  const budgetMs = input.budgetMs ?? TIMER_FIRING_BUDGET_MS;
  const clock = input.clock ?? (() => performance.now());
  const started = clock();
  let state = input.state;
  let timers = [...input.timers];
  let storage = input.storage;
  const effects: ValidEffect[] = [];
  const audited: string[] = [];
  let fired = 0;
  let calls = 0;
  let skipped = 0;
  let stateChanged = false;
  for (;;) {
    const due = nextDueTimer(timers, input.now);
    if (!due) break;
    // The cap: a reducer-call budget and a wall-time budget per touch.
    if (calls >= max || (calls > 0 && clock() - started >= budgetMs)) break;
    timers = timers.filter((timer) => timer !== due);
    fired += 1;
    // A timer whose action is no longer a system action (the plugin was
    // upgraded) is dropped: only system actions run without a client.
    const policy = plugin.actionPolicies?.[due.action.type];
    if (!policy || !Object.hasOwn(plugin.actionPolicies ?? {}, due.action.type) || policy.role !== 'system') {
      logRefusedEffects('timer', plugin.manifest.id, `timer "${due.id}" fires "${due.action.type}", which is not a system action`);
      continue;
    }
    setCallContext(input.ctx, { storage, now: due.at });
    calls += 1;
    let result: unknown;
    try {
      result = await callHandleAction(plugin, input.ctx, state, due.action);
    } catch (err) {
      console.warn(`[activity-timers] timer "${due.id}" of "${plugin.manifest.id}" failed:`, JSON.stringify((err as Error).message));
      continue;
    }
    const step = interpretReducerResult(result, state, { ...grant, now: due.at });
    if (!step.ok) {
      logRefusedEffects(`timer "${due.id}"`, plugin.manifest.id, step.reason);
      continue;
    }
    const planned = planEffects(step.effects, timers, storage);
    if (!planned.ok) {
      logRefusedEffects(`timer "${due.id}"`, plugin.manifest.id, planned.reason);
      continue;
    }
    if (step.state !== state) stateChanged = true;
    state = step.state;
    const collapsed = collapseRearmedTimer(planned.timers, due, input.now);
    timers = collapsed.timers;
    skipped += collapsed.skipped;
    storage = planned.storage;
    effects.push(...postCommitEffects(step.effects));
    if (step.changed && shouldAuditAction(policy)) audited.push(due.action.type);
  }
  return {
    state,
    timers,
    storage,
    effects,
    audited,
    fired,
    calls,
    skipped,
    pendingDue: hasDueTimer(timers, input.now),
    stateChanged,
    timersChanged: fired > 0,
  };
}

/**
 * A ctx for system actions: no actor, the session's roster as players.
 * Built before the session lock (it reads the roster through the pool).
 */
export async function buildSystemContext(input: {
  db: DbClient;
  plugin: RegisteredGamePlugin;
  serverId: string;
  sessionId: string;
  hostUserId: string | null;
  /** The language of the request whose touch fires the timers (the sandbox's ctx.locale). */
  locale: string;
}): Promise<GamePluginContext> {
  const ctx = await buildHttpPluginContext({
    db: input.db,
    sessionId: input.sessionId,
    actorUserId: '',
    serverId: input.serverId,
    pluginId: input.plugin.manifest.id,
  });
  // No `now` here: each firing sets `ctx.now` to its due time.
  if (isWorkerBackedPlugin(input.plugin)) {
    attachSandboxScope(ctx, { sessionId: input.sessionId, hostUserId: input.hostUserId, locale: input.locale });
  }
  return ctx;
}

/** Audit rows for fired system actions that ask for one (actor: none). */
export function auditSystemActions(db: DbClient, input: { serverId: string; sessionId: string; pluginId: string; types: readonly string[] }): void {
  for (const actionType of input.types) {
    void logAction(db, {
      serverId: input.serverId,
      actorUserId: null,
      action: 'activity.action',
      targetType: 'session',
      targetId: input.sessionId,
      metadata: { pluginId: input.pluginId, actionType, system: true },
    }).catch((err) => console.error('[audit] activity.action (system) failed:', (err as Error).message));
  }
}

export interface FiredSession {
  /** The row as committed (new state, timers and revision). */
  row: GameSessionRow;
  /** The committed state (the plugin's current shape). */
  state: Record<string, unknown>;
}

/**
 * The GET and end routes' touch: fire the session's due timers, if any.
 * Returns the committed row, or null when nothing fired (nothing due, the
 * session ended, the lock was busy — the next touch tries again — or a
 * failure, logged: a read never fails over a timer). When the app is no
 * longer installed or enabled in the community, the due timers are dropped
 * without running (the returned state is the session's own, unchanged).
 */
export async function fireDueSessionTimers(input: {
  db: DbClient;
  row: GameSessionRow;
  plugin: RegisteredGamePlugin | null;
  hostUserId: string | null;
  locale: string;
  now?: number;
}): Promise<FiredSession | null> {
  const { db, row, plugin } = input;
  const now = input.now ?? Date.now();
  if (!plugin || TERMINAL.has(row.status) || !hasDueTimer(readStoredTimers(row.timers), now)) return null;
  const grant = effectGrantFor(plugin);
  try {
    if (!(await isAppEnabled(db, row.serverId, plugin.manifest.id))) {
      return await dropDueSessionTimers({ db, row, plugin, now });
    }
    const ctx = await buildSystemContext({
      db,
      plugin,
      serverId: row.serverId,
      sessionId: row.id,
      hostUserId: input.hostUserId,
      locale: input.locale,
    });
    let snapshot: Record<string, unknown> = {};
    let fired: FiredTimers | null = null;
    const committed = await withGameSessionWriteLock(db, row.id, async (tx, fresh) => {
      if (!fresh || TERMINAL.has(fresh.status)) return null;
      const timers = readStoredTimers(fresh.timers);
      // Another touch fired them while this one waited for the lock.
      if (!hasDueTimer(timers, now)) return null;
      const state = (plugin.migrateState ? await plugin.migrateState(fresh.state) : fresh.state) as Record<string, unknown>;
      snapshot = await loadStorageEntries(tx, fresh.serverId, plugin.manifest.id, grant);
      fired = await runDueTimers({ plugin, grant, state, timers, storage: snapshot, now, ctx });
      const revision = (fresh as { revision?: number }).revision ?? 0;
      const cas = await setGameSessionStateCAS(tx, fresh.id, revision, fired.state, undefined, { timers: fired.timers });
      return cas.ok && cas.row ? cas.row : null;
    });
    const result = fired as FiredTimers | null;
    if (!committed || !result) return null;
    publishActivityStateChange({
      serverId: row.serverId,
      sessionId: row.id,
      status: committed.status,
      revision: (committed as { revision?: number }).revision,
      publicSummary: { timersChanged: true },
    });
    auditSystemActions(db, { serverId: row.serverId, sessionId: row.id, pluginId: row.pluginId, types: result.audited });
    if (result.effects.length > 0) {
      await applyPostCommitEffects({
        db,
        serverId: row.serverId,
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        sessionId: row.id,
        storage: snapshot,
        effects: result.effects,
      });
    }
    return { row: committed, state: result.state };
  } catch (err) {
    if (!(err instanceof GameSessionBusyError)) {
      console.warn('[activity-timers] firing due timers failed:', JSON.stringify((err as Error).message));
    }
    return null;
  }
}

/** The app was removed from the community: its due timers go, unrun, in one write. */
async function dropDueSessionTimers(input: {
  db: DbClient;
  row: GameSessionRow;
  plugin: RegisteredGamePlugin;
  now: number;
}): Promise<FiredSession | null> {
  const { db, row, plugin, now } = input;
  let state: Record<string, unknown> = {};
  const committed = await withGameSessionWriteLock(db, row.id, async (tx, fresh) => {
    if (!fresh || TERMINAL.has(fresh.status)) return null;
    const timers = readStoredTimers(fresh.timers);
    if (!hasDueTimer(timers, now)) return null;
    const revision = (fresh as { revision?: number }).revision ?? 0;
    const cas = await setGameSessionStateCAS(tx, fresh.id, revision, fresh.state, undefined, {
      timers: withoutDueTimers(timers, now),
    });
    if (!cas.ok || !cas.row) return null;
    state = (plugin.migrateState ? await plugin.migrateState(cas.row.state) : cas.row.state) as Record<string, unknown>;
    return cas.row;
  });
  if (!committed) return null;
  console.warn(`[activity-timers] due timers of "${plugin.manifest.id}" dropped: the app is not installed or enabled in the community`);
  publishActivityStateChange({
    serverId: row.serverId,
    sessionId: row.id,
    status: committed.status,
    revision: (committed as { revision?: number }).revision,
    publicSummary: { timersChanged: true },
  });
  return { row: committed, state };
}
