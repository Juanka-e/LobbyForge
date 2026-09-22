import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { hushlePlugin } from '../index';
import { createHushleInitialState } from '../state';

/**
 * beta-review regression guard.
 *
 * `renderClient` used to CALL the panel component as a plain function:
 *   renderClient: (props) => HushlePanel(props)
 * The panel's hooks then belonged to whatever component invoked
 * renderClient. The room mounts it conditionally, so the hook count
 * changed between renders and React threw #310, taking the whole voice
 * room down to its error boundary as soon as an activity loaded.
 *
 * Returning an ELEMENT gives the panel its own instance and its own
 * hooks — and an element can be asserted on without a DOM.
 */
describe('hushle renderClient', () => {
  const props = {
    state: createHushleInitialState(),
    dispatch: () => {},
    actorUserId: 'user-1',
    hostUserId: 'user-1',
    players: [{ userId: 'user-1', name: 'Host' }],
    cardPacks: [],
  };

  it('returns a React element, never the result of invoking the component', () => {
    const output = hushlePlugin.renderClient(props as never);
    expect(isValidElement(output)).toBe(true);
  });

  it('does not run the panel body at call time (no hooks leak into the caller)', () => {
    // Calling renderClient outside a React render must not throw. It
    // would if the panel body — and therefore useState — executed here.
    expect(() => hushlePlugin.renderClient(props as never)).not.toThrow();
  });
});
