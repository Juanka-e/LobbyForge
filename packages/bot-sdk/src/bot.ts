/**
 * `LobbyForgeBot` — the Bot API v2 client (docs/BOT_API_V2.md §6).
 *
 * ```ts
 * const bot = new LobbyForgeBot({ baseUrl, token });
 * await bot.commands.set([{ name: 'roll', description: 'Roll dice', options: [...] }]);
 * bot.on('interaction', (i) => i.reply(`🎲 ${roll(i.options.sides ?? 6)}`));
 * bot.on('message', (m) => { … });
 * await bot.connect(); // event stream, reconnects on its own
 * ```
 *
 * Zero dependencies: the global `fetch` and `WebSocket` (browsers, Node ≥ 22)
 * or implementations passed in. The socket authenticates with an `identify`
 * message (the standard WebSocket API cannot set headers); the token never
 * goes into a URL.
 *
 * Reconnects use exponential backoff with jitter. The gateway's fatal close
 * codes stop it for good: 4001 (bad/rotated token), 4003 (disabled or no
 * `receive_events`), 4009 (another connection for this bot took over).
 * Events are at-most-once — after a reconnect, backfill with
 * `readMessages(channelId, { before })`.
 */
import {
  BotApiError,
  BotAuthError,
  BotForbiddenError,
  BotNetworkError,
  BotNotFoundError,
  BotValidationError,
  MAX_MESSAGE_LENGTH,
  createBotHttp,
  createMessageApi,
  expectArray,
  isUuidLike,
  type BotApiClient,
  type BotApiMessage,
  type BotChannel,
  type BotClientOptions,
  type BotHttp,
  type BotIdentity,
  type ReadMessagesOptions,
} from './client.js';
import {
  BOT_FATAL_CLOSE_CODES,
  BOT_HEARTBEAT_INTERVAL_MS,
  BotCloseCode,
  type BotErrorMessage,
  type BotEventData,
  type BotFeedChannel,
  type BotFeedInteraction,
  type BotFeedMember,
  type BotFeedMessage,
  type BotReadyEvent,
} from './gateway-protocol.js';

// ---------------------------------------------------------------------------
// WebSocket seam
// ---------------------------------------------------------------------------

/** The part of the standard WebSocket API the bot uses (browsers, Node ≥ 22, `ws`). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void
  ): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

// ---------------------------------------------------------------------------
// Commands, interactions, members
// ---------------------------------------------------------------------------

export type BotCommandOptionType = 'string' | 'integer' | 'number' | 'boolean' | 'user' | 'channel';

export interface BotCommandOptionChoice {
  name: string;
  value: string | number;
}

export interface BotCommandOption {
  /** `^[a-z0-9_-]{1,32}$` */
  name: string;
  description?: string;
  type: BotCommandOptionType;
  required?: boolean;
  /** `integer` / `number` only. */
  min?: number;
  max?: number;
  /** `string` / `integer` / `number`, at most 25. */
  choices?: BotCommandOptionChoice[];
}

export interface BotCommandDefinition {
  /** `^[a-z0-9_-]{1,32}$`, unique in the server. */
  name: string;
  /** 1–100 characters. */
  description: string;
  /** At most 25; required options first. */
  options?: BotCommandOption[];
  /** null = every channel the bot can access; else a subset of them. */
  channelIds?: string[] | null;
  /** A core permission id the invoker must hold, e.g. `kick_members`. */
  requiredPermission?: string | null;
}

