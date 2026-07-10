import { describe, it, expect } from 'vitest';
import { watchPartyPlugin, type WatchPartyState } from '../index.js';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';

describe('@lobbyforge/watch-party', () => {
  it('joins, plays, and seeks correctly', async () => {
    const harness = createTestHarness<WatchPartyState, Parameters<typeof watchPartyPlugin.handleAction>[2]>({
      plugin: watchPartyPlugin,
      players: ['p1', 'p2', 'p3'],
    });

    await harness.startGame();

    await harness.performAction('p1', { type: 'set-video', videoId: 'vid-42', hostId: 'p1' });
    expect(harness.getState().videoId).toBe('vid-42');
    expect(harness.getState().hostId).toBe('p1');

    await harness.performAction('p2', { type: 'join', playerId: 'p2' });
    await harness.performAction('p3', { type: 'join', playerId: 'p3' });
    expect(harness.getState().participants).toEqual(['p2', 'p3']);

    await harness.performAction('p1', { type: 'play' });
    expect(harness.getState().isPlaying).toBe(true);

    await harness.performAction('p1', { type: 'seek', seconds: 120 });
    expect(harness.getState().positionSeconds).toBe(120);

    await harness.performAction('p2', { type: 'leave', playerId: 'p2' });
    expect(harness.getState().participants).toEqual(['p3']);

    await harness.performAction('p1', { type: 'end' });
    expect(harness.getState().videoId).toBeNull();
  });
});
