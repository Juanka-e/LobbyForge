import { createElement } from 'react';
import type { GamePlugin, GamePluginActionPolicy } from '@lobbyforge/plugin-sdk';
import { CATALOG_SUMMARY_KEY, PluginPermission, loadPluginLocale } from '@lobbyforge/plugin-sdk';
import { LOCALE_TABLES, SHIPPED_LOCALES } from './locales.generated';
import { VAMPIRE_VILLAGE_PLUGIN_ID } from './plugin-id';
import { reduceVillage } from './reducer';
import { VampireVillagePanel, type VampireVillagePanelProps } from './renderClient';
import { MAX_PLAYERS, MIN_PLAYERS, createVillageInitialState, migrateVillageState } from './state';
import type { VillageAction, VillageState } from './state';
import { validateVillageAction } from './validate';

// Also registered by the panel, but that is a 'use client' module the
// server never evaluates — the host reads `catalog.summary` server-side.
loadPluginLocale(VAMPIRE_VILLAGE_PLUGIN_ID, LOCALE_TABLES);

export { VAMPIRE_VILLAGE_PLUGIN_ID } from './plugin-id';
export {
  CHAT_KEEP,
  CHAT_MAX_LENGTH,
  CHAT_PER_PHASE,
  DEFAULT_VILLAGE_SETTINGS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NAME_MAX_LENGTH,
  PACK_CHAT_KEEP,
  PACK_CHAT_PER_PHASE,
  PLAYER_COLORS,
  SETTING_LIMITS,
  VV_STATE_VERSION,
  createVillageInitialState,
  migrateVillageState,
} from './state';
export type {
  VillageAction,
  VillageChatMessage,
  VillageColor,
  VillageDeath,
  VillageDeathCause,
  VillageEndReason,
  VillageLogEntry,
  VillageNightChoice,
  VillageNightRecord,
  VillageNote,
  VillageOutcome,
  VillagePhase,
  VillagePlayer,
  VillageResources,
  VillageRole,
  VillageSecret,
  VillageSettings,
  VillageSpectator,
  VillageState,
  VillageTeam,
  VillageWinner,
} from './state';
export type { NightTask, VillageMe, VillagePack, VillageView } from './view';
export { majorityNeeded, rolesForPlayerCount, teamOf, vampireCountFor } from './rules';
export { reduceVillage, type ReducerDeps } from './reducer';
export { validateVillageAction } from './validate';
export { VampireVillagePanel, type VampireVillagePanelProps } from './renderClient';

/** Acting as oneself: any server member, with the id stamped by the host from the session. */
const AS_SELF: GamePluginActionPolicy = { role: 'member', actorFields: ['playerId'] };
const HOST: GamePluginActionPolicy = { role: 'host' };

export const vampireVillagePlugin: GamePlugin<VillageState, VillageAction> = {
  manifest: {
    id: VAMPIRE_VILLAGE_PLUGIN_ID,
    name: 'Vampire Village',
    version: '0.2.0',
    type: 'game',
    minAppVersion: '0.1.0',
    permissions: [PluginPermission.MANAGE_GAME_SESSION, PluginPermission.MANAGE_TIMER],
    // Derived from locales/*.json, so the catalogue can never claim a
    // language the plugin does not actually ship.
    locales: SHIPPED_LOCALES,
    entryClient: './renderClient.js',
    catalog: {
      category: 'game',
      // Translated in locales/*.json; the host shows the viewer's language.
      summary: LOCALE_TABLES.en[CATALOG_SUMMARY_KEY],
      publisher: 'LobbyForge',
      trustLevel: 'official',
      playerConfig: {
        minPlayers: MIN_PLAYERS,
        maxPlayers: MAX_PLAYERS,
        defaultMaxPlayers: MAX_PLAYERS,
        supportsSpectators: true,
        supportsQueue: false,
        overflowPolicy: 'spectator',
      },
      requiresVoiceRoom: true,
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.2.0',
      tags: ['social-deduction', 'hidden-roles', 'voice'],
    },
  },
  /**
   * Player actions are `member` + `actorFields`: the reducer keeps its own
   * roster and checks seat, life, role and phase itself (a seat is taken
   * with `join`, not by being in the session's player table). Everything
   * that runs the table is the host's (or a START_ACTIVITY moderator's).
   */
  actionPolicies: {
    join: AS_SELF,
    leave: AS_SELF,
    'set-ready': AS_SELF,
    timeout: AS_SELF,
    'night-target': AS_SELF,
    'night-shield': AS_SELF,
    vote: AS_SELF,
    chat: AS_SELF,
    'pack-chat': AS_SELF,
    configure: HOST,
    start: HOST,
    kick: HOST,
    advance: HOST,
    pause: HOST,
    resume: HOST,
    extend: HOST,
    'play-again': HOST,
    'end-game': HOST,
  },
  createInitialState: () => createVillageInitialState(),
  validateAction: validateVillageAction,
  // The reducer refuses anything malformed (it re-runs validateAction) and
  // reads the server clock and CSPRNG through its default dependencies.
  handleAction: (_ctx, state, action) => reduceVillage(migrateVillageState(state), action),
  migrateState: (raw: unknown) => migrateVillageState(raw),
  // An ELEMENT, not a call: the panel must own its hooks (see Hushle's note).
  renderClient: (props: unknown) => createElement(VampireVillagePanel, props as VampireVillagePanelProps),
};
