/**
 * The host side of plugin effects (lib/activity-effects.ts) and the timer
 * runner (lib/activity-timers.ts), without routes: which permissions a
 * plugin has, how a reducer result is read, what is applied after a commit
 * (and what a failure there means), and how due timers run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withEffects, type GamePluginContext, type RegisteredGamePlugin } from '@lobbyforge/plugin-sdk';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';
import { pollPlugin } from '@lobbyforge/poll';

const db = vi.hoisted(() => ({
  listPluginData: vi.fn(async () => [] as Array<{ key: string; value: unknown }>),
  writePluginDataBatch: vi.fn(async (..._args: unknown[]) => undefined),
  PluginStorageFullError: class PluginStorageFullError extends Error {},
  GameSessionBusyError: class GameSessionBusyError extends Error {},
  logAction: vi.fn(async () => undefined),
  setGameSessionStateCAS: vi.fn(),
  withGameSessionWriteLock: vi.fn(),
}));
vi.mock('@lobbyforge/db', () => db);
const postAppMessage = vi.hoisted(() => vi.fn(async (_input: { text: string }) => ({ posted: true })));
vi.mock('../activity-app-chat', () => ({ postAppMessage }));
vi.mock('../activity-bus', () => ({ publishActivityStateChange: vi.fn() }));

const {
  applyPostCommitEffects,
  effectGrantFor,
  interpretReducerResult,
  isSystemAction,
  loadStorageEntries,
  planEffects,
} = await import('../activity-effects');
const { runDueTimers, readStoredTimers, timersDueAtJson } = await import('../activity-timers');

function plugin(overrides: Partial<RegisteredGamePlugin> = {}): RegisteredGamePlugin {
  return {
    manifest: {
      id: 'p',
      name: 'P',
      version: '1.0.0',
      type: 'game',
      minAppVersion: '0',
      permissions: ['manage_timer', 'timers', 'chat'] as never,
      locales: ['en'],
      entryClient: '',
    },
    actionPolicies: { go: { role: 'host' }, tick: { role: 'system' } },
    createInitialState: () => ({}),
    handleAction: (_ctx, state) => state,
    renderClient: () => null,
    ...overrides,
  };
}

function ctx(): GamePluginContext {
  const c = createTestHarness({ plugin: pollPlugin, players: ['u-1'] }).context as unknown as GamePluginContext;
  Object.defineProperty(c, 'actorUserId', { value: '', writable: true });
  return c;
}

beforeEach(() => {
  for (const fn of [db.listPluginData, db.writePluginDataBatch, db.logAction, postAppMessage]) fn.mockClear();
});

describe('effectGrantFor', () => {
  it('reads the effect permissions from manifest.permissions (the descriptive old names grant nothing) and the system actions', () => {
    expect(effectGrantFor(plugin())).toEqual({ permissions: ['timers', 'chat'], systemActions: ['tick'] });
    expect(isSystemAction(plugin(), 'tick')).toBe(true);
    expect(isSystemAction(plugin(), 'go')).toBe(false);
    expect(isSystemAction(plugin(), 'constructor')).toBe(false);
  });
});

describe('interpretReducerResult and planEffects', () => {
  const rules = { permissions: ['timers', 'storage'] as never[], systemActions: ['tick'], now: 1_000_000 };

  it('a plain state, the same state, and the same state with effects', () => {
    const state = { a: 1 };
    expect(interpretReducerResult({ a: 2 }, state, rules)).toMatchObject({ ok: true, changed: true, effects: [] });
    expect(interpretReducerResult(state, state, rules)).toMatchObject({ ok: true, changed: false });
    expect(interpretReducerResult(withEffects(state, []), state, rules)).toMatchObject({ ok: true, changed: false });
    const withTimer = interpretReducerResult(
      withEffects(state, [{ type: 'timer.set', id: 't', afterMs: 2_000, action: { type: 'tick' } }]),
      state,
      rules
    );
    expect(withTimer).toMatchObject({ ok: true, changed: true, state, effects: [{ type: 'timer.set', at: 1_002_000 }] });
  });

  it('refuses a state that is not an object, and an invalid effect', () => {
    expect(interpretReducerResult(null, {}, rules).ok).toBe(false);
    expect(interpretReducerResult(withEffects({}, [{ type: 'chat.post', text: 'x' }]), {}, rules).ok).toBe(false);
  });

  it('planEffects refuses a ninth timer and a storage overflow', () => {
    const timers = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, at: 2_000_000, action: { type: 'tick' } }));
    expect(planEffects([{ type: 'timer.set', id: 'x', at: 2_000_000, action: { type: 'tick' } }], timers, {}).ok).toBe(false);
    expect(planEffects([{ type: 'storage.set', key: 'k', value: 'x'.repeat(70_000) }], [], {}).ok).toBe(false);
    expect(planEffects([{ type: 'storage.set', key: 'k', value: 1 }], [], {})).toMatchObject({ ok: true, storage: { k: 1 } });
  });
});

describe('loadStorageEntries', () => {
  it('reads nothing without the storage permission; a null-prototype map with it', async () => {
    db.listPluginData.mockResolvedValue([
      { key: 'best', value: [1] },
      { key: '__proto__', value: { polluted: true } },
    ]);
    expect(await loadStorageEntries({} as never, 's', 'p', { permissions: ['timers'], systemActions: [] })).toEqual({});
    expect(db.listPluginData).not.toHaveBeenCalled();
    const entries = await loadStorageEntries({} as never, 's', 'p', { permissions: ['storage'], systemActions: [] });
    expect(Object.getPrototypeOf(entries)).toBeNull();
    expect(entries.best).toEqual([1]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('applyPostCommitEffects', () => {
  const base = { db: {} as never, serverId: 's', pluginId: 'p', pluginName: 'P', sessionId: 'sess', storage: { old: 1 } };

  it('writes storage as one batch (the final value per key), then posts chat, in order', async () => {
    await applyPostCommitEffects({
      ...base,
      effects: [
        { type: 'storage.set', key: 'a', value: 1 },
        { type: 'chat.post', text: 'first' },
        { type: 'storage.set', key: 'a', value: 2 },
        { type: 'storage.delete', key: 'old' },
        { type: 'chat.post', text: 'second' },
      ],
    });
    expect(db.writePluginDataBatch).toHaveBeenCalledTimes(1);
    expect(db.writePluginDataBatch.mock.calls[0]![3]).toEqual([
      { key: 'a', value: 2 },
      { key: 'old', delete: true },
    ]);
    expect(postAppMessage.mock.calls.map((call) => call[0].text)).toEqual(['first', 'second']);
    expect(db.writePluginDataBatch.mock.invocationCallOrder[0]!).toBeLessThan(postAppMessage.mock.invocationCallOrder[0]!);
  });

  it('a storage batch the database refuses (full by now, or failing) is dropped and logged; chat still goes; nothing throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.writePluginDataBatch.mockRejectedValueOnce(new db.PluginStorageFullError('full'));
    postAppMessage.mockRejectedValueOnce(new Error('db down'));
    await expect(
      applyPostCommitEffects({
        ...base,
        effects: [
          { type: 'storage.set', key: 'a', value: 1 },
          { type: 'chat.post', text: 'x' },
          { type: 'chat.post', text: 'y' },
        ],
      })
    ).resolves.toBeUndefined();
    expect(postAppMessage).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('runDueTimers', () => {
  const NOW = 10_000;

  it('drops a timer whose action throws or whose effects are refused, and runs the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const p = plugin({
      handleAction: (_c, state, action) => {
        const a = action as { type: string; label: string };
        seen.push(a.label);
        if (a.label === 'boom') throw new Error('boom');
        if (a.label === 'bad') return withEffects(state, [{ type: 'storage.set', key: 'k', value: 1 }]);
        return { ...(state as object), [a.label]: true };
      },
    });
    const out = await runDueTimers({
      plugin: p,
      state: {},
      timers: [
        { id: '1', at: 1_000, action: { type: 'tick', label: 'boom' } },
        { id: '2', at: 2_000, action: { type: 'tick', label: 'bad' } },
        { id: '3', at: 3_000, action: { type: 'tick', label: 'ok' } },
      ],
      storage: {},
      now: NOW,
      ctx: ctx(),
    });
    expect(seen).toEqual(['boom', 'bad', 'ok']);
    expect(out).toMatchObject({ fired: 3, state: { ok: true }, timers: [], stateChanged: true, timersChanged: true });
    warn.mockRestore();
    error.mockRestore();
  });

  it('a timer whose action is no longer a system action (the plugin was upgraded) is dropped without running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handleAction = vi.fn((_c: unknown, s: unknown) => s);
    const out = await runDueTimers({
      plugin: plugin({ handleAction, actionPolicies: { tick: { role: 'host' } } }),
      state: {},
      timers: [{ id: '1', at: 1_000, action: { type: 'tick' } }],
      storage: {},
      now: NOW,
      ctx: ctx(),
    });
    expect(handleAction).not.toHaveBeenCalled();
    expect(out).toMatchObject({ fired: 1, timers: [] });
    warn.mockRestore();
  });

  it('a chain that keeps re-arming stops at the per-touch bound; the rest fires on the next touch', async () => {
    const p = plugin({
      handleAction: (c, state) =>
        withEffects({ n: ((state as { n?: number }).n ?? 0) + 1 }, [
          { type: 'timer.set', id: 'loop', afterMs: 1_000, action: { type: 'tick' } },
        ]),
    });
    const out = await runDueTimers({
      plugin: p,
      state: {},
      timers: [{ id: 'loop', at: 0, action: { type: 'tick' } }],
      storage: {},
      now: 1_000_000,
      ctx: ctx(),
      maxFirings: 5,
    });
    expect(out.fired).toBe(5);
    expect(out.state).toEqual({ n: 5 });
    expect(out.timers).toEqual([{ id: 'loop', at: 5_000, action: { type: 'tick' } }]);
  });

  it('reads stored timers defensively and reports due times only', () => {
    const timers = readStoredTimers([
      { id: 'b', at: 2_000, action: { type: 'tick', secret: 'x' } },
      { id: 'a', at: 1_000, action: { type: 'tick' } },
      { id: 'bad', at: 'soon', action: { type: 'tick' } },
      { id: 'bad2', at: 3_000, action: 'tick' },
      'junk',
    ]);
    expect(timers.map((t) => t.id)).toEqual(['b', 'a']);
    expect(timersDueAtJson(timers)).toEqual([new Date(1_000).toISOString(), new Date(2_000).toISOString()]);
    expect(readStoredTimers(null)).toEqual([]);
  });
});
