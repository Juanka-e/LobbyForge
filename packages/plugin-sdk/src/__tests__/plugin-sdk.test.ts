import { describe, it, expect } from 'vitest';
import { GamePlugin, GamePluginContext, PluginPermission } from '../index.js';
import { createTestHarness } from '../testing.js';

interface MockState {
  score: number;
  phase: 'lobby' | 'playing' | 'ended';
}

type MockAction = { type: 'increment' } | { type: 'end' };

const mockPlugin: GamePlugin<MockState, MockAction> = {
  manifest: {
    id: 'mock-plugin',
    name: 'Mock Plugin',
    version: '1.0.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [PluginPermission.MANAGE_SCORES],
    locales: ['en'],
    entryClient: './client.js',
  },
  createInitialState: (_ctx: GamePluginContext<MockState>): MockState => ({
    score: 0,
    phase: 'lobby',
  }),
  handleAction: (
    _ctx: GamePluginContext<MockState>,
    state: MockState,
    action: MockAction
  ): MockState => {
    switch (action.type) {
      case 'increment':
        return { ...state, score: state.score + 1 };
      case 'end':
        return { ...state, phase: 'ended' };
      default:
        return state;
    }
  },
  renderClient: () => null,
};

describe('plugin-sdk and createTestHarness', () => {
  it('should initialize and process actions correctly using test harness', async () => {
    const harness = createTestHarness({
      plugin: mockPlugin,
      players: ['player1', 'player2'],
    });

    await harness.startGame();
    expect(harness.getState()).toEqual({ score: 0, phase: 'lobby' });

    await harness.performAction('player1', { type: 'increment' });
    expect(harness.getState().score).toBe(1);

    await harness.performAction('player2', { type: 'end' });
    expect(harness.getState().phase).toBe('ended');
  });

  it('should throw error when accessing state before game start', () => {
    const harness = createTestHarness({
      plugin: mockPlugin,
      players: ['player1'],
    });

    expect(() => harness.getState()).toThrow('Game has not started yet. Call startGame() first.');
  });
});
