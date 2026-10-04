/**
 * Bot connections on `/ws/bot` (Bot API v2 §4).
 *
 *   1. Authenticate: `Authorization: Bot <token>` on the upgrade, or a
 *      first `{ type: 'identify', token }` message within 5 s. The token is
 *      checked like the REST API does (hash lookup in constant time, custom
 *      bot, server alive), then: bot enabled, `receive_events` held.
 *   2. One connection per bot: a newer one closes the older with 4009.
 *   3. Feed: the bot does not choose topics. The gateway computes its
 *      channel set (§1.1), subscribes to those chat topics and to
 *      `lf:{env}:bot-events:{botId}` on the ONE shared Redis subscriber,
 *      and forwards translated events — each checked against the bot's
 *      permissions (and, for messages and interactions, its channel
 *      access) at send time.
 *   4. Freshness: a `{ kind: 'bot-access', botId }` invalidation (and a
 *      channel/server policy change in its server) recomputes the bot and
 *      its channels; so does a periodic sweep, in case Pub/Sub lost the
 *      event. A rotated/revoked token, a disabled bot or a lost
 *      `receive_events` closes the socket.
 *
 * Close codes are in `bot-protocol.ts` (`BotCloseCode`).
 */
import type { WebSocket } from 'ws';
import type * as http from 'node:http';
import type { AccessInvalidationEvent } from './access-invalidation.js';
import { isUuid } from './authorize.js';
import {
  BOT_EVENT_PERMISSIONS,
  BOT_IDENTIFY_TIMEOUT_MS,
  BotCloseCode,
  BotClientMessageSchema,
  BotIdentifyMessageSchema,
  botEventsChannel,
  type BotErrorCode,
  type BotEventData,
  type BotEventName,
  type BotFeedChannel,
  type BotServerMessage,
} from './protocol.js';
import { acquireRedisChannel, acquireTopicSubscription, envPrefix } from './redis-subscriber.js';
import { botReachesChannel, listBotFeedChannels, loadBot, loadFeedMessage, type GatewayBot } from './bot-store.js';
import { ABSENT_BOT_HASH, parseBotToken, readBotAuthorization, verifyBotToken } from './bot-token.js';

const CUSTOM_BOT_TYPE = 'custom';
const RECEIVE_EVENTS = 'receive_events';
/** Events another process may push on `bot-events:{botId}`; the rest are gateway-made. */
const FORWARDED_BOT_EVENTS = new Set<BotEventName>(['member_join', 'member_leave', 'interaction_create']);
/** Missed pings after which a bot socket is terminated (§4.1: "misses two"). */
const MAX_MISSED_PINGS = 2;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface BotGatewayOptions {
  /** Read the database (defaults to the gateway's `getDb`). */
  getDb: () => unknown;
  identifyTimeoutMs?: number;
  /** Failed identifies per client address per window before 4029. */
  authFailMax?: number;
  authFailWindowMs?: number;
  /** Successful connects per bot per window before 4029. */
  connectMax?: number;
  connectWindowMs?: number;
  /** Messages a ready bot may send per window (pings) before 4029. */
  inboundMax?: number;
  inboundWindowMs?: number;
  /** Most channels one bot hears. */
  maxChannels?: number;
  /** Events waiting for a database read per connection before new ones are dropped. */
  maxPendingEvents?: number;
}

/** `/ws/bot` (query string ignored). */
export function isBotGatewayPath(url: string | undefined): boolean {
  if (!url) return false;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  return path === '/ws/bot' || path === '/ws/bot/';
}

