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
 * time and no actor. Its effects apply too (a timer may set the next one;
 * a chain that is already due keeps firing in the same touch, up to
 * MAX_TIMER_FIRINGS_PER_TOUCH, and the rest fires on the next touch).
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

/** Timers fired in one touch; a chain that is still due continues on the next. */
export const MAX_TIMER_FIRINGS_PER_TOUCH = 32;

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

export interface FiredTimers {
  state: Record<string, unknown>;
  timers: PendingTimer[];
  /** The plugin's storage as the fired actions leave it (what a following call in the same lock reads). */
  storage: Record<string, unknown>;
  /** Their storage and chat effects, in order: applied after the commit. */
  effects: ValidEffect[];
  /** System action types fired whose policy asks for an audit row. */
  audited: string[];
  fired: number;
  stateChanged: boolean;
  timersChanged: boolean;
}

/**
 * Fire every timer due at `now`, in due order, on `state` (already
 * migrated). `ctx` is a system ctx (`actorUserId: ''`); each call gets the
 * due time as `ctx.now` and the storage as it stands. Pure apart from the
 * reducer calls: the caller writes the result.
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
}): Promise<FiredTimers> {
  const { plugin } = input;
  const grant = input.grant ?? effectGrantFor(plugin);
  const max = input.maxFirings ?? MAX_TIMER_FIRINGS_PER_TOUCH;
  let state = input.state;
  let timers = [...input.timers];
  let storage = input.storage;
  const effects: ValidEffect[] = [];
  const audited: string[] = [];
  let fired = 0;
  let stateChanged = false;
  while (fired < max) {
    const due = nextDueTimer(timers, input.now);
    if (!due) break;
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
    timers = planned.timers;
    storage = planned.storage;
    effects.push(...postCommitEffects(step.effects));
    if (step.changed && shouldAuditAction(policy)) audited.push(due.action.type);
  }
  return { state, timers, storage, effects, audited, fired, stateChanged, timersChanged: fired > 0 };
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
 * failure, logged: a read never fails over a timer).
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
