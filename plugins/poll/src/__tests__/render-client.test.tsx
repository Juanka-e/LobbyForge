import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { pollPlugin } from '../index';
import type { PollState, PollViewState } from '../index';

/**
 * Regression guard, copied from Hushle.
 *
 * `renderClient` must RETURN an element, not CALL the panel:
 *   renderClient: (props) => PollPanel(props)   // ← wrong
 * The panel's hooks would then belong to whatever component invoked
 * renderClient. The room mounts it conditionally, so the hook count
 * changes between renders and React throws #310, taking the whole
 * voice room down to its error boundary as soon as an activity loads.
 *
 * Returning an ELEMENT gives the panel its own instance and its own
 * hooks — and an element can be asserted on without a DOM.
 */

/** What a viewer actually receives: ballotBox stripped server-side. */
function viewState(overrides: Partial<PollViewState> = {}): PollViewState {
  const canonical = pollPlugin.createInitialState(null as never) as PollState;
  const { ballotBox: _ballotBox, ...rest } = canonical;
  return { ...rest, ballotCount: 0, hasVoted: false, ...overrides };
}

const baseProps = {
  state: viewState(),
  dispatch: () => {},
  actorUserId: 'user-1',
  hostUserId: 'user-1',
  players: [{ userId: 'user-1', name: 'Host' }],
  cardPacks: [],
};

describe('poll renderClient', () => {
  it('returns a React element, never the result of invoking the component', () => {
    const output = pollPlugin.renderClient(baseProps as never);
    expect(isValidElement(output)).toBe(true);
  });

  it('does not run the panel body at call time (no hooks leak into the caller)', () => {
    // Calling renderClient outside a React render must not throw. It
    // would if the panel body — and therefore useState — executed here.
    expect(() => pollPlugin.renderClient(baseProps as never)).not.toThrow();
  });

  it.each(['idle', 'open', 'closed'] as const)('renders an element in the %s phase', (phase) => {
    const props = {
      ...baseProps,
      state: viewState({
        phase,
        question: phase === 'idle' ? null : 'Next game?',
        options:
          phase === 'idle'
            ? []
            : [
                { id: 'opt-1', text: 'Hushle', votes: 2 },
                { id: 'opt-2', text: 'Quiz', votes: 1 },
              ],
        ballotCount: phase === 'idle' ? 0 : 3,
        hasVoted: phase !== 'idle',
      }),
    };
    expect(isValidElement(pollPlugin.renderClient(props as never))).toBe(true);
  });

  it('never asks the viewer state for a ballot box (anonymity guarantee)', () => {
    // A `PollViewState` has no `ballotBox`; if the panel ever reached
    // for one the type would stop compiling, and this asserts the
    // projection the host actually hands over.
    expect(viewState()).not.toHaveProperty('ballotBox');
  });
});
