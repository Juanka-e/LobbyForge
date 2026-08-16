import type { GamePlugin } from '@lobbyforge/plugin-sdk';
import { PluginPermission } from '@lobbyforge/plugin-sdk';
import { hushleReducer } from './actions';
import { createHushleInitialState, migrateHushleState } from './state';
import type { HushleAction, HushleState } from './state';
import { HushlePanel, type HushlePanelClientProps } from './renderClient';
import { HUSHLE_PLUGIN_ID } from './plugin-id';

export type {
  HushleAction,
  HushleState,
  HushleTeam,
  HushleCard,
  HushleSettings,
  HushlePhase,
  HushleLanguage,
  HushleDifficulty,
  HushleTimer,
} from './state';

export {
  createHushleInitialState,
  migrateHushleState,
  HUSHLE_STATE_VERSION,
  HUSHLE_DEFAULT_TURN_DURATION_SECONDS,
  HUSHLE_DEFAULT_CARDS_PER_TURN,
  HUSHLE_DEFAULT_TEAM_SIZE,
  HUSHLE_DEFAULT_DIFFICULTY_DISTRIBUTION,
} from './state';
export { hushleNextExplainerForTeam } from './actions';
export { HUSHLE_PLUGIN_ID } from './plugin-id';
export {
  HUSHLE_BUILTIN_PACKS,
  getDefaultPackSlugForLanguage,
  getLanguageForPackSlug,
} from './decks';
// Server-only: the seeder imports @lobbyforge/db which transitively pulls
// in `postgres` (Node.js-only). Import via the subpath
// `@lobbyforge/hushle/builtInPacks` from server-side code only.
// `export { seedBuiltinHushlePacks } from './builtInPacks';` would crash
// the client bundle for the room page.

export const hushlePlugin: GamePlugin<HushleState, HushleAction> = {
  manifest: {
    id: HUSHLE_PLUGIN_ID,
    name: 'Hushle',
    version: '0.3.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [
      PluginPermission.MANAGE_GAME_SESSION,
      PluginPermission.MANAGE_SCORES,
      PluginPermission.SEND_ROOM_MESSAGE,
      PluginPermission.MANAGE_TIMER,
    ],
    locales: ['en', 'tr'],
    entryClient: './renderClient.js',
    catalog: {
      category: 'game',
      summary: 'Taboo-style word guessing built for live voice rooms.',
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: 4,
        maxPlayers: 12,
        defaultMaxPlayers: 8,
        supportsSpectators: true,
        supportsQueue: true,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: true,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.2.0',
      tags: ['word-game', 'party', 'voice'],
    },
  },
  actionPolicies: {
    'start-game': { role: 'host' },
    'set-teams': { role: 'host' },
    'start-turn': { role: 'host' },
    'set-explainer': { role: 'host' },
    'next-card': { role: 'host' },
    'correct-guess': { role: 'host' },
    pass: { role: 'host' },
    penalty: { role: 'host' },
    /**
     * Classic-Taboo buzzer: any player in the session may dispatch it.
     * The host injects the authenticated actor id as `bustedBy`
     * (actorFields) and the reducer verifies the caller sits on an
     * OPPOSING team — teammates and the floater cannot bust.
     */
    'bust-forbidden': { role: 'player', actorFields: ['bustedBy'] },
    'end-turn': { role: 'host' },
    'end-game': { role: 'host' },
  },
  createInitialState: () => createHushleInitialState(),
  handleAction: (_ctx, state, action) => hushleReducer(state, action),
  migrateState: (raw: unknown) => migrateHushleState(raw),
  renderClient: (props: unknown) => HushlePanel(props as HushlePanelClientProps),
};
