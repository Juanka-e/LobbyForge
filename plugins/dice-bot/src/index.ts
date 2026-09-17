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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 31st-audit runtime guard: the activity API only validates { type } at
 * its boundary, so `sides` arrives as raw JSON — "6.5" must not slip
 * through the clamp (Math.random()*6.5 can roll a 7), and strings or
 * objects must not become NaN in state.
 */
export function diceValidateAction(action: unknown): string | null {
  if (!isRecord(action)) return 'Action must be an object.';
  switch (action.type) {
    case 'roll': {
      if (typeof action.playerId !== 'string' || action.playerId.length === 0) {
        return 'roll requires a playerId string.';
      }
      if (action.sides === undefined) return null; // default d6
      if (typeof action.sides !== 'number' || !Number.isFinite(action.sides) || !Number.isInteger(action.sides)) {
        return 'sides must be an integer.';
      }
      return null;
    }
    case 'reset-stats':
    case 'toggle':
      if (typeof action.hostId !== 'string' || action.hostId.length === 0) {
        return `${String(action.type)} requires a hostId string.`;
      }
      return null;
    default:
      return `Unknown action type: ${String(action.type)}`;
  }
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
  validateAction: diceValidateAction,
  handleAction: (_ctx, state, action) => {
    // Defense in depth: validateAction guards the API boundary, but the
    // reducer never trusts shape either.
    if (diceValidateAction(action) !== null) return state;
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
