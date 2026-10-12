/**
 * Host effects (effects.ts): the envelope, the validation the host runs on
 * every effect, the timer and storage rules, and the testing harness that
 * runs them the same way.
 */
import { describe, expect, it } from 'vitest';
import {
  EFFECT_LIMITS,
  applyStorageEffects,
  applyTimerEffects,
  createStorageSnapshot,
  isEffectsEnvelope,
  nextDueTimer,
  storageBytes,
  storageSnapshotEntries,
  unwrapReducerResult,
  validateEffects,
  withEffects,
  type GamePlugin,
  type GamePluginContext,
  type ReducerResult,
  type ValidEffect,
} from '../index.js';
import { EffectRefusedError, createTestHarness } from '../testing.js';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const ALL = { permissions: ['timers', 'storage', 'chat'], systemActions: ['tick', 'auto-reveal'], now: NOW };

describe('the envelope', () => {
  it('withEffects wraps the state; unwrap reads it back; a plain state has no effects', () => {
    const state = { a: 1 };
    const wrapped = withEffects(state, [{ type: 'chat.post', text: 'hi' }]);
    expect(wrapped).toEqual({ __lf: 1, state, effects: [{ type: 'chat.post', text: 'hi' }] });
    expect(isEffectsEnvelope(wrapped)).toBe(true);
    expect(unwrapReducerResult(wrapped).state).toBe(state);
    expect(unwrapReducerResult(state)).toEqual({ state, effects: [] });
    expect(isEffectsEnvelope({ __lf: 1 })).toBe(false);
    expect(isEffectsEnvelope([1])).toBe(false);
  });

  it('keeps the SAME state object (so "same state, no effects" still means no change)', () => {
    const state = { a: 1 };
    expect(unwrapReducerResult(withEffects(state, [])).state).toBe(state);
  });
});

