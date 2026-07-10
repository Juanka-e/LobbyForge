// Bot Permissions as both enum-like object and union type
export const BotPermission = {
  READ_MESSAGES: 'read_messages',
  SEND_MESSAGES: 'send_messages',
  JOIN_VOICE: 'join_voice',
  PUBLISH_AUDIO: 'publish_audio',
  READ_PRESENCE: 'read_presence',
  MODERATE_MESSAGES: 'moderate_messages',
  MANAGE_GAME_SESSION: 'manage_game_session',
  MANAGE_MUSIC_QUEUE: 'manage_music_queue',
  READ_AUDIT_LOG: 'read_audit_log',
} as const;

export type BotPermission = typeof BotPermission[keyof typeof BotPermission];

// Bot Lifecycle States
export type BotLifecycleState = 'idle' | 'connecting' | 'active' | 'disconnected';

// Bot Manifest
export interface BotManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions: BotPermission[];
}

// Bot Message Structure
export interface BotMessage {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: Date;
}

// Bot Events interface
export interface BotEvents {
  onMessage?: (message: BotMessage) => void | Promise<void>;
  onStateChange?: (oldState: BotLifecycleState, newState: BotLifecycleState) => void | Promise<void>;
  onVoiceJoin?: (channelId: string) => void | Promise<void>;
  onVoiceLeave?: (channelId: string) => void | Promise<void>;
}

// Base Bot interface for client and core runtime
export interface Bot {
  manifest: BotManifest;
  state: BotLifecycleState;
  connect: (token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  sendMessage: (channelId: string, content: string) => Promise<void>;
}

// BotClient is an alias of Bot, with room to grow with client-specific members later.
export type BotClient = Bot;

// Re-export the shared locale helper so consumers can `import { tFor,
// loadBotLocale, detectLocale, pickBestLocale, listBotLocales,
// registerBotLocale } from '@lobbyforge/bot-sdk'`. The dedicated
// subpath `@lobbyforge/bot-sdk/locale` exports the same surface for
// callers who prefer the dedicated import path.
export {
  tFor,
  loadBotLocale,
  registerBotLocale,
  listBotLocales,
  detectLocale,
  pickBestLocale,
  __resetBotLocaleRegistry,
  type LocaleId,
  type LocaleTable,
  type BotLocaleLoader,
} from './locale.js';
