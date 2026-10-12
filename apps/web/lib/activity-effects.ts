/**
 * Host effects on the activity routes (docs/PLUGIN_SDK.md "Effects",
 * docs/PLUGIN_UNLOCK_PLAN.md phase 3).
 *
 * A reducer (`createInitialState` / `handleAction`, official or sandboxed)
 * may return `withEffects(state, effects)`. Everywhere the host consumes a
 * reducer result it goes through `interpretReducerResult`: the envelope is
 * unwrapped, every effect is validated (shape, limits — the SDK's pure
 * `validateEffects`) against the plugin's EFFECTIVE permissions, and one
 * bad effect refuses the whole call (`effect_refused`, nothing applied).
 *
 * What the effects do, and when:
 *   timer.set / timer.clear  the session's pending timers, written in the
 *                            same compare-and-swap as the state
 *                            (lib/activity-timers.ts fires them lazily);
 *   storage.set / .delete    the plugin's `plugin_data` in this community,
 *                            written AFTER the state commit (below);
 *   chat.post                an app message (lib/activity-app-chat.ts),
 *                            also after the commit.
 *
 * Permissions: a compiled-in plugin has the effect permissions its
 * `manifest.permissions` lists (trusted code, no approval). A marketplace
 * plugin's worker-backed object carries in `manifest.permissions` only
 * what its manifest asks for AND the instance owner approved
 * (plugin-worker-client.ts `describeWorkerPlugin` → `effectiveApprovals`),
 * so the same rule reads both.
 */
import {
  applyStorageEffects,
  applyTimerEffects,
  chatPostsOf,
  createStorageSnapshot,
  EFFECT_LIMITS,
  isEffectPermission,
  storageBytes,
  unwrapReducerResult,
  validateEffects,
  type EffectPermission,
  type PendingTimer,
  type RegisteredGamePlugin,
  type ValidEffect,
} from '@lobbyforge/plugin-sdk';
import {
  listPluginData,
  PluginStorageFullError,
  writePluginDataBatch,
  type DbClient,
} from '@lobbyforge/db';
import { postAppMessage } from './activity-app-chat';

/** What a plugin may do with effects. */
export interface EffectGrant {
  permissions: EffectPermission[];
  /** Action types declared `role: "system"`: the only ones a timer may fire, and never sent by a client. */
  systemActions: string[];
}

export function effectGrantFor(plugin: Pick<RegisteredGamePlugin, 'manifest' | 'actionPolicies'>): EffectGrant {
  const permissions = (plugin.manifest.permissions ?? []).filter(isEffectPermission);
  const policies = plugin.actionPolicies ?? {};
  const systemActions = Object.keys(policies).filter((type) => policies[type]?.role === 'system');
  return { permissions: [...new Set(permissions)], systemActions };
}

/** Is `type` one of the plugin's system actions (own properties only)? */
export function isSystemAction(plugin: Pick<RegisteredGamePlugin, 'actionPolicies'>, type: string): boolean {
  const policies = plugin.actionPolicies;
  return !!policies && Object.hasOwn(policies, type) && policies[type]?.role === 'system';
}

/**
 * The plugin's storage in this community, for `ctx.storage` — empty
 * without the `storage` permission (nothing is read). Null prototype: a key
 * is only ever an own property.
 */
export async function loadStorageEntries(
  db: DbClient,
  serverId: string,
  pluginId: string,
  grant: EffectGrant
): Promise<Record<string, unknown>> {
  const entries = Object.create(null) as Record<string, unknown>;
  if (!grant.permissions.includes('storage')) return entries;
  for (const row of await listPluginData(db, serverId, pluginId)) entries[row.key] = row.value;
  return entries;
}

/** Give a host-built ctx its storage snapshot and clock for one call. */
export function setCallContext(ctx: { storage: unknown; now?: number }, input: { storage: Record<string, unknown>; now: number }): void {
  ctx.storage = createStorageSnapshot(input.storage);
  ctx.now = input.now;
}

export type ReducerStep =
  | {
      ok: true;
      state: Record<string, unknown>;
      effects: ValidEffect[];
      /** "Same state and no effects" is no change (a refused or no-op action). */
      changed: boolean;
    }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A reducer result as the host applies it: the next state and the
 * validated effects, or why the call is refused. `current` is the state
 * the reducer was given (the same object back means "no change").
 */
