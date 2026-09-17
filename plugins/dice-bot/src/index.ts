import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { PluginPermission } from '@lobbyforge/plugin-sdk';

/**
 * Dice Bot — a bot-style utility plugin.
 *
 * Any member "rolls" from the room panel; the bot keeps per-player
 * statistics and a rolling history the room can see. It demonstrates the
 * bot-shaped use of the plugin system: conversational trigger, persistent
 * per-player stats, host-only moderation actions.
 *
 * Roll values are generated in the reducer (server-side projection) —
 * clients never supply the outcome.
 */

export const DICE_PLUGIN_ID = 'dice-bot';
export const DICE_MIN_SIDES = 2;
export const DICE_MAX_SIDES = 100;
export const DICE_HISTORY_LIMIT = 20;

export interface DiceRoll {
  playerId: string;
  sides: number;
  value: number;
  at: string;
}

export interface DiceStats {
  rolls: number;
  sum: number;
  best: number;
}

export interface DiceState {
  enabled: boolean;
  lastRoll: DiceRoll | null;
  history: DiceRoll[];
  stats: Record<string, DiceStats>;
}

export type DiceAction =
  | { type: 'roll'; playerId: string; sides?: number }
  | { type: 'reset-stats'; hostId: string }
  | { type: 'toggle'; hostId: string };

export function rollDie(sides: number): number {
  // 1..sides inclusive, uniform.
  return 1 + Math.floor(Math.random() * sides);
}

export function diceLeader(state: DiceState): { playerId: string; best: number } | null {
  let best: { playerId: string; best: number } | null = null;
  for (const [playerId, stats] of Object.entries(state.stats)) {
    if (!best || stats.best > best.best) best = { playerId, best: stats.best };
  }
  return best;
}

export const diceBotPlugin: GamePlugin<DiceState, DiceAction> = {
  manifest: {
    id: DICE_PLUGIN_ID,
    name: 'Dice Bot',
    version: '0.1.0',
    type: 'utility',
    minAppVersion: '0.1.0',
    permissions: [PluginPermission.MANAGE_GAME_SESSION, PluginPermission.SEND_ROOM_MESSAGE],
    locales: ['en', 'tr'],
    entryClient: './client.js',
    catalog: {
      category: 'utility',
      summary: 'Dice rolls with per-player stats for voice rooms.',
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: 1,
        maxPlayers: 50,
        defaultMaxPlayers: 25,
        supportsSpectators: true,
        supportsQueue: false,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: false,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.1.0',
      tags: ['dice', 'bot', 'utility'],
    },
  },
  actionPolicies: {
    roll: { role: 'member', actorFields: ['playerId'] },
    'reset-stats': { role: 'host', actorFields: ['hostId'] },
    toggle: { role: 'host', actorFields: ['hostId'] },
  },
  createInitialState: (): DiceState => ({
    enabled: true,
    lastRoll: null,
    history: [],
    stats: {},
  }),
  handleAction: (_ctx, state, action) => {
    switch (action.type) {
      case 'roll': {
        if (!state.enabled) return state;
        const sides = Math.min(DICE_MAX_SIDES, Math.max(DICE_MIN_SIDES, action.sides ?? 6));
        // The outcome is generated SERVER-side — the client only asks.
        const value = rollDie(sides);
        const roll: DiceRoll = { playerId: action.playerId, sides, value, at: new Date().toISOString() };
        const prev = state.stats[action.playerId] ?? { rolls: 0, sum: 0, best: 0 };
        return {
          ...state,
          lastRoll: roll,
          history: [roll, ...state.history].slice(0, DICE_HISTORY_LIMIT),
          stats: {
            ...state.stats,
            [action.playerId]: {
              rolls: prev.rolls + 1,
              sum: prev.sum + value,
              best: Math.max(prev.best, value),
            },
          },
        };
      }
      case 'reset-stats':
        return { ...state, stats: {}, history: [], lastRoll: null };
      case 'toggle':
        return { ...state, enabled: !state.enabled };
      default:
        return state;
    }
  },
  renderClient: () => null,
};