/** A registered command as the instance returns it. */
export interface BotCommand extends BotCommandDefinition {
  id?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface BotMember {
  id: string;
  displayName: string | null;
  /** The member's nickname in this server, if set. */
  nickname?: string | null;
  /** Highest role first. */
  roles: Array<{ id: string; name: string }>;
  /** ISO-8601 */
  joinedAt: string | null;
  [key: string]: unknown;
}

/** The outgoing endpoint's status as the instance reports it (never the secret). */
export interface BotEventEndpoint {
  url: string;
  events: string[];
  enabled: boolean;
  [key: string]: unknown;
}

export interface AnswerOptions {
  /** Only the invoker sees the answer (never stored as a message). */
  ephemeral?: boolean;
}

/** An interaction from the stream, with helpers bound to its id. */
export interface BotInteraction extends BotFeedInteraction {
  /** Answer once (`POST /interactions/{id}/respond`). */
  reply(content: string, options?: AnswerOptions): Promise<Record<string, unknown>>;
  /** Another message for the same interaction, within 15 minutes, at most 5. */
  followup(content: string, options?: AnswerOptions): Promise<Record<string, unknown>>;
}

export interface EventEndpointResult {
  endpoint: BotEventEndpoint;
  /** The signing secret — returned ONCE; store it to verify deliveries. */
  secret: string;
  [key: string]: unknown;
}

const COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const MAX_COMMANDS_PER_BOT = 50;
export const MAX_COMMAND_OPTIONS = 25;

function validateCommands(commands: unknown): BotCommandDefinition[] {
  if (!Array.isArray(commands)) throw new BotValidationError('commands must be an array');
  if (commands.length > MAX_COMMANDS_PER_BOT) {
    throw new BotValidationError(`a bot can register at most ${MAX_COMMANDS_PER_BOT} commands`);
  }
  const seen = new Set<string>();
  const issues: string[] = [];
  commands.forEach((command: Partial<BotCommandDefinition> | null, index) => {
    const at = `commands[${index}]`;
    if (!command || typeof command !== 'object') {
      issues.push(`${at}: must be an object`);
      return;
    }
    if (typeof command.name !== 'string' || !COMMAND_NAME_PATTERN.test(command.name)) {
      issues.push(`${at}.name: must match ^[a-z0-9_-]{1,32}$`);
    } else if (seen.has(command.name)) {
      issues.push(`${at}.name: "${command.name}" is listed twice`);
    } else {
      seen.add(command.name);
    }
    if (typeof command.description !== 'string' || command.description.length < 1 || command.description.length > 100) {
      issues.push(`${at}.description: must be 1–100 characters`);
    }
    if (command.options !== undefined) {
      if (!Array.isArray(command.options) || command.options.length > MAX_COMMAND_OPTIONS) {
        issues.push(`${at}.options: at most ${MAX_COMMAND_OPTIONS} options`);
      } else {
        command.options.forEach((option, optionIndex) => {
          if (!option || typeof option.name !== 'string' || !COMMAND_NAME_PATTERN.test(option.name)) {
            issues.push(`${at}.options[${optionIndex}].name: must match ^[a-z0-9_-]{1,32}$`);
          }
        });
      }
    }
  });
  if (issues.length > 0) {
    throw new BotValidationError('Invalid command definitions', 400, 'invalid_request', { issues });
  }
  return commands as BotCommandDefinition[];
}

function validateAnswer(id: unknown, content: unknown): void {
  if (!isUuidLike(id)) throw new BotValidationError('interaction id must be a UUID');
  if (typeof content !== 'string' || !content.trim()) {
    throw new BotValidationError('content must be a non-empty string');
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new BotValidationError(`content must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface BotReadyInfo {
  bot: BotReadyEvent['bot'];
  channels: BotFeedChannel[];
}

export interface BotDisconnectInfo {
  code: number;
  reason: string;
  /** False after `close()` or a fatal close code. */
  willReconnect: boolean;
  /** Delay before the next attempt (ms), when reconnecting. */
  delayMs: number | null;
}

export interface LobbyForgeBotEvents {
  ready: BotReadyInfo;
  message: BotFeedMessage;
  message_update: BotFeedMessage;
  message_delete: { id: string; channelId: string };
  member_join: BotFeedMember;
  member_leave: BotFeedMember & { reason?: 'leave' | 'kick' | 'ban' };
  interaction: BotInteraction;
  channel_access_changed: BotFeedChannel[];
  /** Every event payload as received (forward compatibility). */
  raw: BotEventData;
  disconnect: BotDisconnectInfo;
  error: Error;
}

export type LobbyForgeBotEventName = keyof LobbyForgeBotEvents;
export type LobbyForgeBotListener<K extends LobbyForgeBotEventName> = (
  payload: LobbyForgeBotEvents[K]
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReconnectOptions {
  /** First delay (ms). Default 1 000. */
  initialDelayMs?: number;
  /** Longest delay (ms). Default 30 000. */
  maxDelayMs?: number;
  /** Give up after this many failed attempts in a row. Default: never. */
  maxAttempts?: number;
}

export interface LobbyForgeBotOptions extends BotClientOptions {
  /** A WebSocket implementation (e.g. the `ws` package). Default: the global `WebSocket`. */
  WebSocket?: WebSocketConstructor;
  /** Skip `GET /api/bot/v2/gateway` and connect here (`wss://…/ws/bot`). */
  gatewayUrl?: string;
  /** `false` disables reconnecting. */
  reconnect?: boolean | ReconnectOptions;
  /** Reconnect when no frame arrived for this long (ms). Default 75 000 (2.5 server heartbeats). */
  heartbeatTimeoutMs?: number;
  /** Jitter source in [0, 1) (tests). Default `Math.random`. */
  random?: () => number;
}

/** Minimum wait after the gateway answered 4029 (rate limited). */
const RATE_LIMITED_MIN_DELAY_MS = 10_000;

type ConnectWaiter = { resolve: () => void; reject: (error: Error) => void };

function closeError(code: number, reason: string, last: BotErrorMessage | null): BotApiError {
  const message = last?.message ?? (reason || `The event stream closed with code ${code}`);
  if (code === BotCloseCode.UNAUTHORIZED) return new BotAuthError(message, last?.code ?? 'unauthorized');
  if (code === BotCloseCode.FORBIDDEN) {
    return new BotForbiddenError(message, last?.code ?? 'forbidden', last?.permission ? { permission: last.permission } : {});
  }
  if (code === BotCloseCode.REPLACED) return new BotApiError(message, 0, 'replaced');
  return new BotNetworkError(message, 'closed');
}

function decodeFrame(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBufferView);
  return null;
}

export class LobbyForgeBot {
  /** The v2 message endpoints (`/v2/me`, `/v2/channels`, …), honouring channel access. */
  readonly api: BotApiClient;
  private readonly http: BotHttp;
  private readonly token: string;
  private readonly WebSocketImpl: WebSocketConstructor | undefined;
  private readonly configuredGatewayUrl: string | undefined;
  private readonly reconnectEnabled: boolean;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly random: () => number;

  private readonly listeners = new Map<LobbyForgeBotEventName, Set<LobbyForgeBotListener<never>>>();
  private socket: WebSocketLike | null = null;
  private gatewayUrl: string | null = null;
  private status: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  private stopped = false;
  private attempt = 0;
  private lastFrameAt = 0;
  private lastError: BotErrorMessage | null = null;
  private readyInfo: BotReadyInfo | null = null;
  private waiters: ConnectWaiter[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(options: LobbyForgeBotOptions) {
    this.http = createBotHttp(options, 'v2');
    this.api = createMessageApi(this.http);
    this.token = options.token;
    this.WebSocketImpl =
      options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ?? undefined;
    this.configuredGatewayUrl = options.gatewayUrl;
    const reconnect = options.reconnect ?? true;
    this.reconnectEnabled = reconnect !== false;
    const r = typeof reconnect === 'object' ? reconnect : {};
    this.initialDelayMs = r.initialDelayMs && r.initialDelayMs > 0 ? r.initialDelayMs : 1_000;
    this.maxDelayMs = r.maxDelayMs && r.maxDelayMs > 0 ? r.maxDelayMs : 30_000;
    this.maxAttempts = r.maxAttempts && r.maxAttempts > 0 ? r.maxAttempts : Number.POSITIVE_INFINITY;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs && options.heartbeatTimeoutMs > 0
        ? options.heartbeatTimeoutMs
        : Math.round(BOT_HEARTBEAT_INTERVAL_MS * 2.5);
    this.random = options.random ?? Math.random;
  }

  // ── REST ────────────────────────────────────────────────────────────────

  /** Who this token belongs to. */
  getMe(): Promise<BotIdentity> {
    return this.api.getMe();
  }

  /** The channels the bot may use (§1.1). */
  listChannels(): Promise<BotChannel[]> {
    return this.api.listChannels();
  }

  /** Recent messages, newest first (`read_messages`). */
  readMessages(channelId: string, options?: ReadMessagesOptions): Promise<BotApiMessage[]> {
    return this.api.readMessages(channelId, options);
  }

  /** Post as the bot (`send_messages`). */
  sendMessage(channelId: string, content: string): Promise<BotApiMessage> {
    return this.api.sendMessage(channelId, content);
  }

  /** Slash commands (`slash_commands`). */
  readonly commands = {
    /** This bot's registered commands. */
    get: async (): Promise<BotCommand[]> => {
      const body = await this.http.request('GET', '/commands');
      return expectArray(body, 'commands') as BotCommand[];
    },
    /** Replace every command of this bot (bulk overwrite, ≤ 50). */
    set: async (commands: BotCommandDefinition[]): Promise<BotCommand[]> => {
      const valid = validateCommands(commands);
      const body = await this.http.request('PUT', '/commands', { commands: valid });
      return Array.isArray(body.commands) ? (body.commands as BotCommand[]) : [];
    },
    /** Remove one command. */
    delete: async (name: string): Promise<void> => {
      if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name)) {
        throw new BotValidationError('command name must match ^[a-z0-9_-]{1,32}$');
      }
      await this.http.request('DELETE', `/commands/${encodeURIComponent(name)}`);
    },
  };

  /** Interaction answers (`slash_commands`; a public answer also needs `send_messages`). */
  readonly interactions = {
    respond: async (id: string, content: string, options: AnswerOptions = {}): Promise<Record<string, unknown>> => {
      validateAnswer(id, content);
      return this.http.request('POST', `/interactions/${id}/respond`, { content, ephemeral: options.ephemeral === true });
    },
    followup: async (id: string, content: string, options: AnswerOptions = {}): Promise<Record<string, unknown>> => {
      validateAnswer(id, content);
      return this.http.request('POST', `/interactions/${id}/followup`, { content, ephemeral: options.ephemeral === true });
    },
  };

  /** Member lookups (`read_members`). */
  readonly members = {
    get: async (userId: string): Promise<BotMember> => {
      if (!isUuidLike(userId)) throw new BotValidationError('userId must be a UUID');
      const body = await this.http.request('GET', `/members/${userId}`);
      const member = body.member && typeof body.member === 'object' ? body.member : body;
      return member as BotMember;
    },
  };

  /** The outgoing event endpoint (`receive_events`). */
  readonly eventEndpoint = {
    /** The endpoint's status (URL, events, failures — never the secret), or null. */
    get: async (): Promise<BotEventEndpoint | null> => {
      const body = await this.http.request('GET', '/event-endpoint');
      return body.endpoint && typeof body.endpoint === 'object' ? (body.endpoint as BotEventEndpoint) : null;
    },
    /** Set (or replace) the HTTPS URL. The result's `secret` is shown ONCE. */
    set: async (url: string, options: { events?: string[] } = {}): Promise<EventEndpointResult> => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new BotValidationError('url must be an absolute https URL');
      }
      if (parsed.protocol !== 'https:') throw new BotValidationError('url must be an absolute https URL');
      const body = await this.http.request('PUT', '/event-endpoint', {
        url,
        ...(options.events ? { events: options.events } : {}),
      });
      return body as EventEndpointResult;
    },
    remove: async (): Promise<void> => {
      await this.http.request('DELETE', '/event-endpoint');
    },
  };

  /** `GET /api/bot/v2/gateway` → the event stream URL. */
  async getGatewayUrl(): Promise<string> {
    const body = await this.http.request('GET', '/gateway');
    if (typeof body.url !== 'string' || !body.url) {
      throw new BotNetworkError('The Bot API response has no "url"', 'invalid_response');
    }
    return this.normalizeGatewayUrl(body.url);
  }

  // ── events ──────────────────────────────────────────────────────────────

  /** Listen for an event; returns a function that stops listening. */
  on<K extends LobbyForgeBotEventName>(event: K, listener: LobbyForgeBotListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as LobbyForgeBotListener<never>);
    return () => this.off(event, listener);
  }

  off<K extends LobbyForgeBotEventName>(event: K, listener: LobbyForgeBotListener<K>): void {
    this.listeners.get(event)?.delete(listener as LobbyForgeBotListener<never>);
  }

  private emit<K extends LobbyForgeBotEventName>(event: K, payload: LobbyForgeBotEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      if (event === 'error') console.error('[lobbyforge-bot]', payload);
      return;
    }
    for (const listener of [...set]) {
      try {
        const result = (listener as LobbyForgeBotListener<K>)(payload);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err: unknown) => this.listenerFailed(event, err));
        }
      } catch (err) {
        this.listenerFailed(event, err);
      }
    }
  }

  private listenerFailed(event: LobbyForgeBotEventName, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (event === 'error') {
      console.error('[lobbyforge-bot] error listener failed:', error);
      return;
    }
    this.emit('error', error);
  }

  // ── connection ──────────────────────────────────────────────────────────

  /** The latest `ready` (bot + channels), or null before the first one. */
  get ready(): BotReadyInfo | null {
    return this.readyInfo;
  }

  /**
   * Open the event stream. Resolves on the first `ready`; keeps retrying
   * through network failures; rejects on a fatal close (bad token, disabled
   * bot, missing `receive_events`, replaced) or after `maxAttempts`.
   */
  connect(): Promise<void> {
    if (this.status === 'open' && this.socket) return Promise.resolve();
    this.stopped = false;
    const promise = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    // Already connecting, or a reconnect is scheduled: just wait for it.
    if ((this.status === 'idle' || this.status === 'closed') && !this.reconnectTimer) {
      this.attempt = 0;
      void this.open();
    }
    return promise;
  }

  /** Close the stream and stop reconnecting. */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    const wasActive = this.status !== 'idle' && this.status !== 'closed';
    this.status = 'closed';
    if (socket) {
      try {
        socket.close(BotCloseCode.NORMAL, 'client closing');
      } catch {
        /* already closed */
      }
    }
    this.rejectWaiters(new BotNetworkError('The bot was closed before it was ready', 'closed'));
    if (wasActive || socket) {
      this.emit('disconnect', { code: BotCloseCode.NORMAL, reason: 'client closing', willReconnect: false, delayMs: null });
    }
  }

  private normalizeGatewayUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw, this.http.baseUrl);
    } catch {
      throw new BotValidationError('gateway URL is not a valid URL');
    }
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
      throw new BotValidationError('gateway URL must be ws(s)://');
    }
    // Never downgrade: an https instance gets a wss stream.
    if (this.http.baseUrl.startsWith('https:') && url.protocol !== 'wss:') {
      throw new BotValidationError('gateway URL must use wss:// for an https instance');
    }
    if (url.username || url.password) throw new BotValidationError('gateway URL must not contain credentials');
    url.hash = '';
    return url.toString();
  }

  private async resolveGatewayUrl(): Promise<string> {
    if (this.gatewayUrl) return this.gatewayUrl;
    if (this.configuredGatewayUrl) {
      this.gatewayUrl = this.normalizeGatewayUrl(this.configuredGatewayUrl);
      return this.gatewayUrl;
    }
    try {
      this.gatewayUrl = await this.getGatewayUrl();
    } catch (err) {
      // An instance without the discovery route: the documented path.
      if (!(err instanceof BotNotFoundError)) throw err;
      this.gatewayUrl = this.normalizeGatewayUrl('/ws/bot');
    }
    return this.gatewayUrl;
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.status = 'connecting';
    this.lastError = null;
    let url: string;
    try {
      url = await this.resolveGatewayUrl();
    } catch (err) {
      if (err instanceof BotAuthError || err instanceof BotForbiddenError || err instanceof BotValidationError) {
        this.fail(err);
      } else {
        this.scheduleReconnect(0, err instanceof Error ? err.message : 'gateway discovery failed', false);
      }
      return;
    }
    if (this.stopped) return;
    const WebSocketImpl = this.WebSocketImpl;
    if (!WebSocketImpl) {
      this.fail(new BotValidationError('No WebSocket implementation available; pass one in options.WebSocket'));
      return;
    }
    let socket: WebSocketLike;
    try {
      socket = new WebSocketImpl(url);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      try {
        socket.send(JSON.stringify({ type: 'identify', token: this.token }));
      } catch {
        /* the close event follows */
      }
      this.startWatchdog(socket);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.onFrame(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.onClose(typeof event.code === 'number' ? event.code : 1006, typeof event.reason === 'string' ? event.reason : '');
    });
    socket.addEventListener('error', () => {
      /* a close event always follows */
    });
  }

  private onFrame(data: unknown): void {
    this.lastFrameAt = Date.now();
    const text = decodeFrame(data);
    if (text === null) return;
    let frame: { type?: unknown; data?: unknown } & Record<string, unknown>;
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'error') {
      this.lastError = frame as unknown as BotErrorMessage;
      return;
    }
    if (frame.type === 'event' && frame.data && typeof frame.data === 'object') {
      this.dispatch(frame.data as BotEventData);
    }
    // hello / heartbeat / pong: liveness only.
  }

  private dispatch(data: BotEventData): void {
    switch (data.event) {
      case 'ready': {
        this.status = 'open';
        this.attempt = 0;
        this.readyInfo = { bot: data.bot, channels: data.channels };
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) waiter.resolve();
        this.emit('ready', this.readyInfo);
        break;
      }
      case 'message_create':
        this.emit('message', data.message);
        break;
      case 'message_update':
        this.emit('message_update', data.message);
        break;
      case 'message_delete':
        this.emit('message_delete', { id: data.id, channelId: data.channelId });
        break;
      case 'member_join':
        this.emit('member_join', data.member);
        break;
      case 'member_leave':
        this.emit('member_leave', data.reason ? { ...data.member, reason: data.reason } : data.member);
        break;
      case 'interaction_create':
        this.emit('interaction', this.wrapInteraction(data.interaction));
        break;
      case 'channel_access_changed':
        if (this.readyInfo) this.readyInfo = { ...this.readyInfo, channels: data.channels };
        this.emit('channel_access_changed', data.channels);
        break;
      default:
        break;
    }
    this.emit('raw', data);
  }

  private wrapInteraction(interaction: BotFeedInteraction): BotInteraction {
    return {
      ...interaction,
      reply: (content, options) => this.interactions.respond(interaction.id, content, options),
      followup: (content, options) => this.interactions.followup(interaction.id, content, options),
    };
  }

  private onClose(code: number, reason: string): void {
    this.socket = null;
    this.clearTimers();
    this.status = 'closed';
    if (this.stopped) return;
    if (BOT_FATAL_CLOSE_CODES.includes(code)) {
      const error = closeError(code, reason, this.lastError);
      this.emit('disconnect', { code, reason, willReconnect: false, delayMs: null });
      this.fail(error);
      return;
    }
    this.scheduleReconnect(code, reason, code === BotCloseCode.RATE_LIMITED);
  }

  private scheduleReconnect(code: number, reason: string, rateLimited: boolean): void {
    this.status = 'closed';
    if (!this.reconnectEnabled || this.attempt >= this.maxAttempts) {
      this.emit('disconnect', { code, reason, willReconnect: false, delayMs: null });
      this.fail(new BotNetworkError(`The event stream closed (${code}${reason ? `: ${reason}` : ''}) and will not reconnect`, 'closed'));
      return;
    }
    const ceiling = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** this.attempt);
    this.attempt += 1;
    // "Equal jitter": half fixed, half random — never a thundering herd, never ~0.
    let delayMs = Math.round(ceiling / 2 + this.random() * (ceiling / 2));
    if (rateLimited) delayMs = Math.max(delayMs, RATE_LIMITED_MIN_DELAY_MS);
    this.emit('disconnect', { code, reason, willReconnect: true, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delayMs);
  }

  private startWatchdog(socket: WebSocketLike): void {
    if (this.watchdog) clearInterval(this.watchdog);
    const every = Math.max(1_000, Math.round(this.heartbeatTimeoutMs / 3));
    this.watchdog = setInterval(() => {
      if (this.socket !== socket) return;
      if (Date.now() - this.lastFrameAt <= this.heartbeatTimeoutMs) return;
      // Silent connection: drop it without waiting for a close handshake
      // a dead peer will never answer, and reconnect.
      this.socket = null;
      try {
        socket.close(4000, 'heartbeat timeout');
      } catch {
        /* ignore */
      }
      this.onClose(4000, 'heartbeat timeout');
    }, every);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private fail(error: Error): void {
    this.stopped = true;
    this.clearTimers();
    this.status = 'closed';
    const hadWaiters = this.waiters.length > 0;
    this.rejectWaiters(error);
    // A connect() caller already gets the rejection; otherwise surface it.
    if (!hadWaiters || this.listeners.get('error')?.size) this.emit('error', error);
  }
}
