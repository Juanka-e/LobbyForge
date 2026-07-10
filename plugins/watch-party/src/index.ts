import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { PluginPermission } from '@lobbyforge/plugin-sdk';

export interface WatchPartyState {
  videoId: string | null;
  isPlaying: boolean;
  positionSeconds: number;
  hostId: string | null;
  participants: string[];
}

export type WatchPartyAction =
  | { type: 'set-video'; videoId: string; hostId: string }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; seconds: number }
  | { type: 'join'; playerId: string }
  | { type: 'leave'; playerId: string }
  | { type: 'end' };

export const watchPartyPlugin: GamePlugin<WatchPartyState, WatchPartyAction> = {
  manifest: {
    id: 'watch-party',
    name: 'Watch Party',
    version: '0.1.0',
    type: 'activity',
    minAppVersion: '0.1.0',
    permissions: [
      PluginPermission.MANAGE_GAME_SESSION,
      PluginPermission.SEND_DATA_CHANNEL_EVENT,
      PluginPermission.USE_VOICE_STATE,
    ],
    locales: ['en', 'tr'],
    entryClient: './client.js',
    catalog: {
      category: 'game',
      summary: 'Synchronized media activity for shared viewing sessions.',
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: 1,
        maxPlayers: 50,
        defaultMaxPlayers: 20,
        supportsSpectators: true,
        supportsQueue: false,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: true,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.1.0',
      tags: ['watch-party', 'media', 'voice'],
    },
  },
  actionPolicies: {
    'set-video': { role: 'host', actorFields: ['hostId'] },
    play: { role: 'host' },
    pause: { role: 'host' },
    seek: { role: 'host' },
    join: { role: 'member', actorFields: ['playerId'] },
    leave: { role: 'member', actorFields: ['playerId'] },
    end: { role: 'host' },
  },
  createInitialState: () => ({
    videoId: null,
    isPlaying: false,
    positionSeconds: 0,
    hostId: null,
    participants: [],
  }),
  handleAction: (_ctx, state, action) => {
    switch (action.type) {
      case 'set-video':
        return { ...state, videoId: action.videoId, hostId: action.hostId, positionSeconds: 0, isPlaying: false };
      case 'play':
        return { ...state, isPlaying: true };
      case 'pause':
        return { ...state, isPlaying: false };
      case 'seek':
        return { ...state, positionSeconds: Math.max(0, action.seconds) };
      case 'join':
        return state.participants.includes(action.playerId)
          ? state
          : { ...state, participants: [...state.participants, action.playerId] };
      case 'leave':
        return { ...state, participants: state.participants.filter((id) => id !== action.playerId) };
      case 'end':
        return { ...state, videoId: null, isPlaying: false, participants: [] };
      default:
        return state;
    }
  },
  renderClient: () => null,
};
