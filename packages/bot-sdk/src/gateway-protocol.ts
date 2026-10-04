/**
 * Bot event stream wire protocol (Bot API v2, docs/BOT_API_V2.md §4).
 *
 * This file is shared by the gateway and the SDK and must stay
 * byte-identical in both places:
 *
 *   apps/ws-gateway/src/bot-protocol.ts
 *   packages/bot-sdk/src/gateway-protocol.ts
 *
 * A test in packages/bot-sdk pins the two copies together. It has no
 * imports on purpose, so it can be copied into a standalone bot project.
 */

/** The gateway path bots connect to (browser sessions keep `/ws`). */
export const BOT_GATEWAY_PATH = '/ws/bot';

/** How long a socket may stay unidentified before it is closed (ms). */
export const BOT_IDENTIFY_TIMEOUT_MS = 5_000;

/** The server pings (and sends a `heartbeat` frame) this often (ms). */
export const BOT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Close codes the gateway uses on `/ws/bot`. 1000/1001/1011 are the
 * standard codes; a socket terminated for missed heartbeats has no close
 * frame (clients see 1006).
 */
export const BotCloseCode = {
  /** Normal close (client or server). */
  NORMAL: 1000,
  /** The gateway is shutting down — reconnect. */
  GOING_AWAY: 1001,
  /** The gateway failed (database unreachable) — reconnect later. */
  INTERNAL_ERROR: 1011,
  /** No/invalid token, identify timeout, wrong first message, token rotated or revoked. Do not reconnect. */
  UNAUTHORIZED: 4001,
  /** The bot is disabled or lacks `receive_events`. Do not reconnect. */
  FORBIDDEN: 4003,
  /** Another connection for the same bot replaced this one. Do not reconnect. */
  REPLACED: 4009,
  /** Too many failed identifies from this address, connects for this bot, or messages. Back off. */
  RATE_LIMITED: 4029,
} as const;
export type BotCloseCode = (typeof BotCloseCode)[keyof typeof BotCloseCode];

/** Close codes after which a client must NOT reconnect on its own. */
export const BOT_FATAL_CLOSE_CODES: readonly number[] = [
  BotCloseCode.UNAUTHORIZED,
  BotCloseCode.FORBIDDEN,
  BotCloseCode.REPLACED,
];

// ---------------------------------------------------------------------------
// Client -> gateway
// ---------------------------------------------------------------------------

/** First message when the token cannot travel in the upgrade header. */
export interface BotIdentifyMessage {
  type: 'identify';
  token: string;
}

/** Optional application-level keep-alive; answered with `pong`. */
export interface BotPingMessage {
  type: 'ping';
}

export type BotClientMessage = BotIdentifyMessage | BotPingMessage;

// ---------------------------------------------------------------------------
// Gateway -> client
// ---------------------------------------------------------------------------

export interface BotHelloMessage {
  type: 'hello';
  ok: true;
  bot: { id: string; serverId: string };
  at: string;
}

export interface BotHeartbeatMessage {
  type: 'heartbeat';
  at: string;
}

export interface BotPongMessage {
  type: 'pong';
  at: string;
}

export type BotErrorCode =
  | 'unauthorized'
  | 'bot_disabled'
  | 'missing_permission'
  | 'replaced'
  | 'rate_limited'
  | 'bad_message'
  | 'internal_error';

export interface BotErrorMessage {
  type: 'error';
  code: BotErrorCode;
  message: string;
  /** Set with `missing_permission`. */
  permission?: string;
}

/** A channel in the bot's feed (§1.1 set). */
export interface BotFeedChannel {
  id: string;
  name: string;
}

/**
 * Who wrote a message. `bot` marks a bot author, `webhook` an incoming
 * webhook post; `id`/`displayName` are null for a deleted user.
 */
export interface BotFeedAuthor {
  id: string | null;
  displayName: string | null;
  bot?: true;
  webhook?: true;
}

export interface BotFeedMessage {
  id: string;
  channelId: string;
  content: string;
  author: BotFeedAuthor;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601, null until edited. Always set on the stream; endpoint deliveries omit it when null. */
  editedAt?: string | null;
  /** Always set on the stream; endpoint deliveries omit it when null. */
  replyToId?: string | null;
}

export interface BotReadyEvent {
  event: 'ready';
  bot: { id: string; name: string; serverId: string; permissions: string[] };
  channels: BotFeedChannel[];
}

export interface BotMessageCreateEvent {
  event: 'message_create';
  message: BotFeedMessage;
}

export interface BotMessageUpdateEvent {
  event: 'message_update';
  message: BotFeedMessage;
}

export interface BotMessageDeleteEvent {
  event: 'message_delete';
  id: string;
  channelId: string;
}

export interface BotFeedMember {
  id: string;
  displayName: string | null;
}

export interface BotMemberJoinEvent {
  event: 'member_join';
  member: BotFeedMember;
}

export interface BotMemberLeaveEvent {
  event: 'member_leave';
  member: BotFeedMember;
  /** Why the member left, when known. */
  reason?: 'leave' | 'kick' | 'ban';
}

export type BotInteractionOptionValue = string | number | boolean;

export interface BotFeedInteraction {
  id: string;
  commandName: string;
  options: Record<string, BotInteractionOptionValue>;
  channelId: string;
  user: { id: string; displayName: string };
  /** ISO-8601 — answer before this instant (15 minutes after the run). */
  expiresAt: string;
}

export interface BotInteractionCreateEvent {
  event: 'interaction_create';
  interaction: BotFeedInteraction;
}

export interface BotChannelAccessChangedEvent {
  event: 'channel_access_changed';
  channels: BotFeedChannel[];
}

export type BotEventData =
  | BotReadyEvent
  | BotMessageCreateEvent
  | BotMessageUpdateEvent
  | BotMessageDeleteEvent
  | BotMemberJoinEvent
  | BotMemberLeaveEvent
  | BotInteractionCreateEvent
  | BotChannelAccessChangedEvent;

export type BotEventName = BotEventData['event'];

export const BOT_EVENT_NAMES: readonly BotEventName[] = [
  'ready',
  'message_create',
  'message_update',
  'message_delete',
  'member_join',
  'member_leave',
  'interaction_create',
  'channel_access_changed',
];

/**
 * The bot permission each event needs (besides `receive_events`, which
 * the connection itself needs). Message events also need access to the
 * message's channel.
 */
export const BOT_EVENT_PERMISSIONS: Readonly<Record<BotEventName, string | null>> = {
  ready: null,
  message_create: 'read_messages',
  message_update: 'read_messages',
  message_delete: 'read_messages',
  member_join: 'read_members',
  member_leave: 'read_members',
  interaction_create: 'slash_commands',
  channel_access_changed: null,
};

export interface BotEventMessage<TData extends BotEventData = BotEventData> {
  type: 'event';
  topic: 'bot';
  data: TData;
  at: string;
}

export type BotServerMessage =
  | BotHelloMessage
  | BotHeartbeatMessage
  | BotPongMessage
  | BotErrorMessage
  | BotEventMessage;
