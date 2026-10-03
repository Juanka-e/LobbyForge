import { afterEach, describe, expect, it, vi } from 'vitest';
import { hushlePlugin, type HushleState } from '../index';
import { secureRandom } from '../random';
import { splitIntoTeams } from '../ui/model';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';

/**
 * Security follow-up: card draws, team ids and the room split come from
 * the platform CSPRNG, never `Math.random` (whose state can be recovered
 * from the cards already seen, predicting the next ones).
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('hushle randomness', () => {
  it('secureRandom returns floats in [0, 1) from crypto.getRandomValues', () => {
    const crypto = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const math = vi.spyOn(Math, 'random');
    for (let i = 0; i < 200; i += 1) {
      const value = secureRandom();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(crypto).toHaveBeenCalledTimes(200);
    expect(math).not.toHaveBeenCalled();
  });

  it('draws cards and mints team ids without Math.random', async () => {
    const math = vi.spyOn(Math, 'random');
    const crypto = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const harness = createTestHarness<HushleState, Parameters<typeof hushlePlugin.handleAction>[2]>({
      plugin: hushlePlugin,
      players: ['p1', 'p2', 'p3', 'p4'],
    });
    await harness.startGame();
    await harness.performAction('p1', { type: 'start-game', packId: 'hushle-en-basic', createdBy: 'p1' });
    await harness.performAction('p1', {
      type: 'set-teams',
      teams: [
        { name: 'A', playerIds: ['p1', 'p2'] },
        { name: 'B', playerIds: ['p3', 'p4'] },
      ],
    });
    const teams = harness.getState().teams;
    expect(teams.map((t) => t.id)).toEqual([expect.stringMatching(/^team-[0-9a-z]{8}$/), expect.stringMatching(/^team-[0-9a-z]{8}$/)]);
    await harness.performAction('p1', { type: 'start-turn', teamId: teams[0]!.id, explainerId: 'p1' });
    await harness.performAction('p1', { type: 'next-card' });
    expect(harness.getState().currentCard).not.toBeNull();
    expect(math).not.toHaveBeenCalled();
    expect(crypto).toHaveBeenCalled();
  });

  it('splits the room with the CSPRNG by default, and an injected rng still pins it', () => {
    const math = vi.spyOn(Math, 'random');
    const split = splitIntoTeams(['a', 'b', 'c', 'd', 'e'], 4, ['Ice', 'Amber']);
    expect(split.teams.flatMap((t) => t.playerIds).length).toBe(4);
    expect(math).not.toHaveBeenCalled();
    const pinned = splitIntoTeams(['a', 'b', 'c', 'd'], 2, ['Ice', 'Amber'], () => 0);
    expect(pinned).toEqual(splitIntoTeams(['a', 'b', 'c', 'd'], 2, ['Ice', 'Amber'], () => 0));
  });
});
