import { describe, expect, it } from 'vitest';
import {
  diceBotPlugin,
  diceValidateAction,
  diceLeader,
  rollDie,
  DICE_MAX_SIDES,
  DICE_MIN_SIDES,
  DICE_HISTORY_LIMIT,
  type DiceState,
} from '../index.js';

function initial(): DiceState {
  return diceBotPlugin.createInitialState(null as never);
}

function roll(state: DiceState, playerId: string, sides?: number): DiceState {
  return diceBotPlugin.handleAction(null as never, state, { type: 'roll', playerId, sides });
}

describe('dice bot — roll semantics', () => {
  it('rolls in range and clamps sides to the supported window', () => {
    let state = initial();
    for (let i = 0; i < 50; i += 1) {
      state = roll(state, 'p1');
      expect(state.lastRoll!.value).toBeGreaterThanOrEqual(1);
      expect(state.lastRoll!.value).toBeLessThanOrEqual(6);
      expect(state.lastRoll!.sides).toBe(6);
    }
    state = roll(state, 'p1', 1); // below minimum → clamped to 2
    expect(state.lastRoll!.sides).toBe(DICE_MIN_SIDES);
    state = roll(state, 'p1', 1000); // above maximum → clamped to 100
    expect(state.lastRoll!.sides).toBe(DICE_MAX_SIDES);
  });

  it('accumulates per-player stats (count, sum, best) independently', () => {
    let state = initial();
    const values: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      state = roll(state, 'p1');
      values.push(state.lastRoll!.value);
    }
    state = roll(state, 'p2'); // other player
    const p1 = state.stats['p1'];
    expect(p1.rolls).toBe(10);
    expect(p1.sum).toBe(values.reduce((a, b) => a + b, 0));
    expect(p1.best).toBe(Math.max(...values));
    expect(state.stats['p2'].rolls).toBe(1);
  });

  it('history is newest-first and capped', () => {
    let state = initial();
    for (let i = 0; i < DICE_HISTORY_LIMIT + 10; i += 1) state = roll(state, 'p1');
    expect(state.history.length).toBe(DICE_HISTORY_LIMIT);
    expect(state.history[0]).toEqual(state.lastRoll);
  });
});

describe('dice bot — host moderation', () => {
  // beta-review: `reset-stats` used to clear the roll log and the last
  // roll as well, which its name does not say. Wiping the scoreboard is
  // a different intent from erasing what was rolled, so they are two
  // actions and this test pins the separation.
  it('reset-stats clears the scores and leaves the roll log alone', () => {
    let state = initial();
    state = roll(state, 'p1');
    state = roll(state, 'p1');
    const historyBefore = state.history;
    const lastBefore = state.lastRoll;

    state = diceBotPlugin.handleAction(null as never, state, { type: 'reset-stats', hostId: 'h' });
    expect(state.stats).toEqual({});
    expect(state.history).toEqual(historyBefore);
    expect(state.lastRoll).toEqual(lastBefore);
  });

  it('clear-history clears the roll log and leaves the scores alone', () => {
    let state = initial();
    state = roll(state, 'p1');
    state = roll(state, 'p1');
    const statsBefore = state.stats;

    state = diceBotPlugin.handleAction(null as never, state, { type: 'clear-history', hostId: 'h' });
    expect(state.history).toEqual([]);
    expect(state.lastRoll).toBeNull();
    expect(state.stats).toEqual(statsBefore);
  });

  it('set-enabled lands on the value asked for, however often it is sent', () => {
    // `toggle` flips whatever the reducer currently holds, so a host
    // acting on a stale snapshot — or two hosts pressing at once —
    // could end up with rolling on when they both asked for off.
    let state = initial();
    state = diceBotPlugin.handleAction(null as never, state, { type: 'set-enabled', hostId: 'h', enabled: false });
    expect(state.enabled).toBe(false);
    state = diceBotPlugin.handleAction(null as never, state, { type: 'set-enabled', hostId: 'h2', enabled: false });
    expect(state.enabled).toBe(false);

    state = roll(state, 'p1'); // rolling is off — ignored
    expect(state.lastRoll).toBeNull();

    state = diceBotPlugin.handleAction(null as never, state, { type: 'set-enabled', hostId: 'h', enabled: true });
    expect(state.enabled).toBe(true);
  });

  it('rejects a set-enabled with no value rather than guessing one', () => {
    const state = initial();
    const next = diceBotPlugin.handleAction(null as never, state, {
      type: 'set-enabled',
      hostId: 'h',
    } as never);
    expect(next).toEqual(state);
  });

  it('still supports toggle for callers that have not migrated', () => {
    let state = initial();
    state = diceBotPlugin.handleAction(null as never, state, { type: 'toggle', hostId: 'h' });
    expect(state.enabled).toBe(false);
    state = diceBotPlugin.handleAction(null as never, state, { type: 'toggle', hostId: 'h' });
    expect(state.enabled).toBe(true);
  });
});

