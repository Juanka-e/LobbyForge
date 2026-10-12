/**
 * Host effects (docs/PLUGIN_SDK.md, "Effects"; docs/PLUGIN_UNLOCK_PLAN.md,
 * phase 3).
 *
 * A reducer stays pure and synchronous. When it wants the host to do
 * something beyond the next state — fire an action later, remember a value
 * across sessions, post a line to the channel's chat — it returns its state
 * wrapped with the effects it asks for:
 *
 *   return withEffects(next, [{ type: 'timer.set', id: 'reveal', afterMs: 10_000, action: { type: 'auto-reveal' } }]);
 *
 * The host unwraps the envelope wherever it consumes a reducer result,
 * validates every effect here (shape and limits) together with the
 * plugin's permission for it, and applies them only if ALL are valid: one
 * invalid or unpermitted effect refuses the whole action
 * (`code: 'effect_refused'`) — nothing is half applied.
 *
 * Everything in this file is pure (no host, no I/O): the host and the
 * testing harness (`@lobbyforge/plugin-sdk/testing`) run the same rules.
 */

/** Permission names a plugin declares to use host effects (manifest `permissions`). */
export const EFFECT_PERMISSIONS = ['timers', 'storage', 'chat', 'voice.mute'] as const;
export type EffectPermission = (typeof EFFECT_PERMISSIONS)[number];

export function isEffectPermission(name: unknown): name is EffectPermission {
  return typeof name === 'string' && (EFFECT_PERMISSIONS as readonly string[]).includes(name);
}

export const EFFECT_LIMITS = {
  /** Effects one reducer call may return. */
  maxEffectsPerCall: 32,
  /** Pending timers per session. */
  maxTimers: 8,
  /** A timer fires 1 s to 24 h after the call that sets it. */
  minTimerMs: 1_000,
  maxTimerMs: 24 * 60 * 60 * 1000,
  /** The action a timer fires, as JSON (UTF-8 bytes). */
  maxTimerActionBytes: 4 * 1024,
  /** Storage, per community and plugin: every key plus its value's JSON (UTF-8 bytes). */
  maxStorageBytes: 64 * 1024,
  /** A chat post, in characters. */
  maxChatLength: 500,
} as const;

