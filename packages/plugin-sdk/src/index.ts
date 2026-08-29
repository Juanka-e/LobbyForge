import { ReactNode } from 'react';

// Plugin Permissions as both enum-like object and union type
export const PluginPermission = {
  READ_ROOM_PARTICIPANTS: 'read_room_participants',
  SEND_ROOM_MESSAGE: 'send_room_message',
  CREATE_GAME_SESSION: 'create_game_session',
  MANAGE_GAME_SESSION: 'manage_game_session',
  USE_VOICE_STATE: 'use_voice_state',
  SEND_DATA_CHANNEL_EVENT: 'send_data_channel_event',
  MANAGE_TIMER: 'manage_timer',
  MANAGE_SCORES: 'manage_scores',
  PLAY_AUDIO_AS_BOT: 'play_audio_as_bot',
  READ_PLUGIN_SETTINGS: 'read_plugin_settings',
  WRITE_PLUGIN_SETTINGS: 'write_plugin_settings',
} as const;

export type PluginPermission = typeof PluginPermission[keyof typeof PluginPermission];

export type PluginCategory = 'game' | 'bot' | 'integration' | 'utility';
export type PluginTrustLevel = 'official' | 'verified-community' | 'unverified';
export type PluginOverflowPolicy = 'spectator' | 'queue' | 'split' | 'reject';

export interface PluginPlayerConfig {
  minPlayers?: number;
  maxPlayers?: number;
  defaultMaxPlayers?: number;
  supportsSpectators?: boolean;
  supportsQueue?: boolean;
  overflowPolicy?: PluginOverflowPolicy;
}

export interface PluginCatalogMetadata {
  category?: PluginCategory;
  summary?: string;
  publisher?: string;
  trustLevel?: PluginTrustLevel;
  playerConfig?: PluginPlayerConfig;
  requiresVoiceRoom?: boolean;
  externalAccountRequired?: boolean;
  externalAccountProvider?: string;
  compatibleAppVersion?: string;
  tags?: string[];
}

// Plugin Manifest
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: 'game' | 'activity' | 'utility';
  minAppVersion: string;
  permissions: PluginPermission[];
  locales: string[];
  entryClient: string;
  entryServer?: string;
  catalog?: PluginCatalogMetadata;
}

// Sub-contexts within GamePluginContext
export interface PlayersSubContext {
  list: () => string[];
  get: (playerId: string) => { id: string; name: string } | undefined;
}

export interface MessagesSubContext {
  sendGameMessage: (message: string) => Promise<void>;
}

export interface StateSubContext<T = unknown> {
  save: (state: T) => Promise<void>;
}

export interface CacheSubContext {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, ttlSeconds?: number) => Promise<void>;
}

export interface PubSubSubContext {
  publish: (topic: string, data: unknown) => Promise<void>;
  subscribe: (topic: string, callback: (data: unknown) => void) => Promise<void>;
}

export interface TimerSubContext {
  start: (seconds: number) => Promise<void>;
  stop: () => Promise<void>;
}

export interface VotesSubContext {
  create: (question: string, options: string[]) => Promise<void>;
}

export interface ScoresSubContext {
  add: (playerId: string, score: number) => Promise<void>;
}

export interface VoiceSubContext {
  getParticipants: () => string[];
}

/**
 * Faz E — persistent key-value storage scoped to (server, plugin).
 * The HOST executes every operation on the plugin's behalf; community
 * plugins never receive SQL or a DbClient. Keys are
 * [a-zA-Z0-9._:-]{1,128}. Values are JSON; `set` replaces the whole
 * value (no merge). Durability: PostgreSQL, not Redis — data survives
 * restarts, and uninstall cleanup is `clear()`.
 */
export interface StorageSubContext {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  /** Every key->value in this plugin's scope (bounded by the plugin's own keyspace). */
  list: () => Promise<Array<{ key: string; value: unknown }>>;
  /** Wipe every key of this plugin on this server (uninstall/cleanup). */
  clear: () => Promise<void>;
}