describe('validateEffects', () => {
  it('resolves afterMs to an absolute due time and copies values', () => {
    const value = { best: [1, 2] };
    const result = validateEffects(
      [
        { type: 'timer.set', id: 'r1', afterMs: 1500, action: { type: 'tick', round: 2 } },
        { type: 'timer.set', id: 'r2', at: NOW + 60_000, action: { type: 'tick' } },
        { type: 'timer.clear', id: 'r0' },
        { type: 'storage.set', key: 'best', value },
        { type: 'storage.delete', key: 'old' },
        { type: 'chat.post', text: '  Team A won 12–9.  ' },
      ],
      ALL
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effects[0]).toEqual({ type: 'timer.set', id: 'r1', at: NOW + 1500, action: { type: 'tick', round: 2 } });
    expect(result.effects[1]).toMatchObject({ at: NOW + 60_000 });
    const stored = result.effects[3] as { value: unknown };
    expect(stored.value).toEqual(value);
    expect(stored.value).not.toBe(value);
    expect(result.effects[5]).toEqual({ type: 'chat.post', text: 'Team A won 12–9.' });
  });

  const refused: Array<[string, unknown, Partial<typeof ALL>?]> = [
    ['not an array', { type: 'chat.post', text: 'x' }],
    ['an unknown type', [{ type: 'voice.mute', userId: 'u1', muted: true }]],
    ['an unknown key (a typo)', [{ type: 'timer.set', id: 't', after: 1000, action: { type: 'tick' } }]],
    ['a timer without permission', [{ type: 'timer.clear', id: 't' }], { permissions: ['storage'] }],
    ['storage without permission', [{ type: 'storage.delete', key: 'k' }], { permissions: ['timers'] }],
    ['chat without permission', [{ type: 'chat.post', text: 'hi' }], { permissions: [] }],
    ['a timer under 1 s', [{ type: 'timer.set', id: 't', afterMs: 999, action: { type: 'tick' } }]],
    ['a timer over 24 h', [{ type: 'timer.set', id: 't', afterMs: EFFECT_LIMITS.maxTimerMs + 1, action: { type: 'tick' } }]],
    ['an "at" in the past', [{ type: 'timer.set', id: 't', at: NOW - 1, action: { type: 'tick' } }]],
    ['both afterMs and at', [{ type: 'timer.set', id: 't', afterMs: 2000, at: NOW + 2000, action: { type: 'tick' } }]],
    ['neither afterMs nor at', [{ type: 'timer.set', id: 't', action: { type: 'tick' } }]],
    ['a timer id with a space', [{ type: 'timer.set', id: 'a b', afterMs: 2000, action: { type: 'tick' } }]],
    ['a timer action that is not a system action', [{ type: 'timer.set', id: 't', afterMs: 2000, action: { type: 'buzz' } }]],
    ['a timer action without a type', [{ type: 'timer.set', id: 't', afterMs: 2000, action: { round: 1 } }]],
    ['a huge timer action', [{ type: 'timer.set', id: 't', afterMs: 2000, action: { type: 'tick', pad: 'x'.repeat(5000) } }]],
    ['a storage key with a slash', [{ type: 'storage.set', key: 'a/b', value: 1 }]],
    ['the storage key __proto__', [{ type: 'storage.set', key: '__proto__', value: { polluted: true } }]],
    ['a storage value that is not JSON', [{ type: 'storage.set', key: 'k', value: undefined }]],
    ['a storage.set without value', [{ type: 'storage.set', key: 'k' }]],
    ['an empty chat post', [{ type: 'chat.post', text: '   ' }]],
    ['a chat post over 500 characters', [{ type: 'chat.post', text: 'x'.repeat(501) }]],
    ['a chat post with a control character', [{ type: 'chat.post', text: 'a\u0007b' }]],
    ['too many effects', Array.from({ length: 33 }, () => ({ type: 'timer.clear', id: 't' }))],
  ];
  for (const [name, effects, rules] of refused) {
    it(`refuses ${name}`, () => {
      const result = validateEffects(effects, { ...ALL, ...rules });
      expect(result.ok).toBe(false);
    });
  }

  it('names the problem without echoing values', () => {
    const result = validateEffects([{ type: 'chat.post', text: 'secret '.repeat(100) }], ALL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret');
  });
});

function timers(...effects: ValidEffect[]) {
  return effects;
}

describe('applyTimerEffects', () => {
  const set = (id: string, at: number): ValidEffect => ({ type: 'timer.set', id, at, action: { type: 'tick' } });

  it('a set with the same id replaces; clear removes; changed reports it', () => {
    const first = applyTimerEffects([], timers(set('a', NOW + 5000), set('b', NOW + 6000)));
    expect(first.ok && first.timers.map((t) => t.id)).toEqual(['a', 'b']);
    if (!first.ok) return;
    const second = applyTimerEffects(first.timers, timers(set('a', NOW + 9000)));
    expect(second.ok && second.timers.map((t) => [t.id, t.at])).toEqual([
      ['b', NOW + 6000],
      ['a', NOW + 9000],
    ]);
    const cleared = applyTimerEffects(first.timers, timers({ type: 'timer.clear', id: 'a' }, { type: 'timer.clear', id: 'zz' }));
    expect(cleared.ok && cleared.timers.map((t) => t.id)).toEqual(['b']);
    expect(cleared.ok && cleared.changed).toBe(true);
    const nothing = applyTimerEffects(first.timers, timers({ type: 'timer.clear', id: 'zz' }));
    expect(nothing.ok && nothing.changed).toBe(false);
  });

  it('refuses a ninth pending timer, but replacing at the limit is fine', () => {
    const eight = applyTimerEffects([], Array.from({ length: 8 }, (_, i) => set(`t${i}`, NOW + 2000 + i)));
    expect(eight.ok).toBe(true);
    if (!eight.ok) return;
    expect(applyTimerEffects(eight.timers, timers(set('t9', NOW + 9999))).ok).toBe(false);
    expect(applyTimerEffects(eight.timers, timers(set('t3', NOW + 9999))).ok).toBe(true);
  });

  it('nextDueTimer picks the earliest due one, ties to the one set first', () => {
    const list = [
      { id: 'late', at: NOW + 3000, action: { type: 'tick' } },
      { id: 'first', at: NOW + 1000, action: { type: 'tick' } },
      { id: 'tie', at: NOW + 1000, action: { type: 'tick' } },
    ];
    expect(nextDueTimer(list, NOW)).toBeNull();
    expect(nextDueTimer(list, NOW + 1000)?.id).toBe('first');
    expect(nextDueTimer(list.slice(2), NOW + 5000)?.id).toBe('tie');
  });
});

describe('storage', () => {
  it('applies sets and deletes in order and reports one write per key', () => {
    const result = applyStorageEffects({ a: 1, b: 2 }, [
      { type: 'storage.set', key: 'a', value: 10 },
      { type: 'storage.delete', key: 'b' },
      { type: 'storage.set', key: 'c', value: { x: 1 } },
      { type: 'storage.set', key: 'a', value: 11 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual({ a: 11, c: { x: 1 } });
    expect(result.writes).toEqual([
      { key: 'a', value: 11 },
      { key: 'b', delete: true },
      { key: 'c', value: { x: 1 } },
    ]);
  });

  it('refuses a result over 64 KiB (keys and values counted as UTF-8 JSON)', () => {
    const big = 'x'.repeat(EFFECT_LIMITS.maxStorageBytes - 10);
    expect(storageBytes({ k: 'é' })).toBe(1 + 4); // "é" in quotes: 2 + 2 bytes
    expect(applyStorageEffects({}, [{ type: 'storage.set', key: 'k', value: big }]).ok).toBe(true);
    expect(applyStorageEffects({ other: 'x'.repeat(20) }, [{ type: 'storage.set', key: 'k', value: big }]).ok).toBe(false);
    // Deleting makes room again.
    expect(
      applyStorageEffects({ other: 'x'.repeat(20) }, [
        { type: 'storage.delete', key: 'other' },
        { type: 'storage.set', key: 'k', value: big },
      ]).ok
    ).toBe(true);
  });

  it('the snapshot is read-only: get returns copies, keys are sorted', () => {
    const snapshot = createStorageSnapshot({ b: { n: 1 }, a: 2 });
    expect(snapshot.keys()).toEqual(['a', 'b']);
    const value = snapshot.get('b') as { n: number };
    value.n = 99;
    expect(snapshot.get('b')).toEqual({ n: 1 });
    expect(snapshot.get('missing')).toBeUndefined();
    expect(snapshot.get('__proto__')).toBeUndefined();
    expect(storageSnapshotEntries(snapshot)).toEqual({ a: 2, b: { n: 1 } });
  });
});

// A tiny game: `start` opens a round with a 10 s auto-close timer; `close`
// (host) or `auto-close` (system) ends it and remembers the best round.
interface RoundState {
  open: boolean;
  round: number;
  closedBy: string | null;
  best: number;
}
type RoundAction = { type: 'start' } | { type: 'close' } | { type: 'auto-close'; round: number } | { type: 'spam' };

const roundPlugin: GamePlugin<RoundState, RoundAction, unknown, ReducerResult<RoundState>> = {
  manifest: {
    id: 'round-game',
    name: 'Round Game',
    version: '1.0.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: ['timers', 'storage', 'chat'],
    locales: ['en'],
    entryClient: './client.js',
  },
  actionPolicies: {
    start: { role: 'host' },
    close: { role: 'host' },
    'auto-close': { role: 'system' },
    spam: { role: 'host' },
  },
  createInitialState: (ctx: GamePluginContext<RoundState>) => ({
    open: false,
    round: 0,
    closedBy: null,
    best: typeof ctx.storage.get('best') === 'number' ? (ctx.storage.get('best') as number) : 0,
  }),
  handleAction: (ctx, state, action) => {
    switch (action.type) {
      case 'start':
        if (state.open) return state;
        return withEffects({ ...state, open: true, round: state.round + 1, closedBy: null }, [
          { type: 'timer.set', id: 'close', afterMs: 10_000, action: { type: 'auto-close', round: state.round + 1 } },
        ]);
      case 'close':
      case 'auto-close': {
        if (!state.open) return state;
        if (action.type === 'auto-close' && action.round !== state.round) return state;
        const best = Math.max(state.best, state.round);
        return withEffects({ ...state, open: false, closedBy: ctx.actorUserId || `system@${ctx.now}`, best }, [
          { type: 'timer.clear', id: 'close' },
          { type: 'storage.set', key: 'best', value: best },
          { type: 'chat.post', text: `Round ${state.round} closed.` },
        ]);
      }
      case 'spam':
        return withEffects(
          state,
          Array.from({ length: 9 }, (_, i) => ({ type: 'timer.set' as const, id: `s${i}`, afterMs: 5000, action: { type: 'auto-close', round: 0 } }))
        );
      default:
        return state;
    }
  },
  renderClient: () => null,
};

describe('the testing harness runs effects like the host', () => {
  it('fires a due timer as its system action with ctx.now = the due time, and applies its effects', async () => {
    const h = createTestHarness({ plugin: roundPlugin, players: ['host'], now: NOW, storage: { best: 0 } });
    await h.startGame();
    await h.performAction('host', { type: 'start' });
    expect(h.getTimers()).toEqual([{ id: 'close', at: NOW + 10_000, action: { type: 'auto-close', round: 1 } }]);
    await h.advanceTime(9_999);
    expect(h.getState().open).toBe(true);
    await h.advanceTime(5_000);
    expect(h.getState()).toMatchObject({ open: false, closedBy: `system@${NOW + 10_000}`, best: 1 });
    expect(h.now()).toBe(NOW + 14_999);
    expect(h.getTimers()).toEqual([]);
    expect(h.getStorage()).toEqual({ best: 1 });
    expect(h.getChatPosts()).toEqual(['Round 1 closed.']);
  });

  it('a manual close clears the timer; the snapshot feeds createInitialState', async () => {
    const h = createTestHarness({ plugin: roundPlugin, players: ['host'], now: NOW, storage: { best: 7 } });
    await h.startGame();
    expect(h.getState().best).toBe(7);
    await h.performAction('host', { type: 'start' });
    await h.performAction('host', { type: 'close' });
    expect(h.getTimers()).toEqual([]);
    expect(h.getState().closedBy).toBe('host');
  });

  it('refuses a system action from a client', async () => {
    const h = createTestHarness({ plugin: roundPlugin, players: ['host'], now: NOW });
    await h.startGame();
    await expect(h.performAction('host', { type: 'auto-close', round: 1 })).rejects.toThrow(/system action/);
  });

  it('an effect the host would refuse refuses the whole call: nothing applied', async () => {
    const h = createTestHarness({ plugin: roundPlugin, players: ['host'], now: NOW });
    await h.startGame();
    await expect(h.performAction('host', { type: 'spam' })).rejects.toBeInstanceOf(EffectRefusedError);
    expect(h.getTimers()).toEqual([]);

    const noPermission = createTestHarness({ plugin: roundPlugin, players: ['host'], now: NOW, permissions: ['timers'] });
    await noPermission.startGame();
    await noPermission.performAction('host', { type: 'start' });
    await expect(noPermission.performAction('host', { type: 'close' })).rejects.toThrow(/"storage" permission/);
    expect(noPermission.getState().open).toBe(true);
  });
});
