import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { PluginPermission } from '@lobbyforge/plugin-sdk';

export type VillagePhase = 'setup' | 'day' | 'night' | 'ended';
export type VillageRole = 'villager' | 'werewolf' | 'seer' | 'doctor';

export interface VillagePlayer {
  id: string;
  name: string;
  role: VillageRole | null;
  alive: boolean;
}

export interface VampireState {
  phase: VillagePhase;
  round: number;
  players: VillagePlayer[];
  votes: Record<string, string>;
  lastEliminatedId: string | null;
}

export type VampireAction =
  | { type: 'assign-roles'; roles: Record<string, VillageRole> }
  | { type: 'start-night' }
  | { type: 'start-day' }
  | { type: 'vote'; voterId: string; targetId: string }
  | { type: 'resolve-day'; eliminatedId: string }
  | { type: 'end' };

export const vampireVillagePlugin: GamePlugin<VampireState, VampireAction> = {
  manifest: {
    id: 'vampire-village',
    name: 'Vampire Village',
    version: '0.1.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [
      PluginPermission.MANAGE_GAME_SESSION,
      PluginPermission.MANAGE_SCORES,
      PluginPermission.SEND_ROOM_MESSAGE,
      PluginPermission.MANAGE_TIMER,
      PluginPermission.SEND_DATA_CHANNEL_EVENT,
    ],
    locales: ['en', 'tr'],
    entryClient: './client.js',
    catalog: {
      category: 'game',
      summary: 'Social deduction with night/day phases and hidden roles.',
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: 5,
        maxPlayers: 18,
        defaultMaxPlayers: 10,
        supportsSpectators: true,
        supportsQueue: true,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: true,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.1.0',
      tags: ['social-deduction', 'roles', 'voice'],
    },
  },
  actionPolicies: {
    'assign-roles': { role: 'host' },
    'start-night': { role: 'host' },
    'start-day': { role: 'host' },
    vote: { role: 'player', actorFields: ['voterId'] },
    'resolve-day': { role: 'host' },
    end: { role: 'host' },
  },
  createInitialState: (ctx) => ({
    phase: 'setup',
    round: 0,
    players: ctx.players.list().map((id) => ({
      id,
      name: ctx.players.get(id)?.name ?? id,
      role: null,
      alive: true,
    })),
    votes: {},
    lastEliminatedId: null,
  }),
  handleAction: (_ctx, state, action) => {
    switch (action.type) {
      case 'assign-roles':
        return {
          ...state,
          players: state.players.map((p) => ({
            ...p,
            role: action.roles[p.id] ?? null,
          })),
        };
      case 'start-night':
        return { ...state, phase: 'night', round: state.round + 1, votes: {} };
      case 'start-day':
        return { ...state, phase: 'day' };
      case 'vote':
        return { ...state, votes: { ...state.votes, [action.voterId]: action.targetId } };
      case 'resolve-day':
        return {
          ...state,
          phase: 'day',
          lastEliminatedId: action.eliminatedId,
          players: state.players.map((p) =>
            p.id === action.eliminatedId ? { ...p, alive: false } : p
          ),
        };
      case 'end':
        return { ...state, phase: 'ended' };
      default:
        return state;
    }
  },
  renderClient: () => null,
};
