import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { WatchPartyPanel, watchPartyPlugin } from '../index';
import { createWatchPartyInitialState } from '../state';

/**
 * Regression guard, as in Hushle and Poll: `renderClient` must RETURN an
 * element, not CALL the panel. Called as a plain function, the panel's
 * hooks would belong to whatever component invoked renderClient; the host
 * mounts it conditionally, so the hook count changes between renders and
 * React throws #310, taking the whole lobby view down.
 */

const props = {
  state: createWatchPartyInitialState({ hostId: 'user-1', now: 0 }),
  dispatch: () => {},
  actorUserId: 'user-1',
  hostUserId: 'user-1',
  players: [{ userId: 'user-1', name: 'Host' }],
};

describe('watch party renderClient', () => {
  it('returns an element of the panel, never the result of invoking it', () => {
    const output = watchPartyPlugin.renderClient(props as never);
    expect(isValidElement(output)).toBe(true);
    expect((output as { type: unknown }).type).toBe(WatchPartyPanel);
  });

  it('does not run the panel body at call time (no hooks leak into the caller)', () => {
    expect(() => watchPartyPlugin.renderClient(props as never)).not.toThrow();
  });

  it('accepts whatever state the host delivers — the panel normalises it', () => {
    for (const state of [null, {}, { videoId: 'aaaaaaaaaaa' }, 'junk']) {
      expect(isValidElement(watchPartyPlugin.renderClient({ ...props, state } as never))).toBe(true);
    }
  });
});