export function interpretReducerResult(
  result: unknown,
  current: unknown,
  rules: EffectGrant & { now: number }
): ReducerStep {
  const { state, effects } = unwrapReducerResult(result);
  if (!isRecord(state)) return { ok: false, reason: 'the reducer returned a state that is not an object' };
  const valid = validateEffects(effects, rules);
  if (!valid.ok) return { ok: false, reason: valid.error };
  return { ok: true, state, effects: valid.effects, changed: state !== current || valid.effects.length > 0 };
}

export type PlannedEffects =
  | {
      ok: true;
      timers: PendingTimer[];
      timersChanged: boolean;
      /** The storage as the call leaves it (what the next call in the same lock reads). */
      storage: Record<string, unknown>;
    }
  | { ok: false; reason: string };

/**
 * Check a call's effects against the session's timers and the plugin's
 * storage BEFORE anything commits: more than 8 timers, or storage past
 * 64 KiB, refuses the call like an invalid effect.
 */
export function planEffects(
  effects: readonly ValidEffect[],
  timers: readonly PendingTimer[],
  storage: Record<string, unknown>
): PlannedEffects {
  const nextTimers = applyTimerEffects(timers, effects);
  if (!nextTimers.ok) return { ok: false, reason: nextTimers.error };
  const nextStorage = applyStorageEffects(storage, effects);
  if (!nextStorage.ok) return { ok: false, reason: nextStorage.error };
  return { ok: true, timers: nextTimers.timers, timersChanged: nextTimers.changed, storage: nextStorage.entries };
}

/** The effects applied after the commit: storage writes and chat posts, in order. */
export function postCommitEffects(effects: readonly ValidEffect[]): ValidEffect[] {
  return effects.filter((effect) => effect.type.startsWith('storage.') || effect.type === 'chat.post');
}

/** One line for the server log: plugin-chosen text never forges log lines. */
export function logRefusedEffects(where: string, pluginId: string, reason: string): void {
  console.warn(`[activity-effects] ${where}: effects of "${pluginId}" refused:`, JSON.stringify(reason));
}

export interface PostCommitInput {
  db: DbClient;
  serverId: string;
  pluginId: string;
  /** The plugin's display name, snapshotted on an app message. */
  pluginName: string;
  sessionId: string;
  /** The storage entries the effects were checked against (the call's snapshot). */
  storage: Record<string, unknown>;
  effects: readonly ValidEffect[];
}

/**
 * Apply what a committed call asked for beyond its state, in order:
 * storage first (one all-or-nothing batch), then chat posts.
 *
 * ORDERING AND FAILURE: this runs after the session's state (and timers)
 * committed, outside the session lock. The state is the source of truth;
 * these are side effects, never retried:
 *  - storage: the batch is re-measured under a (community, plugin) lock
 *    against the storage as it stands then — another session may have
 *    written in between — and dropped whole (logged) if it would now
 *    exceed the limit or the write fails. Values are whole and last write
 *    wins: two sessions updating the same key at once can overwrite each
 *    other.
 *  - chat: each post is rate-limited per session and dropped when over the
 *    limit or when the community chose no channel for the app.
 * Never throws: the caller's request already succeeded.
 */
export async function applyPostCommitEffects(input: PostCommitInput): Promise<void> {
  const storageEffects = input.effects.filter((effect) => effect.type.startsWith('storage.'));
  if (storageEffects.length > 0) {
    const planned = applyStorageEffects(input.storage, storageEffects);
    if (!planned.ok) {
      logRefusedEffects('storage', input.pluginId, planned.error);
    } else if (planned.writes.length > 0) {
      try {
        await writePluginDataBatch(input.db, input.serverId, input.pluginId, planned.writes, {
          maxBytes: EFFECT_LIMITS.maxStorageBytes,
          sizeOf: storageBytes,
        });
      } catch (err) {
        const why = err instanceof PluginStorageFullError ? err.message : `write failed: ${(err as Error).message}`;
        console.warn(`[activity-effects] storage writes of "${input.pluginId}" dropped:`, JSON.stringify(why));
      }
    }
  }
  for (const text of chatPostsOf(input.effects)) {
    try {
      await postAppMessage({
        db: input.db,
        serverId: input.serverId,
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        pluginName: input.pluginName,
        text,
      });
    } catch (err) {
      console.warn(`[activity-effects] chat post of "${input.pluginId}" failed:`, JSON.stringify((err as Error).message));
    }
  }
}