/** In-memory sliding-window counter (per gateway process). */
class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  private live(key: string, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    while (list.length && list[0]! <= cutoff) list.shift();
    if (list.length === 0) this.hits.delete(key);
    return list;
  }

  isLimited(key: string): boolean {
    return this.live(key, Date.now()).length >= this.max;
  }

  record(key: string): void {
    const now = Date.now();
    const list = this.live(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  prune(): void {
    const now = Date.now();
    for (const key of [...this.hits.keys()]) this.live(key, now);
  }

  clear(): void {
    this.hits.clear();
  }
}

interface ChannelSubscription {
  channel: BotFeedChannel;
  release: () => void;
}

interface BotConnection {
  socket: WebSocket;
  ip: string;
  bot: GatewayBot;
  /** The token hash this socket authenticated with — a rotation/revoke closes it. */
  tokenHash: string;
  channels: Map<string, ChannelSubscription>;
  /** The channel list the bot was last told about (ready / channel_access_changed). */
  announced: string;
  botEvents: { release: () => void } | null;
  missedPings: number;
  inbound: SlidingWindow;
  queue: Promise<void>;
  pending: number;
  refreshChain: Promise<void>;
  closed: boolean;
}

type RefreshReason = 'bot-access' | 'policy' | 'periodic';

export interface BotGateway {
  handleConnection(socket: WebSocket, req: http.IncomingMessage, ip: string, releaseSlot: () => void): void;
  onInvalidation(event: AccessInvalidationEvent): void;
  /** Every heartbeat interval: ping, terminate silent bots, prune limiters. */
  heartbeat(): void;
  /** Periodic re-validation of every live bot (lost invalidations). */
  refreshAll(): Promise<void>;
  close(): void;
  /** Test/introspection. */
  stats(): { connections: number; channels: Record<string, string[]> };
}

function channelsKey(channels: BotFeedChannel[]): string {
  return JSON.stringify(channels.map((c) => [c.id, c.name]));
}

function send(socket: WebSocket, msg: BotServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch (err) {
    console.warn(`[ws-gateway] bot send failed: ${(err as Error).message}`);
  }
}

/** Send an error frame, then close with `code`. */
function refuse(
  socket: WebSocket,
  code: number,
  error: BotErrorCode,
  message: string,
  extra: { permission?: string } = {}
): void {
  send(socket, { type: 'error', code: error, message, ...extra });
  try {
    socket.close(code, error);
  } catch {
    /* already closed */
  }
}

export function createBotGateway(options: BotGatewayOptions): BotGateway {
  const identifyTimeoutMs = options.identifyTimeoutMs ?? envInt('WS_BOT_IDENTIFY_TIMEOUT_MS', BOT_IDENTIFY_TIMEOUT_MS);
  const authFailures = new SlidingWindow(
    options.authFailMax ?? envInt('WS_BOT_AUTH_FAIL_MAX', 30),
    options.authFailWindowMs ?? 60_000
  );
  const connects = new SlidingWindow(
    options.connectMax ?? envInt('WS_BOT_CONNECT_MAX', 30),
    options.connectWindowMs ?? 60_000
  );
  const inboundMax = options.inboundMax ?? envInt('WS_BOT_INBOUND_MAX', 60);
  const inboundWindowMs = options.inboundWindowMs ?? 60_000;
  const maxChannels = options.maxChannels ?? envInt('WS_BOT_MAX_CHANNELS', 500);
  const maxPendingEvents = options.maxPendingEvents ?? envInt('WS_BOT_MAX_PENDING_EVENTS', 500);

  const byBot = new Map<string, BotConnection>();

  function emit(conn: BotConnection, data: BotEventData): void {
    if (conn.closed) return;
    send(conn.socket, { type: 'event', topic: 'bot', data, at: new Date().toISOString() });
  }

  /** Permission (and channel access) check, run again after every await. */
  function mayReceive(conn: BotConnection, event: BotEventName, channelId?: string): boolean {
    if (conn.closed) return false;
    const permission = BOT_EVENT_PERMISSIONS[event];
    if (permission && !conn.bot.permissions.includes(permission)) return false;
    if (channelId !== undefined && !conn.channels.has(channelId)) return false;
    return true;
  }

  /** Per-connection FIFO: events reach the bot in bus order even when a DB read is slow. */
  function enqueue(conn: BotConnection, task: () => Promise<void>): void {
    if (conn.closed) return;
    if (conn.pending >= maxPendingEvents) {
      console.warn(`[ws-gateway] bot ${conn.bot.id}: event backlog full, dropping an event`);
      return;
    }
    conn.pending += 1;
    conn.queue = conn.queue
      .then(task)
      .catch((err: unknown) => {
        console.warn(`[ws-gateway] bot ${conn.bot.id}: event failed: ${(err as Error)?.message ?? String(err)}`);
      })
      .then(() => {
        conn.pending -= 1;
      });
  }

  async function handleChat(conn: BotConnection, channelId: string, raw: string): Promise<void> {
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      envelope = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = envelope.type;
    if (type === 'message' || type === 'message_update') {
      const event: BotEventName = type === 'message' ? 'message_create' : 'message_update';
      const payload = (envelope.message ?? null) as Record<string, unknown> | null;
      const id = payload?.id;
      if (typeof id !== 'string' || !isUuid(id)) return;
      // Never the bot's own messages (cheap check before any read).
      if (payload?.botId === conn.bot.id) return;
      if (!mayReceive(conn, event, channelId)) return;
      const at = typeof envelope.at === 'string' ? envelope.at : '';
      const loaded = await loadFeedMessage(options.getDb(), id, channelId, `${type}:${at}`);
      if (!loaded || loaded.botId === conn.bot.id) return;
      // Access may have changed while the message loaded.
      if (!mayReceive(conn, event, channelId)) return;
      emit(conn, { event, message: loaded.message } as BotEventData);
      return;
    }
    if (type === 'message_delete') {
      const nested = (envelope.message ?? null) as Record<string, unknown> | null;
      const id = envelope.id ?? envelope.messageId ?? nested?.id;
      if (typeof id !== 'string' || !isUuid(id)) return;
      if ((envelope.botId ?? nested?.botId) === conn.bot.id) return;
      if (!mayReceive(conn, 'message_delete', channelId)) return;
      // The channel is the topic's, never the publisher's claim.
      emit(conn, { event: 'message_delete', id, channelId });
    }
  }

  async function handleBotEvent(conn: BotConnection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    let data = parsed as Record<string, unknown> | null;
    // Accept the bare §4.2 `data` payload, or one wrapped in `{ data }`.
    if (data && typeof data === 'object' && typeof data.event !== 'string' && data.data && typeof data.data === 'object') {
      data = data.data as Record<string, unknown>;
    }
    if (!data || typeof data !== 'object' || typeof data.event !== 'string') return;
    const event = data.event as BotEventName;
    if (!FORWARDED_BOT_EVENTS.has(event)) return;
    if (!mayReceive(conn, event)) return;
    if (event === 'interaction_create' && !(await interactionChannelAllowed(conn, data))) return;
    emit(conn, data as unknown as BotEventData);
  }

  /**
   * An interaction is about one channel: the bot must still reach it (§1.1)
   * when it is forwarded — the invoke route checked at run time, but access
   * may have changed since (same rule as the endpoint path). The live
   * channel set answers for free; only a channel beyond a capped set costs
   * a database read. Unknown / malformed channel → dropped.
   */
  async function interactionChannelAllowed(conn: BotConnection, data: Record<string, unknown>): Promise<boolean> {
    const interaction = data.interaction as Record<string, unknown> | null | undefined;
    const channelId = interaction && typeof interaction === 'object' ? interaction.channelId : undefined;
    if (typeof channelId !== 'string' || !isUuid(channelId)) return false;
    if (conn.channels.has(channelId)) return true;
    // A set below the cap is complete: not in it = not reachable (also
    // after a fail-closed refresh emptied it).
    if (conn.channels.size < maxChannels) return false;
    try {
      const reachable = await botReachesChannel(options.getDb(), conn.bot, channelId);
      return reachable && mayReceive(conn, 'interaction_create');
    } catch {
      return false;
    }
  }

  function releaseChannels(conn: BotConnection): void {
    for (const entry of conn.channels.values()) {
      try {
        entry.release();
      } catch {
        /* best effort */
      }
    }
    conn.channels.clear();
  }

  function applyChannels(conn: BotConnection, channels: BotFeedChannel[]): void {
    if (conn.closed) return;
    const next = new Map(channels.map((c) => [c.id, c]));
    for (const [id, entry] of conn.channels) {
      if (!next.has(id)) {
        conn.channels.delete(id);
        entry.release();
      }
    }
    for (const [id, channel] of next) {
      const existing = conn.channels.get(id);
      if (existing) {
        existing.channel = channel;
        continue;
      }
      const handle = acquireTopicSubscription(`chat:${conn.bot.serverId}:${id}`, (raw) =>
        enqueue(conn, () => handleChat(conn, id, raw))
      );
      conn.channels.set(id, { channel, release: handle.release });
    }
  }

  function teardown(conn: BotConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    releaseChannels(conn);
    conn.botEvents?.release();
    conn.botEvents = null;
    if (byBot.get(conn.bot.id) === conn) byBot.delete(conn.bot.id);
  }

  function closeConnection(conn: BotConnection, code: number, error: BotErrorCode, message: string, extra = {}): void {
    teardown(conn);
    refuse(conn.socket, code, error, message, extra);
  }

  /** Bot row checks shared by the handshake and every refresh; null = allowed. */
  function denial(bot: GatewayBot): { code: number; error: BotErrorCode; message: string; permission?: string } | null {
    if (!bot.enabled) return { code: BotCloseCode.FORBIDDEN, error: 'bot_disabled', message: 'This bot is disabled' };
    if (!bot.permissions.includes(RECEIVE_EVENTS)) {
      return {
        code: BotCloseCode.FORBIDDEN,
        error: 'missing_permission',
        message: 'The bot lacks the receive_events permission',
        permission: RECEIVE_EVENTS,
      };
    }
    return null;
  }

  async function doRefresh(conn: BotConnection, reason: RefreshReason): Promise<void> {
    if (conn.closed) return;
    const failClosed = () => {
      // A security-relevant change we could not evaluate: stop message
      // events until a later refresh succeeds (the periodic sweep retries).
      if (reason !== 'periodic') releaseChannels(conn);
    };
    let bot: GatewayBot | null;
    try {
      bot = await loadBot(options.getDb(), conn.bot.id);
    } catch {
      failClosed();
      return;
    }
    if (conn.closed) return;
    if (!bot || bot.type !== CUSTOM_BOT_TYPE || !bot.tokenHash || bot.tokenHash !== conn.tokenHash) {
      closeConnection(conn, BotCloseCode.UNAUTHORIZED, 'unauthorized', 'The bot token was revoked or rotated');
      return;
    }
    const denied = denial(bot);
    if (denied) {
      closeConnection(conn, denied.code, denied.error, denied.message, denied.permission ? { permission: denied.permission } : {});
      return;
    }
    conn.bot = bot;
    let channels: BotFeedChannel[];
    try {
      channels = await listBotFeedChannels(options.getDb(), bot, maxChannels);
    } catch {
      failClosed();
      return;
    }
    if (conn.closed) return;
    applyChannels(conn, channels);
    const key = channelsKey(channels);
    if (reason === 'bot-access' || key !== conn.announced) {
      conn.announced = key;
      emit(conn, { event: 'channel_access_changed', channels });
    }
  }

  function refresh(conn: BotConnection, reason: RefreshReason): Promise<void> {
    conn.refreshChain = conn.refreshChain.then(() => doRefresh(conn, reason)).catch((err: unknown) => {
      console.warn(`[ws-gateway] bot ${conn.bot.id}: refresh failed: ${(err as Error)?.message ?? String(err)}`);
    });
    return conn.refreshChain;
  }

  function handleConnection(socket: WebSocket, req: http.IncomingMessage, ip: string, releaseSlot: () => void): void {
    let phase: 'identify' | 'authenticating' | 'ready' | 'closed' = 'identify';
    let conn: BotConnection | null = null;
    let identifyTimer: ReturnType<typeof setTimeout> | null = null;

    const onGone = () => {
      phase = 'closed';
      if (identifyTimer) clearTimeout(identifyTimer);
      identifyTimer = null;
      if (conn) teardown(conn);
      releaseSlot();
    };
    socket.once('close', onGone);
    socket.once('error', onGone);

    const failAuth = (message: string) => {
      authFailures.record(ip);
      phase = 'closed';
      refuse(socket, BotCloseCode.UNAUTHORIZED, 'unauthorized', message);
    };

    if (authFailures.isLimited(ip)) {
      phase = 'closed';
      refuse(socket, BotCloseCode.RATE_LIMITED, 'rate_limited', 'Too many failed attempts; try again later');
      return;
    }

    const authenticate = async (token: string | null): Promise<void> => {
      phase = 'authenticating';
      if (identifyTimer) clearTimeout(identifyTimer);
      identifyTimer = null;
      const claimed = token ? parseBotToken(token) : null;
      if (!token || !claimed) {
        failAuth('Invalid bot token');
        return;
      }
      let bot: GatewayBot | null;
      try {
        bot = await loadBot(options.getDb(), claimed.botId);
      } catch (err) {
        console.warn(`[ws-gateway] bot auth lookup failed: ${(err as Error)?.message ?? String(err)}`);
        phase = 'closed';
        refuse(socket, BotCloseCode.INTERNAL_ERROR, 'internal_error', 'Authentication is unavailable; try again');
        return;
      }
      if ((phase as string) === 'closed') return;
      const matches = verifyBotToken(token, bot?.tokenHash ?? ABSENT_BOT_HASH);
      if (!bot || !matches || !bot.tokenHash || bot.type !== CUSTOM_BOT_TYPE) {
        failAuth('Invalid bot token');
        return;
      }
      const denied = denial(bot);
      if (denied) {
        phase = 'closed';
        refuse(socket, denied.code, denied.error, denied.message, denied.permission ? { permission: denied.permission } : {});
        return;
      }
      if (connects.isLimited(bot.id)) {
        phase = 'closed';
        refuse(socket, BotCloseCode.RATE_LIMITED, 'rate_limited', 'Too many connections for this bot; back off');
        return;
      }
      connects.record(bot.id);

      let channels: BotFeedChannel[];
      try {
        channels = await listBotFeedChannels(options.getDb(), bot, maxChannels);
      } catch (err) {
        console.warn(`[ws-gateway] bot channel lookup failed: ${(err as Error)?.message ?? String(err)}`);
        phase = 'closed';
        refuse(socket, BotCloseCode.INTERNAL_ERROR, 'internal_error', 'The event stream is unavailable; try again');
        return;
      }
      if ((phase as string) === 'closed' || socket.readyState !== socket.OPEN) return;

      // One connection per bot: the newest wins.
      const previous = byBot.get(bot.id);
      if (previous) {
        closeConnection(previous, BotCloseCode.REPLACED, 'replaced', 'Replaced by a newer connection for this bot');
      }

      const created: BotConnection = {
        socket,
        ip,
        bot,
        tokenHash: bot.tokenHash,
        channels: new Map(),
        announced: channelsKey(channels),
        botEvents: null,
        missedPings: 0,
        inbound: new SlidingWindow(inboundMax, inboundWindowMs),
        queue: Promise.resolve(),
        pending: 0,
        refreshChain: Promise.resolve(),
        closed: false,
      };
      conn = created;
      byBot.set(bot.id, created);
      applyChannels(created, channels);
      created.botEvents = acquireRedisChannel(botEventsChannel(envPrefix(), bot.id), (raw) =>
        enqueue(created, () => handleBotEvent(created, raw))
      );
      phase = 'ready';
      const at = new Date().toISOString();
      send(socket, { type: 'hello', ok: true, bot: { id: bot.id, serverId: bot.serverId }, at });
      emit(created, {
        event: 'ready',
        bot: { id: bot.id, name: bot.name, serverId: bot.serverId, permissions: [...bot.permissions] },
        channels,
      });
      console.info(`[ws-gateway] bot ${bot.id} connected (${channels.length} channels)`);
    };

    socket.on('pong', () => {
      if (conn) conn.missedPings = 0;
    });

    socket.on('message', (data: unknown) => {
      if (phase === 'closed' || phase === 'authenticating') return;
      let parsed: unknown;
      try {
        const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      if (phase === 'identify') {
        const identify = BotIdentifyMessageSchema.safeParse(parsed);
        if (!identify.success) {
          failAuth('The first message must be { "type": "identify", "token": "…" }');
          return;
        }
        void authenticate(identify.data.token);
        return;
      }

      // phase === 'ready'
      if (!conn) return;
      if (conn.inbound.isLimited('in')) {
        closeConnection(conn, BotCloseCode.RATE_LIMITED, 'rate_limited', 'Too many messages');
        return;
      }
      conn.inbound.record('in');
      const msg = BotClientMessageSchema.safeParse(parsed);
      if (msg.success && msg.data.type === 'ping') {
        conn.missedPings = 0;
        send(socket, { type: 'pong', at: new Date().toISOString() });
        return;
      }
      send(socket, {
        type: 'error',
        code: 'bad_message',
        message: msg.success ? 'Already identified' : 'Bots only send { "type": "ping" } after identifying',
      });
    });

    const headerPresent = req.headers.authorization !== undefined;
    if (headerPresent) {
      // A header was sent: it alone decides (a malformed one fails).
      void authenticate(readBotAuthorization(req.headers.authorization));
      return;
    }
    identifyTimer = setTimeout(() => {
      identifyTimer = null;
      if (phase === 'identify') failAuth('No identify message within the time limit');
    }, identifyTimeoutMs);
  }

  return {
    handleConnection,

    onInvalidation(event) {
      if (event.kind === 'bot-access') {
        if (!event.botId) return;
        const conn = byBot.get(event.botId);
        if (conn) void refresh(conn, 'bot-access');
        return;
      }
      if (event.kind === 'channel-policy' || event.kind === 'server-policy') {
        for (const conn of byBot.values()) {
          if (conn.bot.serverId === event.serverId) void refresh(conn, 'policy');
        }
      }
    },

    heartbeat() {
      for (const conn of [...byBot.values()]) {
        if (conn.missedPings >= MAX_MISSED_PINGS) {
          teardown(conn);
          try {
            conn.socket.terminate();
          } catch {
            /* already gone */
          }
          continue;
        }
        conn.missedPings += 1;
        try {
          conn.socket.ping();
        } catch {
          /* swallow */
        }
        // The standard WebSocket API hides protocol pings — this frame
        // lets SDKs on it notice a dead connection.
        send(conn.socket, { type: 'heartbeat', at: new Date().toISOString() });
      }
      authFailures.prune();
      connects.prune();
    },

    async refreshAll() {
      await Promise.all([...byBot.values()].map((conn) => refresh(conn, 'periodic')));
    },

    close() {
      for (const conn of [...byBot.values()]) teardown(conn);
      authFailures.clear();
      connects.clear();
    },

    stats() {
      const channels: Record<string, string[]> = {};
      for (const [id, conn] of byBot) channels[id] = [...conn.channels.keys()];
      return { connections: byBot.size, channels };
    },
  };
}