/** Timer ids: 1–64 of letters, digits and `. _ : -`. */
export const TIMER_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** Storage keys: 1–128 of letters, digits and `. _ : -` (the host's `plugin_data` rule). */
export const STORAGE_KEY_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
/** Action types, as the actions route and the manifest accept them. */
const ACTION_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** The action a timer fires: a `role: "system"` action of the plugin. */
export interface TimerAction {
  type: string;
  [field: string]: unknown;
}

export type PluginEffect =
  /** Fire `action` (a system action) `afterMs` from now, or at the epoch ms `at`. Same id replaces. Permission `timers`. */
  | { type: 'timer.set'; id: string; afterMs: number; action: TimerAction }
  | { type: 'timer.set'; id: string; at: number; action: TimerAction }
  /** Forget a pending timer (no error when there is none). Permission `timers`. */
  | { type: 'timer.clear'; id: string }
  /** Replace one value of this plugin's storage in this community. Permission `storage`. */
  | { type: 'storage.set'; key: string; value: unknown }
  /** Remove one key of this plugin's storage. Permission `storage`. */
  | { type: 'storage.delete'; key: string }
  /** Post an app message to the activity's channel chat. Permission `chat`. */
  | { type: 'chat.post'; text: string };

/** A validated effect: timers carry their absolute due time. */
export type ValidEffect =
  | { type: 'timer.set'; id: string; at: number; action: TimerAction }
  | { type: 'timer.clear'; id: string }
  | { type: 'storage.set'; key: string; value: unknown }
  | { type: 'storage.delete'; key: string }
  | { type: 'chat.post'; text: string };

/** What `withEffects` returns. `__lf` is reserved: a plain state must not carry it. */
export interface EffectsEnvelope<TState = unknown> {
  __lf: 1;
  state: TState;
  effects: PluginEffect[];
}

/** What `createInitialState` / `handleAction` may return: the state, or the state with effects. */
export type ReducerResult<TState> = TState | EffectsEnvelope<TState>;

/**
 * The state plus the effects the host should apply with it. Return the SAME
 * state object with effects to change nothing but still have them applied;
 * `withEffects(state, [])` with the same state is "no change", like
 * returning `state` itself.
 */
export function withEffects<TState>(state: TState, effects: readonly PluginEffect[]): EffectsEnvelope<TState> {
  return { __lf: 1, state, effects: [...effects] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEffectsEnvelope(value: unknown): value is EffectsEnvelope<unknown> {
  return isPlainObject(value) && value.__lf === 1 && Object.hasOwn(value, 'state');
}

/**
 * A reducer result as the host consumes it: the state and the raw effects
 * (not validated yet — pass them to `validateEffects`). A plain state has
 * no effects.
 */
export function unwrapReducerResult(value: unknown): { state: unknown; effects: unknown } {
  if (isEffectsEnvelope(value)) return { state: value.state, effects: (value as { effects?: unknown }).effects ?? [] };
  return { state: value, effects: [] };
}

/** One record of a session's pending timers, as the host stores it. */
export interface PendingTimer {
  id: string;
  /** Epoch ms the timer is due. */
  at: number;
  action: TimerAction;
}

const utf8 = new TextEncoder();

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/** A value's JSON, or null when it has none (undefined, a function, a cycle, a BigInt). */
function jsonOf(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

/** Storage size: every key plus its value's JSON, in UTF-8 bytes. */
export function storageBytes(entries: Readonly<Record<string, unknown>>): number {
  let total = 0;
  for (const key of Object.keys(entries)) total += byteLength(key) + byteLength(jsonOf(entries[key]) ?? 'null');
  return total;
}

const PERMISSION_OF: Record<ValidEffect['type'], EffectPermission> = {
  'timer.set': 'timers',
  'timer.clear': 'timers',
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'chat.post': 'chat',
};

const KEYS_OF: Record<ValidEffect['type'], readonly string[]> = {
  'timer.set': ['type', 'id', 'afterMs', 'at', 'action'],
  'timer.clear': ['type', 'id'],
  'storage.set': ['type', 'key', 'value'],
  'storage.delete': ['type', 'key'],
  'chat.post': ['type', 'text'],
};

/** C0 controls other than tab and newline, and DEL: never part of a chat line. */
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export interface EffectRules {
  /** The plugin's EFFECTIVE permissions (asked for and, for a marketplace plugin, approved). */
  permissions: readonly string[];
  /** The plugin's action types declared `role: "system"`: the only ones a timer may fire. */
  systemActions: readonly string[];
  /** The call's clock (ctx.now): `afterMs` counts from here, `at` must fall 1 s – 24 h after it. */
  now: number;
}

export type EffectsValidation = { ok: true; effects: ValidEffect[] } | { ok: false; error: string };

/**
 * Check every effect: shape, limits, and the permission it needs. The
 * first problem refuses them all (the error names it, for the plugin
 * author: an index, a type, a key — never a value).
 */
export function validateEffects(raw: unknown, rules: EffectRules): EffectsValidation {
  const fail = (error: string): EffectsValidation => ({ ok: false, error });
  if (!Array.isArray(raw)) return fail('effects must be an array');
  if (raw.length > EFFECT_LIMITS.maxEffectsPerCall) return fail(`more than ${EFFECT_LIMITS.maxEffectsPerCall} effects in one call`);
  const out: ValidEffect[] = [];
  for (let index = 0; index < raw.length; index++) {
    const effect = raw[index];
    const where = `effects[${index}]`;
    if (!isPlainObject(effect) || typeof effect.type !== 'string') return fail(`${where} must be an object with a "type"`);
    const type = effect.type as ValidEffect['type'];
    if (!Object.hasOwn(PERMISSION_OF, type)) return fail(`${where}: unknown effect type "${String(effect.type).slice(0, 32)}"`);
    const label = `${where} (${type})`;
    for (const key of Object.keys(effect)) {
      if (!KEYS_OF[type].includes(key)) return fail(`${label}: unknown key "${key.slice(0, 32)}"`);
    }
    const permission = PERMISSION_OF[type];
    if (!rules.permissions.includes(permission)) return fail(`${label}: the plugin does not have the "${permission}" permission`);

    if (type === 'timer.set' || type === 'timer.clear') {
      if (typeof effect.id !== 'string' || !TIMER_ID_RE.test(effect.id)) {
        return fail(`${label}: "id" must be 1-64 of A-Z a-z 0-9 . _ : -`);
      }
      if (type === 'timer.clear') {
        out.push({ type, id: effect.id });
        continue;
      }
      const hasAfter = effect.afterMs !== undefined;
      const hasAt = effect.at !== undefined;
      if (hasAfter === hasAt) return fail(`${label}: give exactly one of "afterMs" and "at"`);
      let at: number;
      if (hasAfter) {
        const after = effect.afterMs;
        if (typeof after !== 'number' || !Number.isFinite(after) || after < EFFECT_LIMITS.minTimerMs || after > EFFECT_LIMITS.maxTimerMs) {
          return fail(`${label}: "afterMs" must be ${EFFECT_LIMITS.minTimerMs}-${EFFECT_LIMITS.maxTimerMs}`);
        }
        at = rules.now + Math.round(after);
      } else {
        const when = effect.at;
        if (
          typeof when !== 'number' ||
          !Number.isFinite(when) ||
          when < rules.now + EFFECT_LIMITS.minTimerMs ||
          when > rules.now + EFFECT_LIMITS.maxTimerMs
        ) {
          return fail(`${label}: "at" must fall 1 s to 24 h after ctx.now`);
        }
        at = Math.round(when);
      }
      const action = effect.action;
      if (!isPlainObject(action) || typeof action.type !== 'string' || !ACTION_TYPE_RE.test(action.type)) {
        return fail(`${label}: "action" must be an object with a valid "type"`);
      }
      if (!rules.systemActions.includes(action.type)) {
        return fail(`${label}: action "${action.type}" is not declared with role "system" in actionPolicies`);
      }
      const json = jsonOf(action);
      if (json === null) return fail(`${label}: "action" is not JSON`);
      if (byteLength(json) > EFFECT_LIMITS.maxTimerActionBytes) {
        return fail(`${label}: "action" is larger than ${EFFECT_LIMITS.maxTimerActionBytes} bytes`);
      }
      out.push({ type, id: effect.id, at, action: JSON.parse(json) as TimerAction });
      continue;
    }

    if (type === 'storage.set' || type === 'storage.delete') {
      // `__proto__` fits the pattern but must never become an object key.
      if (typeof effect.key !== 'string' || !STORAGE_KEY_RE.test(effect.key) || effect.key === '__proto__') {
        return fail(`${label}: "key" must be 1-128 of A-Z a-z 0-9 . _ : - (not __proto__)`);
      }
      if (type === 'storage.delete') {
        out.push({ type, key: effect.key });
        continue;
      }
      if (!Object.hasOwn(effect, 'value')) return fail(`${label}: "value" is missing (use storage.delete to remove a key)`);
      const json = jsonOf(effect.value);
      if (json === null) return fail(`${label}: "value" is not JSON`);
      out.push({ type, key: effect.key, value: JSON.parse(json) as unknown });
      continue;
    }

    // chat.post
    if (typeof effect.text !== 'string') return fail(`${label}: "text" must be a string`);
    const text = effect.text.replace(/\r\n?/g, '\n').trim();
    if (text.length === 0 || text.length > EFFECT_LIMITS.maxChatLength) {
      return fail(`${label}: "text" must be 1-${EFFECT_LIMITS.maxChatLength} characters`);
    }
    if (CONTROL_CHAR_RE.test(text)) return fail(`${label}: "text" contains a control character`);
    out.push({ type: 'chat.post', text });
  }
  return { ok: true, effects: out };
}

export type TimersResult = { ok: true; timers: PendingTimer[]; changed: boolean } | { ok: false; error: string };

/**
 * Apply the timer effects to a session's pending timers, in order: a set
 * replaces a timer with the same id (and goes to the end of the list), a
 * clear removes one. More than `maxTimers` afterwards refuses the lot.
 */
export function applyTimerEffects(timers: readonly PendingTimer[], effects: readonly ValidEffect[]): TimersResult {
  let next = [...timers];
  let changed = false;
  for (const effect of effects) {
    if (effect.type === 'timer.set') {
      next = next.filter((timer) => timer.id !== effect.id);
      next.push({ id: effect.id, at: effect.at, action: effect.action });
      changed = true;
    } else if (effect.type === 'timer.clear') {
      const before = next.length;
      next = next.filter((timer) => timer.id !== effect.id);
      if (next.length !== before) changed = true;
    }
  }
  if (next.length > EFFECT_LIMITS.maxTimers) {
    return { ok: false, error: `more than ${EFFECT_LIMITS.maxTimers} pending timers` };
  }
  return { ok: true, timers: next, changed };
}

/** The earliest timer due at or before `now` (ties: the one set first), or null. */
export function nextDueTimer(timers: readonly PendingTimer[], now: number): PendingTimer | null {
  let due: PendingTimer | null = null;
  for (const timer of timers) {
    if (timer.at <= now && (due === null || timer.at < due.at)) due = timer;
  }
  return due;
}

/** One write of a storage effect batch: the final value of a key, or its removal. */
export type StorageWrite = { key: string; value: unknown } | { key: string; delete: true };

export type StorageResult =
  | { ok: true; entries: Record<string, unknown>; writes: StorageWrite[] }
  | { ok: false; error: string };

/**
 * Apply the storage effects to a snapshot of the plugin's storage (in
 * order; the last effect on a key wins) and check the size limit on the
 * result. `writes` is what changes, one entry per key touched.
 */
export function applyStorageEffects(
  entries: Readonly<Record<string, unknown>>,
  effects: readonly ValidEffect[]
): StorageResult {
  // Null prototype: a key is only ever an own property.
  const next: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, entries);
  const touched = new Set<string>();
  for (const effect of effects) {
    if (effect.type === 'storage.set') {
      next[effect.key] = effect.value;
      touched.add(effect.key);
    } else if (effect.type === 'storage.delete') {
      delete next[effect.key];
      touched.add(effect.key);
    }
  }
  if (touched.size === 0) return { ok: true, entries: next, writes: [] };
  if (storageBytes(next) > EFFECT_LIMITS.maxStorageBytes) {
    return { ok: false, error: `storage would exceed ${EFFECT_LIMITS.maxStorageBytes} bytes` };
  }
  const writes: StorageWrite[] = [...touched].map((key) =>
    Object.hasOwn(next, key) ? { key, value: next[key] } : { key, delete: true as const }
  );
  return { ok: true, entries: next, writes };
}

/** The chat posts among validated effects, in order. */
export function chatPostsOf(effects: readonly ValidEffect[]): string[] {
  return effects.flatMap((effect) => (effect.type === 'chat.post' ? [effect.text] : []));
}

/**
 * `ctx.storage`: a read-only snapshot of the plugin's storage in this
 * community, taken before the call. Writes go through effects.
 */
export interface StorageSnapshot {
  /** The value (a copy), or undefined when the key is not set. */
  get: (key: string) => unknown;
  /** Every key, sorted. */
  keys: () => string[];
}

export function createStorageSnapshot(entries: Readonly<Record<string, unknown>>): StorageSnapshot {
  const frozen: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(entries)) frozen[key] = jsonOf(entries[key]) ?? 'null';
  return {
    get: (key: string) => (typeof key === 'string' && key in frozen ? (JSON.parse(frozen[key]!) as unknown) : undefined),
    keys: () => Object.keys(frozen).sort(),
  };
}

/** The entries behind a snapshot (for the sandbox, which gets them as JSON). */
export function storageSnapshotEntries(snapshot: StorageSnapshot | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!snapshot || typeof snapshot.keys !== 'function') return out;
  for (const key of snapshot.keys()) out[key] = snapshot.get(key);
  return out;
}
