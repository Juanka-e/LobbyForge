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
  // Bot API v2 (docs/BOT_API_V2.md §1.2).
  /** Register slash commands, receive and answer interactions. */
  SLASH_COMMANDS: 'slash_commands',
  /** `member_join` / `member_leave` events and member lookups. */
  READ_MEMBERS: 'read_members',
  /** Open the event stream (WebSocket) or set an outgoing event endpoint. */
  RECEIVE_EVENTS: 'receive_events',
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

/** Every permission a bot can be granted, in display order. */
export const BOT_PERMISSIONS: readonly BotPermission[] = Object.freeze(Object.values(BotPermission));

export function isBotPermission(value: unknown): value is BotPermission {
  return typeof value === 'string' && (BOT_PERMISSIONS as readonly string[]).includes(value);
}

// Bot API v1 HTTP client — `createBotClient({ baseUrl, token })`.
export {
  createBotClient,
  toBotApiError,
  isBotTokenFormat,
  BOT_TOKEN_PATTERN,
  MAX_MESSAGE_LENGTH,
  MAX_READ_LIMIT,
  BotApiError,
  BotAuthError,
  BotForbiddenError,
  BotNotFoundError,
  BotRateLimitError,
  BotValidationError,
  BotServerError,
  BotNetworkError,
  type BotApiClient,
  type BotClientOptions,
  type BotIdentity,
  type BotChannel,
  type BotApiMessage,
  type BotMessageAuthor,
  type ReadMessagesOptions,
} from './client.js';

// Bot API v2 (docs/BOT_API_V2.md §6) — `new LobbyForgeBot({ baseUrl, token })`,
// event-endpoint signatures, incoming webhooks and the event stream protocol.
export {
  LobbyForgeBot,
  MAX_COMMANDS_PER_BOT,
  MAX_COMMAND_OPTIONS,
  type LobbyForgeBotOptions,
  type LobbyForgeBotEvents,
  type LobbyForgeBotEventName,
  type LobbyForgeBotListener,
  type ReconnectOptions,
  type WebSocketLike,
  type WebSocketConstructor,
  type BotCommandDefinition,
  type BotCommand,
  type BotCommandOption,
  type BotCommandOptionType,
  type BotCommandOptionChoice,
  type BotInteraction,
  type BotMember,
  type BotEventEndpoint,
  type AnswerOptions,
  type EventEndpointResult,
  type BotReadyInfo,
  type BotDisconnectInfo,
} from './bot.js';
export {
  verifySignature,
  signPayload,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  type VerifySignatureInput,
  type SignPayloadInput,
  type SignedBody,
} from './signature.js';
export {
  postToWebhook,
  MAX_WEBHOOK_USERNAME_LENGTH,
  type WebhookPayload,
  type PostToWebhookOptions,
} from './webhook.js';
export {
  BOT_GATEWAY_PATH,
  BOT_IDENTIFY_TIMEOUT_MS,
  BOT_HEARTBEAT_INTERVAL_MS,
  BotCloseCode,
  BOT_FATAL_CLOSE_CODES,
  BOT_EVENT_NAMES,
  BOT_EVENT_PERMISSIONS,
  type BotIdentifyMessage,
  type BotPingMessage,
  type BotClientMessage,
  type BotHelloMessage,
  type BotHeartbeatMessage,
  type BotPongMessage,
  type BotErrorCode,
  type BotErrorMessage,
  type BotFeedChannel,
  type BotFeedAuthor,
  type BotFeedMessage,
  type BotFeedMember,
  type BotFeedInteraction,
  type BotInteractionOptionValue,
  type BotReadyEvent,
  type BotMessageCreateEvent,
  type BotMessageUpdateEvent,
  type BotMessageDeleteEvent,
  type BotMemberJoinEvent,
  type BotMemberLeaveEvent,
  type BotInteractionCreateEvent,
  type BotChannelAccessChangedEvent,
  type BotEventData,
  type BotEventName,
  type BotEventMessage,
  type BotServerMessage,
} from './gateway-protocol.js';

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
  formatMessage,
  messageArguments,
  type MessageParams,
  type LocaleId,
  type LocaleTable,
  type BotLocaleLoader,
} from './locale.js';
