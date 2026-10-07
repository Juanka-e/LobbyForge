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
  /**
   * The actor joins the session roster (`game_session_players`) when this
   * action succeeds — i.e. changes state. Opt in for a join/ready action and
   * for public actions whose author is shown anyway (a dice roll); leave it
   * off for anything whose author must stay private: the roster is visible
   * to every viewer, so joining it on an anonymous vote would name the voter.
   * While the action runs, `ctx.players` already includes the actor.
   */
  joinsRoster?: boolean;
  /**
   * Write an `activity.action` row to the server's audit log (actor, plugin
   * and action type) when this action changes state. Defaults to true for
   * `host` actions — running the table is moderation worth a trail — and to
   * false for `member` / `player` actions: those are gameplay, and the audit
   * log is readable by every VIEW_AUDIT_LOG holder, so "who sent which
   * action type, when" would hand out hidden roles (a night action names a
   * night role) and anonymous votes (security-review PLUG-001). Set it to
   * true only for an action whose author and type are public anyway; set
   * it to false for a host action that reveals a secret by its type alone.
   * Refused actions (state unchanged) are never audited.
   */
  audit?: boolean;
  /**
   * When the plugin requires voice (`manifest.catalog.requiresVoiceRoom`),
   * the host refuses `member` / `player` actions from anyone who is not in
   * the activity's voice room (403, `code: 'voice_required'`). Set this on
   * an action someone must be able to send from outside the room — leaving
   * the game is the usual one: a player who dropped out of voice can still
   * take themselves off the table. `host` actions are never voice-checked.
   */
  allowOutsideVoice?: boolean;
}

/** What `GamePlugin.onHostChange` is told when the host moves hosting to someone else. */
export interface GamePluginHostChange {
  /** The previous host (`null` when the session had none — its creator's account is gone). */
  previousHostId: string | null;
  /** The new host. */
  nextHostId: string;
  /** Server clock (ms) of the change. */
  now: number;
  /** Why it moved: today only `host_left_voice` (out of the voice room past the host's grace). */
  reason: 'host_left_voice';
}

/**
 * Should the host write an audit row for this action? The `audit` flag
 * when the policy sets it, else true for `host` and false for gameplay
 * (`member` / `player`) — see `GamePluginActionPolicy.audit`.
 */
export function shouldAuditAction(policy: Pick<GamePluginActionPolicy, 'role' | 'audit'>): boolean {
  return policy.audit ?? policy.role === 'host';
}

// Main Interface GamePlugin
export interface GamePlugin<TState = unknown, TAction = unknown, TProps = unknown> {
  manifest: PluginManifest;
  actionPolicies?: Record<string, GamePluginActionPolicy>;
  createInitialState: (ctx: GamePluginContext<TState>) => TState;
  handleAction: (ctx: GamePluginContext<TState>, state: TState, action: TAction) => TState;
  /**
   * 31st-audit: OPTIONAL runtime action guard. The host's activity API
   * only validates `{ type: string }` at its boundary — plugin-specific
   * fields arrive as raw JSON from ANY client. When a plugin declares
   * validateAction, the host calls it BEFORE dispatch: a returned string
   * rejects the request with 400 (malformed, not a crash); null lets it
   * through. Reducers should still be written defensively — this is the
   * outer belt, not the only one.
   */
  validateAction?: (action: unknown) => string | null;
  /**
   * The "play again" actions of a game whose state has a `phase` field.
   * Declaring the list turns on the host's ended-phase guard: once
   * `state.phase === 'ended'`, every action type NOT in this list is
   * refused with 409 (`code: 'session_ended'`) before the reducer runs, and
   * the listed ones go through (still under their `actionPolicies` entry),
   * so the reducer can start a new round in the same session. Leave it
   * undefined when the reducer should decide everything after the end (a
   * post-game chat, say).
   */
  restartActions?: readonly string[];
  /**
   * Called when the host moves the session's hosting to someone else (the
   * host left the voice room past the grace period — see "Host transfer" in
   * docs/PLUGIN_SDK.md). Pure, like the reducer: return the state with the
   * plugin's own notion of "host" updated, or the SAME object when nothing
   * changes. Most plugins need nothing here — the panel's `hostUserId` and
   * the `host` action policy follow the session host on their own.
   */
  onHostChange?: (state: TState, change: GamePluginHostChange) => TState;
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
  /** Mirrors GamePlugin.validateAction (31st-audit runtime guard). */
  validateAction?: (action: unknown) => string | null;
  /** Mirrors GamePlugin.restartActions (the host's ended-phase guard). */
  restartActions?: readonly string[];
  /** Mirrors GamePlugin.onHostChange. */
  onHostChange?: (state: unknown, change: GamePluginHostChange) => unknown;
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
    validateAction: plugin.validateAction,
    restartActions: plugin.restartActions,
    onHostChange: plugin.onHostChange
      ? (state: unknown, change: GamePluginHostChange) => plugin.onHostChange!(state as TState, change)
      : undefined,
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
  HOST_LOCALE_ATTRIBUTE,
  CATALOG_SUMMARY_KEY,
  CATALOG_NAME_KEY,
  __resetPluginLocaleRegistry,
  formatMessage,
  messageArguments,
  PLURAL_CATEGORIES,
  type MessageParams,
  type LocaleId,
  type LocaleTable,
  type PluginLocaleLoader,
} from './locale.js';