// Injected by the host
export interface GamePluginContext<TState = unknown> {
  actorUserId: string;
  players: PlayersSubContext;
  messages: MessagesSubContext;
  state: StateSubContext<TState>;
  cache: CacheSubContext;
  pubsub: PubSubSubContext;
  timer: TimerSubContext;
  votes: VotesSubContext;
  scores: ScoresSubContext;
  voice: VoiceSubContext;
  /** Persistent per-(server, plugin) storage (Faz E). */
  storage: StorageSubContext;
}

export interface GamePluginActionPolicy {
  role: 'host' | 'member' | 'player';
  actorFields?: string[];
}

// Main Interface GamePlugin
export interface GamePlugin<TState = unknown, TAction = unknown, TProps = unknown> {
  manifest: PluginManifest;
  actionPolicies?: Record<string, GamePluginActionPolicy>;
  createInitialState: (ctx: GamePluginContext<TState>) => TState;
  handleAction: (ctx: GamePluginContext<TState>, state: TState, action: TAction) => TState;
  /**
   * Optional state migrator. The host runs `migrateState(raw)` on the
   * `state` JSONB returned from the database before handing it to the
   * plugin's reducer / renderClient. This is the migration seam:
   * when the plugin evolves its state shape, it adds a step here and
   * the next read automatically upgrades old sessions without an
   * ad-hoc migration script.
   *
   * The migrator must be idempotent: the host calls it once per
   * read, and the same raw blob may be re-read multiple times.
   */
  migrateState?: (raw: unknown) => TState;
  renderClient: (props: TProps) => ReactNode;
}

/**
 * Host-side view of a plugin after it has been admitted into a registry.
 *
 * Plugin authors keep strong `TState` / `TAction` / `TProps` generics on
 * `GamePlugin`. The host stores many different plugins in one catalog, so it
 * calls through this erased wrapper and validates/persists at the boundary.
 */
export interface RegisteredGamePlugin {
  manifest: PluginManifest;
  actionPolicies?: Record<string, GamePluginActionPolicy>;
  createInitialState: (ctx: GamePluginContext) => unknown;
  handleAction: (ctx: GamePluginContext, state: unknown, action: unknown) => unknown;
  /**
   * Optional state migrator. Mirrors `GamePlugin.migrateState` —
   * the host runs it on every read so old sessions upgrade to the
   * plugin's current shape automatically.
   */
  migrateState?: (raw: unknown) => unknown;
  renderClient: (props: unknown) => ReactNode;
}

export function registerGamePlugin<TState, TAction, TProps>(
  plugin: GamePlugin<TState, TAction, TProps>
): RegisteredGamePlugin {
  return {
    manifest: plugin.manifest,
    actionPolicies: plugin.actionPolicies,
    createInitialState: (ctx) =>
      plugin.createInitialState(ctx as GamePluginContext<TState>),
    handleAction: (ctx, state, action) =>
      plugin.handleAction(
        ctx as GamePluginContext<TState>,
        state as TState,
        action as TAction
      ),
    migrateState: plugin.migrateState
      ? (raw: unknown) => plugin.migrateState!(raw)
      : undefined,
    renderClient: (props) => plugin.renderClient(props as TProps),
  };
}

// Re-export the shared locale helper so consumers can `import { tFor,
// loadPluginLocale, detectLocale, pickBestLocale, listPluginLocales,
// registerPluginLocale } from '@lobbyforge/plugin-sdk'`. The dedicated
// subpath `@lobbyforge/plugin-sdk/locale` exports the same surface
// for callers who want the import path to scream "this is locale code".
export {
  tFor,
  loadPluginLocale,
  registerPluginLocale,
  listPluginLocales,
  detectLocale,
  pickBestLocale,
  __resetPluginLocaleRegistry,
  type LocaleId,
  type LocaleTable,
  type PluginLocaleLoader,
} from './locale.js';
