import { describe, it, expect } from 'vitest';
import { vampireVillagePlugin, type VampireState, type VillagePlayer } from '../index.js';
import { createTestHarness } from '@lobbyforge/plugin-sdk/testing';

const players: VillagePlayer[] = [
  { id: 'p1', name: 'Alice', role: null, alive: true },
  { id: 'p2', name: 'Bob', role: null, alive: true },
  { id: 'p3', name: 'Carol', role: null, alive: true },
];

describe('@lobbyforge/vampire-village', () => {
  it('runs a full day/night cycle with role assignment and elimination', async () => {
    const harness = createTestHarness<VampireState, Parameters<typeof vampireVillagePlugin.handleAction>[2]>({
      plugin: vampireVillagePlugin,
      players: players.map((p) => p.id),
    });

    await harness.startGame();

    // seed players list manually via assign-roles (we need a richer initial state)
    await harness.performAction('p1', {
      type: 'assign-roles',
      roles: { p1: 'werewolf', p2: 'seer', p3: 'villager' },
    });

    await harness.performAction('p1', { type: 'start-night' });
    expect(harness.getState().phase).toBe('night');
    expect(harness.getState().round).toBe(1);

    await harness.performAction('p1', { type: 'start-day' });
    await harness.performAction('p2', { type: 'vote', voterId: 'p2', targetId: 'p1' });
    await harness.performAction('p1', { type: 'resolve-day', eliminatedId: 'p1' });
    const eliminated = harness.getState().players.find((p) => p.id === 'p1');
    expect(eliminated?.alive).toBe(false);
    expect(harness.getState().lastEliminatedId).toBe('p1');

    await harness.performAction('p1', { type: 'end' });
    expect(harness.getState().phase).toBe('ended');
  });
});