describe('dice bot — helpers + manifest', () => {
  it('rollDie is uniform-bounded; leader tracks the best single roll', () => {
    for (let i = 0; i < 100; i += 1) {
      const v = rollDie(20);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
    let state = initial();
    state = roll(state, 'p1');
    const best1 = state.stats['p1'].best;
    state = roll(state, 'p2');
    const leader = diceLeader(state);
    expect(leader).not.toBeNull();
    expect(['p1', 'p2']).toContain(leader!.playerId);
    expect(leader!.best).toBe(Math.max(best1, state.stats['p2'].best));
  });

  it('manifest and policies follow the SDK contract', () => {
    expect(diceBotPlugin.manifest.id).toBe('dice-bot');
    expect(diceBotPlugin.manifest.type).toBe('utility');
    expect(diceBotPlugin.actionPolicies?.roll).toEqual({ role: 'member', actorFields: ['playerId'] });
    expect(diceBotPlugin.actionPolicies?.['reset-stats']).toEqual({ role: 'host', actorFields: ['hostId'] });
    // Every host-only action must be gated, or a member could clear the
    // room's scoreboard.
    expect(diceBotPlugin.actionPolicies?.['clear-history']).toEqual({ role: 'host', actorFields: ['hostId'] });
    expect(diceBotPlugin.actionPolicies?.['set-enabled']).toEqual({ role: 'host', actorFields: ['hostId'] });
  });
});

describe('dice bot — validateAction (malformed HTTP payloads)', () => {
  it('rejects non-integer, non-finite and non-number sides before the reducer', () => {
    expect(diceValidateAction({ type: 'roll', playerId: 'p', sides: 6.5 })).toContain('integer');
    expect(diceValidateAction({ type: 'roll', playerId: 'p', sides: 'foo' })).toContain('integer');
    expect(diceValidateAction({ type: 'roll', playerId: 'p', sides: {} })).toContain('integer');
    expect(diceValidateAction({ type: 'roll', playerId: 'p', sides: Number.NaN })).toContain('integer');
    expect(diceValidateAction({ type: 'roll', playerId: 'p' })).toBeNull(); // default d6
    expect(diceValidateAction({ type: 'roll', playerId: 'p', sides: 20 })).toBeNull();
  });

  it('rejects non-string ids, unknown types, non-object actions', () => {
    expect(diceValidateAction({ type: 'roll', playerId: 42 })).toContain('playerId');
    expect(diceValidateAction({ type: 'roll' })).toContain('playerId');
    expect(diceValidateAction({ type: 'loaded-dice', hostId: 'h' })).toContain('Unknown action');
    expect(diceValidateAction('roll')).toContain('object');
    expect(diceValidateAction(null)).toContain('object');
  });

  it('the reducer ignores anything validateAction rejects (defense in depth)', () => {
    const state = initial();
    // Even if a malformed action reached the reducer, no NaN enters state.
    const malformed = { type: 'roll', playerId: 'p1', sides: 'foo' } as never;
    const next = diceBotPlugin.handleAction(null as never, state, malformed);
    expect(next).toBe(state);
    expect(JSON.stringify(next)).not.toContain('NaN');
  });
});
