import { describe, expect, it } from 'vitest';
import {
  diceBotPlugin,
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
  it('reset-stats clears stats AND history; toggle disables rolls', () => {
    let state = initial();
    state = roll(state, 'p1');
    state = roll(state, 'p1');
    state = diceBotPlugin.handleAction(null as never, state, { type: 'reset-stats', hostId: 'h' });
    expect(state.stats).toEqual({});
    expect(state.history).toEqual([]);
    expect(state.lastRoll).toBeNull();

    state = diceBotPlugin.handleAction(null as never, state, { type: 'toggle', hostId: 'h' });
    expect(state.enabled).toBe(false);
    state = roll(state, 'p1'); // bot disabled — ignored
    expect(state.lastRoll).toBeNull();
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
  });
});
