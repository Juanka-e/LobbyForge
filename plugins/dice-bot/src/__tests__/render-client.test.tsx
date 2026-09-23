import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DICE_DIE_SIZES,
  DICE_MAX_SIDES,
  DICE_MIN_SIDES,
  diceBotPlugin,
  type DiceState,
} from '../index.js';

/**
 * Regression guard (Hushle shipped this bug once and it took the whole
 * voice room down).
 *
 * `renderClient` must RETURN an element. Calling `DicePanel(props)` as a
 * plain function appends the panel's hooks to whatever component invoked
 * renderClient; the host mounts the panel conditionally, so the hook
 * count changes between renders and React throws #310.
 *
 * An element can also be asserted on without a DOM, which is why this
 * test runs in the `node` environment like the rest of the suite.
 */
describe('dice-bot renderClient', () => {
  const state: DiceState = {
    enabled: true,
    lastRoll: { playerId: 'user-2', sides: 20, value: 17, at: new Date().toISOString() },
    history: [{ playerId: 'user-2', sides: 20, value: 17, at: new Date().toISOString() }],
    stats: { 'user-2': { rolls: 1, sum: 17, best: 17 } },
  };

  const props = {
    state,
    dispatch: () => {},
    actorUserId: 'user-1',
    hostUserId: 'user-1',
    players: [
      { userId: 'user-1', name: 'Host' },
      { userId: 'user-2', name: 'Roller' },
    ],
    cardPacks: [],
  };

  it('returns a React element, never the result of invoking the component', () => {
    const output = diceBotPlugin.renderClient(props as never);
    expect(isValidElement(output)).toBe(true);
  });

  it('does not run the panel body at call time (no hooks leak into the caller)', () => {
    // Calling renderClient outside a React render must not throw. It
    // would if the panel body — and therefore useState — executed here.
    expect(() => diceBotPlugin.renderClient(props as never)).not.toThrow();
  });

  it('renders for a non-host viewer of a fresh, empty, disabled session too', () => {
    const empty = diceBotPlugin.createInitialState(null as never);
    const output = diceBotPlugin.renderClient({
      ...props,
      state: { ...empty, enabled: false },
      actorUserId: 'user-9',
      hostUserId: 'user-1',
      players: [],
    } as never);
    expect(isValidElement(output)).toBe(true);
  });

  it('only offers die sizes the reducer accepts without clamping', () => {
    expect(DICE_DIE_SIZES.length).toBeGreaterThan(0);
    for (const sides of DICE_DIE_SIZES) {
      expect(Number.isInteger(sides)).toBe(true);
      expect(Math.min(DICE_MAX_SIDES, Math.max(DICE_MIN_SIDES, sides))).toBe(sides);
      // And the reducer must actually honour the request.
      const next = diceBotPlugin.handleAction(
        null as never,
        diceBotPlugin.createInitialState(null as never),
        { type: 'roll', playerId: 'user-1', sides }
      );
      expect(next.lastRoll!.sides).toBe(sides);
    }
  });
});
