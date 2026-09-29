import { createElement } from 'react';
import type { GamePlugin, GamePluginActionPolicy } from '@lobbyforge/plugin-sdk';
import { CATALOG_SUMMARY_KEY, PluginPermission, loadPluginLocale } from '@lobbyforge/plugin-sdk';
import { WATCH_PARTY_PLUGIN_ID } from './constants';
import { LOCALE_TABLES, SHIPPED_LOCALES } from './locales.generated';
import {
  WATCH_PARTY_ACTION_TYPES,
  validateWatchPartyAction,
  watchPartyReducer,
  type WatchPartyAction,
} from './reducer';
import { WatchPartyPanel, type WatchPartyPanelClientProps } from './renderClient';
import {
  WATCH_PARTY_STATE_VERSION,
  createWatchPartyInitialState,
  isUserId,
  normalizeWatchPartyState,
  type WatchPartyState,
} from './state';

// Also registered by the panel, but that is a 'use client' module the
// server never evaluates — the host reads `catalog.summary` server-side.
loadPluginLocale(WATCH_PARTY_PLUGIN_ID, LOCALE_TABLES);

/**
 * Watch Party — everyone in a voice channel watches the same YouTube video
 * at the same moment, each in their own player (sync playback, spec 14 §6).
 *
 * DESIGN DECISIONS (docs/WATCH_PARTY.md has the full story):
 * - **The server keeps the clock.** Playback is one record — status,
 *   position, and the SERVER time it was written (`handleAction` passes
 *   `Date.now()` on the server; no action carries a timestamp). Clients
 *   derive where the video should be and correct their own players.
 * - **The host is a role in the state, not the session's creator.** It
 *   passes on when the host leaves, can be handed over, and can be taken
 *   over when the host goes quiet — so every action is `member` at the
 *   route and the reducer checks the actor, except `take-host`, which uses
 *   the route's `host` policy on purpose (creator + moderators).
 * - **Links are validated, not trusted.** Only YouTube video links are
 *   accepted and only their 11-character id is stored.
 * - **Nothing is secret**, so there is no projection rule: the queue,
 *   the timeline and who is watching are what everyone sees anyway.
 */

export { WATCH_PARTY_PLUGIN_ID } from './constants';
export {
  QUEUE_MAX,
  QUEUE_MAX_PER_USER,
  VIEWERS_MAX,
  DRIFT_TOLERANCE_SEC,
  HOST_AWAY_MS,
  VIEWER_AWAY_MS,
} from './constants';
export {
  WATCH_PARTY_STATE_VERSION,
  createWatchPartyInitialState,
  normalizeWatchPartyState,
  type WatchPartyState,
  type WatchPartyItem,
  type WatchPartyPlayback,
  type WatchPartyViewer,
  type WatchPartyViewerStatus,
  type WatchPartyControlMode,
} from './state';
export {
  validateWatchPartyAction,
  watchPartyReducer,
  WATCH_PARTY_ACTION_TYPES,
  type WatchPartyAction,
  type WatchPartyActionType,
  type WatchPartyClientAction,
} from './reducer';
export { parseYouTubeUrl, youTubeEmbedUrl, YOUTUBE_EMBED_ORIGIN, type YouTubeLink } from './youtube';
export { expectedPositionSec } from './sync';
export { WatchPartyPanel } from './renderClient';
export type { WatchPartyPanelClientProps, WatchPartyPanelProps } from './renderClient';

/**
 * Every action is `member` at the route (the reducer decides) and names its
 * actor through `actorFields`, which the host overwrites with the
 * authenticated caller. `take-host` alone is `host`: the session creator
 * and moderators with START_ACTIVITY.
 */
const actionPolicies: Record<string, GamePluginActionPolicy> = Object.fromEntries(
  WATCH_PARTY_ACTION_TYPES.map((type) => [
    type,
    {
      role: type === 'take-host' ? 'host' : 'member',
      actorFields: ['actorId'],
      // Joining puts the viewer on the watching list, by name.
      ...(type === 'join' ? { joinsRoster: true } : {}),
    } satisfies GamePluginActionPolicy,
  ])
);

export const watchPartyPlugin: GamePlugin<WatchPartyState, WatchPartyAction> = {
  manifest: {
    id: WATCH_PARTY_PLUGIN_ID,
    name: 'Watch Party',
    version: '0.2.0',
    type: 'activity',
    minAppVersion: '0.1.0',
    // Only what it uses: its own session state. It needs no voice or data
    // channel access — every viewer plays the video in their own player.
    permissions: [PluginPermission.MANAGE_GAME_SESSION],
    // Derived from locales/*.json, so the catalogue can never claim a
    // language the plugin does not actually ship.
    locales: SHIPPED_LOCALES,
    entryClient: './renderClient.js',
    catalog: {
      // It is not a game: it brings an outside service (YouTube) into the room.
      category: 'integration',
      // Translated in locales/*.json; the host shows the viewer's language.
      summary: LOCALE_TABLES.en[CATALOG_SUMMARY_KEY],
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
      requiresVoiceRoom: true,
      // Anyone can watch an embeddable video without signing in to YouTube.
      externalAccountRequired: false,
      compatibleAppVersion: '>=0.1.0',
      tags: ['watch-party', 'youtube', 'video', 'voice'],
    },
  },
  actionPolicies,
  createInitialState: (ctx) =>
    createWatchPartyInitialState({ hostId: isUserId(ctx?.actorUserId) ? ctx.actorUserId : null, now: Date.now() }),
  validateAction: validateWatchPartyAction,
  handleAction: (ctx, state, action) => {
    // The authenticated caller, from the host's context; the injected
    // `actorId` (actorFields) is the same person when both are present.
    const actorId = isUserId(ctx?.actorUserId) ? ctx.actorUserId : (action as { actorId?: unknown })?.actorId;
    const current = state?.version === WATCH_PARTY_STATE_VERSION ? state : normalizeWatchPartyState(state);
    // `Date.now()` here is the SERVER's clock: the host runs reducers in
    // the actions route. It is the only clock the timeline ever uses.
    return watchPartyReducer(current, { ...action, actorId } as WatchPartyAction, Date.now());
  },
  migrateState: (raw: unknown) => normalizeWatchPartyState(raw),
  /**
   * Returns an ELEMENT — it must never CALL the panel. Invoking the
   * component as a plain function would append its hooks to whatever
   * component called renderClient; the host mounts it conditionally, so
   * React would throw #310 and take the room down (see
   * plugins/hushle/src/index.ts for the regression this mirrors).
   */
  renderClient: (props: unknown) => createElement(WatchPartyPanel, props as WatchPartyPanelClientProps),
};
